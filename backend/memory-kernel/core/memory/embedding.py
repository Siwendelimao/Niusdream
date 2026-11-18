"""NIS Memory System — Embedding Providers (Phase 5)"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from typing import Optional

import numpy as np

from core.memory.models import EmbeddingProvider


# ── 字符 n-gram 分词 ──────────────────────────────────


def _char_ngrams(text: str, n: int = 2) -> list[str]:
    """生成字符级 n-grams"""
    if len(text) < n:
        return [text] if text else []
    return [text[i:i + n] for i in range(len(text) - n + 1)]


def _tokenize(text: str) -> list[str]:
    """混合分词：英文按空格，中文按字符 bigram"""
    text = text.lower().strip()
    tokens = []
    # 英文/数字词
    en_tokens = re.findall(r'[a-z0-9]+', text)
    tokens.extend(en_tokens)
    # 中文 bigrams
    chinese_chars = re.findall(r'[\u4e00-\u9fff]', text)
    if len(chinese_chars) >= 2:
        for i in range(len(chinese_chars) - 1):
            tokens.append(chinese_chars[i] + chinese_chars[i + 1])
    elif chinese_chars:
        tokens.append(chinese_chars[0])
    return tokens


def _hash_token(token: str, dimensions: int) -> int:
    """将 token 哈希到 [0, dimensions) 范围"""
    h = hashlib.md5(token.encode('utf-8')).hexdigest()
    return int(h, 16) % dimensions


# ── 1. Hashing Embedder（零依赖，默认使用） ──────────────


class HashingEmbedder(EmbeddingProvider):
    """基于特征哈希的 Embedding 生成器（零依赖）

    使用字符 n-gram + 特征哈希生成固定维度向量。
    适合万级以下规模，无需预训练模型。
    """

    def __init__(self, dimensions: int = 256, ngram_range: tuple = (1, 2)) -> None:
        self._dimensions = dimensions
        self._ngram_range = ngram_range
        self._vocab: dict[str, float] = {}
        self._idf: dict[str, float] = {}

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_name(self) -> str:
        return f"hashing_{self._dimensions}d"

    def _text_to_tokens(self, text: str) -> list[str]:
        """文本转换为 n-gram tokens"""
        all_tokens = []
        text_lower = text.lower().strip()
        for n in range(self._ngram_range[0], self._ngram_range[1] + 1):
            all_tokens.extend(_char_ngrams(text_lower, n))
        # 加入英文词
        en_tokens = re.findall(r'[a-z0-9]+', text_lower)
        all_tokens.extend(en_tokens)
        return all_tokens

    def _compute_idf(self, texts: list[str]) -> None:
        """计算 IDF（基于提供的文本集合）"""
        doc_count = len(texts)
        token_doc_freq: Counter = Counter()
        for text in texts:
            tokens = set(self._text_to_tokens(text))
            for token in tokens:
                token_doc_freq[token] += 1
        self._idf = {
            token: math.log((doc_count + 1) / (freq + 1)) + 1
            for token, freq in token_doc_freq.items()
        }

    def fit(self, texts: list[str]) -> None:
        """基于文本集合计算 IDF（可选，提高质量）"""
        self._compute_idf(texts)

    def embed(self, text: str) -> list[float]:
        """将单条文本转换为向量"""
        tokens = self._text_to_tokens(text)
        if not tokens:
            return [0.0] * self._dimensions

        vec = np.zeros(self._dimensions, dtype=np.float32)
        token_counts = Counter(tokens)
        total = len(tokens)

        for token, count in token_counts.items():
            idx = _hash_token(token, self._dimensions)
            tf = count / total
            idf = self._idf.get(token, 1.0)
            vec[idx] += tf * idf

        # L2 归一化
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm

        return vec.tolist()

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """批量转换"""
        if not self._idf:
            self._compute_idf(texts)
        return [self.embed(t) for t in texts]


# ── 2. Sentence Transformer Embedder（可选） ──────────────


def _model_cached(model_name: str) -> bool:
    """检查模型是否已在 HF 本地缓存（避免每次启动走网络）。

    HF 缓存目录名 = `models--<org>--<name>`；`all-MiniLM-L6-v2` 实际是
    `sentence-transformers/all-MiniLM-L6-v2`，两种写法都查。
    """
    import os
    cache_dir = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    hub_dir = os.path.join(cache_dir, "hub")
    if not os.path.isdir(hub_dir):
        return False
    candidates = [
        "models--" + model_name.replace("/", "--"),
        "models--sentence-transformers--" + model_name.replace("/", "--"),
    ]
    for c in candidates:
        if os.path.isdir(os.path.join(hub_dir, c)):
            return True
    return False


class SentenceTransformerEmbedder(EmbeddingProvider):
    """基于 sentence-transformers 的 Embedding 生成器

    需要: pip install sentence-transformers + 模型已下载（HF 缓存）或可联网下载。
    离线快速失败：`local_files_only=True` —— 本地无缓存立即抛错（不重试网络），
    由调用方 try/except 降级 FTS，避免启动卡在 HuggingFace 超时重试。
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise ImportError(
                "sentence-transformers not installed. "
                "Run: pip install sentence-transformers"
            )
        import os as _os
        # 已缓存 → 秒加载；未缓存 → 先试镜像下载（hf-mirror.com 国内可达），再试官方
        cached = _model_cached(model_name)
        endpoints = []
        if cached:
            endpoints.append(None)  # 本地直接加载
        else:
            endpoints.append("https://hf-mirror.com")  # 国内镜像优先
            endpoints.append("https://huggingface.co")  # 官方兜底
        last_err = None
        for ep in endpoints:
            try:
                if ep:
                    _os.environ["HF_ENDPOINT"] = ep
                self._model = SentenceTransformer(model_name, local_files_only=cached)
                break
            except Exception as e:
                last_err = e
                continue
        else:
            raise RuntimeError(
                f"Embedding 模型 {model_name} 加载失败（本地无缓存且网络不可达）：{str(last_err)[:120]}"
            )
        self._model_name = model_name
        try:
            self._dimensions = self._model.get_sentence_embedding_dimension()
        except Exception:
            self._dimensions = self._model.get_embedding_dimension()

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_name(self) -> str:
        return f"st_{self._model_name}"

    def embed(self, text: str) -> list[float]:
        return self._model.encode([text], show_progress_bar=False)[0].tolist()

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        embeddings = self._model.encode(texts, show_progress_bar=False)
        return [e.tolist() for e in embeddings]


# ── 3. OpenAI Embedder（可选） ──────────────────────────


class OpenAIEmbedder(EmbeddingProvider):
    """基于 OpenAI API 的 Embedding 生成器

    需要: OPENAI_API_KEY 环境变量
    """

    def __init__(self, model: str = "text-embedding-3-small",
                 api_key: str = None) -> None:
        try:
            import openai
        except ImportError:
            raise ImportError("openai not installed. Run: pip install openai")
        import os
        self._client = openai.OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))
        self._model = model
        self._dims = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072,
                      "text-embedding-ada-002": 1536}

    @property
    def dimensions(self) -> int:
        return self._dims.get(self._model, 1536)

    @property
    def model_name(self) -> str:
        return f"openai_{self._model}"

    def embed(self, text: str) -> list[float]:
        response = self._client.embeddings.create(model=self._model, input=text)
        return response.data[0].embedding

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        response = self._client.embeddings.create(model=self._model, input=texts)
        return [d.embedding for d in sorted(response.data, key=lambda x: x.index)]


# ── 工厂函数 ──────────────────────────────────────────


def create_embedder(
    backend: str = "hashing",
    dimensions: int = 256,
    **kwargs,
) -> EmbeddingProvider:
    """创建 EmbeddingProvider 实例

    Args:
        backend: "hashing" | "sentence_transformer" | "openai"
        dimensions: 向量维度（仅 hashing 后端使用）
    """
    if backend == "hashing":
        return HashingEmbedder(dimensions=dimensions)
    elif backend in ("sentence_transformer", "st"):
        model = kwargs.get("model", "all-MiniLM-L6-v2")
        return SentenceTransformerEmbedder(model_name=model)
    elif backend == "openai":
        return OpenAIEmbedder(
            model=kwargs.get("model", "text-embedding-3-small"),
            api_key=kwargs.get("api_key"),
        )
    else:
        raise ValueError(f"Unknown embedding backend: {backend}")

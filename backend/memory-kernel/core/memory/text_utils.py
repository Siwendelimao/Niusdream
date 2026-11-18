"""记忆文本工具：短标题生成 + 内容相似度（供 memory_add / distill / global_memory 统一查重）。"""

from __future__ import annotations

import re


# 记忆标题里去掉的常见废话前缀/后缀（中英文 + 口语化）
_TITLE_NOISE_PREFIX = re.compile(
    r"^(用户|我|我们|请你|请|帮我|记得|记住|记住吧|以后|平时|个人)?"
    r"(的|的偏好|偏好|喜欢|不喜欢|习惯|不习惯|更|比较|希望|想|倾向|偏好于|习惯用|用|开发|做|写|使用|不要|不用|不用再|别|避免|讨厌|介意|不想)"
)
_TITLE_NOISE_SUFFIX = re.compile(r"(这条|这个|吧|了|哦|嗯|哈|～|~|！|!|。|。?|，|,|的)$")

# 标点/空白归一（相似度用）
_WS = re.compile(r"[\s\u3000]+")
_PUNCT = re.compile(r"[，。、；：！？,.;:!?\"'“”‘’（）()\[\]【】<>《》\-—_/\\|]+")

# 中文断句点（标题截断时在此处断，避免切碎词）
_BREAK = re.compile(r"[，。；、！？,.;:!?]")


def short_title(content: str, max_len: int = 20) -> str:
    """从内容生成简短标题（利于检索），去掉口语废话前缀，取主体。"""
    s = str(content or "").strip()
    if not s:
        return "记忆"
    # 去掉前缀废话（可循环剥一次）："我开发前端时不喜欢 emoji" → "开发前端时不喜欢 emoji"
    prev = None
    while prev != s:
        prev = s
        m = _TITLE_NOISE_PREFIX.match(s)
        if m:
            s = s[m.end():].lstrip(" ，,、")
    s = _TITLE_NOISE_SUFFIX.sub("", s).strip()
    # 保底：去掉前缀后仍太长 → 截断到首个断句（保留最多 max_len 字符）
    if len(s) > max_len:
        seg = _BREAK.split(s, maxsplit=1)[0].strip()
        if seg and len(seg) >= 4:
            s = seg
    s = s[:max_len].strip(" ，,、")
    return s or "记忆"


def normalize_text(text: str) -> str:
    """归一化：小写 + 去标点/空白，用于相似度比较。"""
    s = str(text or "").lower()
    s = _WS.sub("", s)
    s = _PUNCT.sub("", s)
    return s.strip()


def text_similarity(a: str, b: str) -> float:
    """文本相似度：LCS 长度占比 与 关键 token 命中 取较高者，适合中文短文本"同义不同措辞"查重。0~1。"""
    na = normalize_text(a)
    nb = normalize_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    lcs = _lcs_len(na, nb)
    lcs_score = lcs / max(len(na), len(nb))

    # 关键 token（英文/数字词 + 中文 2 字 gram）交集 → 覆盖"措辞差异大但核心词相同"的场景
    ta, tb = _key_tokens(na), _key_tokens(nb)
    token_score = 0.0
    if ta and tb:
        inter = len(ta & tb)
        # 有共享显著英文/数字词（≥3 字符，如 emoji/typescript/vue 框架名）且 LCS 有一定重合 → 强信号
        # （dedup 调用处均按 memory_type 过滤，故跨类型"Vue是框架"vs"用Vue开发"不会误合并）
        shared_en = {w for w in (ta & tb) if re.fullmatch(r"[a-z0-9]{3,}", w)}
        if shared_en and lcs_score >= 0.15:
            token_score = 0.82
        elif inter >= 1:
            token_score = min(1.0, (inter / min(len(ta), len(tb))) * 0.55)

    return max(lcs_score, token_score)


# 中文 2 字 gram + 英文/数字词
def _key_tokens(s: str) -> set:
    out = set()
    out.update(re.findall(r"[a-z0-9]+", s))
    for i in range(max(0, len(s) - 1)):
        two = s[i:i + 2]
        if all("\u4e00" <= ch <= "\u9fff" for ch in two):
            out.add(two)
    return out


def _lcs_len(a: str, b: str) -> int:
    """最长公共子序列长度（DP，O(n*m)），短文本够用。"""
    if not a or not b:
        return 0
    n, m = len(a), len(b)
    # 压缩空间：只保留两行
    prev = [0] * (m + 1)
    for i in range(1, n + 1):
        cur = [0] * (m + 1)
        for j in range(1, m + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                cur[j] = max(prev[j], cur[j - 1])
        prev = cur
    return prev[m]


def is_duplicate(a: str, b: str, threshold: float = 0.85) -> bool:
    # ★0927 netfix：阈值 0.45→0.85 —— text_similarity 对"共享常用词"的分数虚高（实测 0.82），
    # 低阈值把不相干的新记忆误判重复 → 被 upsert 静默丢弃；收紧到只认近乎同文。
    """是否可视为同一条记忆（归一化相等 或 LCS 相似度 ≥ 阈值）。"""
    if not a or not b:
        return False
    na, nb = normalize_text(a), normalize_text(b)
    if na == nb:
        return True
    return text_similarity(a, b) >= threshold


# 否定词（用于矛盾检测：同一主题一边否定一边肯定 → 判定"用户改口"）
# 只匹配稳定否定组合，避免"特别/非常/无论"等误伤。
_NEG_RE = re.compile(
    r"(不喜欢|不想要|不需要|不想|不要|不用|不使用|不采用|不再|不是|不能|不会|"
    r"没有|没|避免|拒绝|取消|放弃|讨厌|反对|禁止|无法|未|"
    r"no|not|never|avoid|without|dislike|hate|dont|don't|cannot|can't|"
    r"won't|refuse|reject)"
)


def _has_negation(text: str) -> bool:
    """是否含否定词（归一化后判断）。"""
    return bool(_NEG_RE.search(text))

# 方向/状态翻转词对（数值变化、启用禁用、开关等）
_DIRECTION_PAIRS = (
    ("升", "降"), ("提高", "降低"), ("增加", "减少"), ("增大", "减小"),
    ("开启", "关闭"), ("打开", "关闭"), ("启用", "禁用"), ("允许", "禁止"),
    ("start", "stop"), ("enable", "disable"), ("allow", "deny"),
    ("increase", "decrease"), ("open", "close"), ("on", "off"),
    ("show", "hide"), ("include", "exclude"), ("加", "减"), ("快", "慢"),
    ("深", "浅"), ("深色", "浅色"), ("亮", "暗"), ("白天", "夜间"), ("夜间", "白天"),
)

_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def _has_negation(text: str) -> bool:
    """是否含否定词（归一化后判断）。"""
    return bool(_NEG_RE.search(text))


def detect_contradiction(old: str, new: str) -> bool:
    """检测新旧内容是否语义矛盾（零成本启发式：数值变化 / 否定翻转 / 方向词翻转）。

    用于"用户改口 / 新旧有出入"的判定：命中 → 不能当纯合并，需走冲突决策。
    """
    no = normalize_text(old)
    nn = normalize_text(new)
    if not no or not nn:
        return False
    # 1. 数值变化：两边都有数字但不一致（★0927 netfix：加"共享核心词+相似度"护栏——
    #    否则"我有3台电脑"对"他有5个苹果"也判矛盾 → upsert 顶替把旧记忆静默覆盖）
    nums_o = set(_NUM_RE.findall(no))
    nums_n = set(_NUM_RE.findall(nn))
    if nums_o and nums_n and nums_o != nums_n:
        shared = _key_tokens(no) & _key_tokens(nn)
        if shared and text_similarity(no, nn) >= 0.3:
            return True
    # 2. 否定翻转：共享核心词，但一边含否定一边不含
    if _has_negation(no) != _has_negation(nn):
        shared = _key_tokens(no) & _key_tokens(nn)
        if shared and text_similarity(no, nn) >= 0.3:
            return True
    # 3. 方向词翻转（★0927 netfix：同上加护栏——单个方向词出现即翻转太松）
    for a, b in _DIRECTION_PAIRS:
        if (a in no and b in nn) or (b in no and a in nn):
            shared = _key_tokens(no) & _key_tokens(nn)
            if shared and text_similarity(no, nn) >= 0.3:
                return True
    return False


def semantic_relation(old: str, new: str) -> str:
    """判定新旧内容关系（供 upsert 决策）：equivalent / extends / contradicts / unrelated。

    - equivalent   内容等价（措辞微差）→ 不覆盖，视为已存在
    - extends      同主题、新内容补充/更完整 → 合并更新
    - contradicts  新旧矛盾（改口）→ 走冲突决策
    - unrelated    不是同一条 → 新增
    """
    no = normalize_text(old)
    nn = normalize_text(new)
    if not no or not nn:
        return "unrelated"
    if no == nn:
        return "equivalent"
    if detect_contradiction(old, new):
        return "contradicts"
    sim = text_similarity(old, new)
    if sim >= 0.85:
        return "equivalent"
    if sim >= 0.45:
        return "extends"
    return "unrelated"


def _search_hint(text: str) -> str:
    """从内容提取一个显著检索词（英文/数字词 优先，其次中文 2-gram），用于 LIKE 预筛。
    避免用整句 LIKE 精确匹配导致"同义不同措辞"漏检。"""
    s = str(text or "").strip()
    if not s:
        return ""
    # 英文/数字词（如 emoji / TypeScript）最稳定
    en = re.findall(r"[A-Za-z0-9]+", s)
    if en:
        # 取最长的那个（最可能是关键词）
        return max(en, key=len)
    # 中文：取首句里的 4 字片段（覆盖短语）
    seg = _BREAK.split(s, 1)[0]
    seg = seg.strip()
    if len(seg) >= 4:
        return seg[:4]
    return seg or s[:4]

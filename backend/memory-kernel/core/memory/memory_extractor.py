"""NIS Memory — 记忆提炼服务（对话 → 分类记忆 → 项目/全局落盘）

把一段对话交给 LLM，分类提炼成五类记忆：
    preference（偏好）  → 全局 ~/.nis/preferences.md + memory_nodes(global)
    decision（决策）    → 项目 .nis/decisions.md + memory_nodes(project)
    pitfall（教训）     → 项目 .nis/pitfalls.md + memory_nodes(project)
    pattern（模式）     → 项目 .nis/patterns.md + memory_nodes(project)
    progress（进度）    → 项目 .nis/progress.md + memory_nodes(project)

LLM 不可用 / 解析失败 → 返回空结果（不抛异常），绝不污染记忆。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("memory.extractor")

VALID_TYPES = {"preference", "decision", "pitfall", "pattern", "progress"}

# 提炼 LLM 调用超时（秒）：LLM 提炼长对话可能较慢，超时太短会误判"提取失败"
#（前端 TIMEOUT=40s；后端需 < 40s，取 35s 稳妥——既给足时间又不让前端超时）
EXTRACT_LLM_TIMEOUT = 35.0

# 记忆类型 → 项目文件 / 全局文件 映射
# 原则：项目进度/教训/模式只进项目；决策/用户偏好属于全局（跨项目共享）
PROJECT_FILE = {
    "pitfall": "pitfalls.md",
    "pattern": "patterns.md",
    "progress": "progress.md",
}
GLOBAL_FILE = {
    "preference": "preferences.md",
    "decision": "decisions.md",
    "pitfall": "lessons.md",
}

# 作用域规则：preference / decision → 全局；pitfall / pattern / progress → 项目
def _scope_of(node_type: str) -> str:
    return "global" if node_type in ("preference", "decision") else "project"

DEFAULT_PROMPT = """你是 NIS 的记忆提炼官。阅读下面的对话片段，提炼出值得长期记住的高价值记忆。

每条记忆必须属于以下五类之一：
- preference：用户的个人偏好/习惯（通用，跨项目都适用）
- decision：本次做出的关键决策（为什么这么选）
- pitfall：踩过的坑、错误教训
- pattern：发现的好做法、可复用模式
- progress：项目推进的重要进度/成果

要求：
1. 只提炼真正高价值的记忆，闲聊、寒暄、过程性细节忽略
2. 每条记忆极简：title ≤10 字，content ≤30 字，只写核心事实本身
   （例如 content 直接写"用户喜欢小狗"；不要写"用户表达了对小狗的喜欢，这是个人偏好，在后续对话中需要…"这类填充与推导）
3. 只用名词/短句陈述事实，禁止"用户表达/提到/认为/表示"等引导词，
   禁止"这体现了/这说明/在后续对话中/需要关注"等解释性套话
4. **只提炼用户明确表达的事实/偏好/决策**；AI 自身陈述、编造示例、测试性对话、
   假设场景、模拟演练、为了演示而说的话，一律不提炼（判断不了就跳过）
5. 但反过来：只要用户明确表达过（如"我喜欢…""我决定…""不要用…""已经完成了…"），
   **必须提炼**，不要因为保守而漏掉；哪怕只有一条也要输出
6. 返回 JSON 数组，没有任何多余文字：
[{"node_type": "decision", "title": "...", "content": "..."}]

对话内容：
{content}
"""


class MemoryExtractor:
    """对话记忆提炼服务"""

    def __init__(
        self,
        llm_fn: Optional[Callable] = None,
        project_memory: Optional[object] = None,
        global_memory: Optional[object] = None,
        distill: Optional[object] = None,
    ) -> None:
        self._llm_fn = llm_fn
        self._project_memory = project_memory      # ProjectMemoryManager
        self._global_memory = global_memory        # GlobalMemoryManager
        self._distill = distill                    # DistillEngine
        self._last_error = ""                      # 最近一次 extract 失败原因（空=成功）

    def set_llm(self, llm_fn: Callable) -> None:
        self._llm_fn = llm_fn

    def has_llm(self) -> bool:
        return self._llm_fn is not None

    async def extract(self, content: str) -> list[dict]:
        """提炼对话 → 分类记忆列表。LLM 不可用/失败/超时 → []（last_error 记录原因）"""
        self._last_error = ""
        text = (content or "").strip()
        if not text:
            self._last_error = "内容为空"
            return []
        if not self._llm_fn:
            logger.warning("[memory-extract] llm_fn 未配置，无法提炼（模型未传？）")
            self._last_error = "模型未配置"
            return []

        prompt = DEFAULT_PROMPT.replace("{content}", text[:8000])
        _start = time.time()
        try:
            raw = await asyncio.wait_for(self._llm_fn(prompt), timeout=EXTRACT_LLM_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("[memory-extract] LLM 超时（>%.0fs），返回空", EXTRACT_LLM_TIMEOUT)
            self._last_error = f"提炼超时（>{EXTRACT_LLM_TIMEOUT:.0f}s），请重试"
            return []
        except Exception as e:
            logger.warning("[memory-extract] LLM 调用失败: %r", e)
            _msg = str(e)
            # 网关返回 HTML 错误页（Cloudflare 拦截/5xx）：给可读提示，而不是甩原始 HTML
            if "<!DOCTYPE html>" in _msg or "Cloudflare" in _msg or "blocked" in _msg.lower() or "<html" in _msg.lower():
                self._last_error = "模型服务被安全防护拦截（可能因对话含代码/命令片段触发）。可换模型重试，或缩短提炼内容"
            else:
                self._last_error = f"模型调用失败：{_msg[:80]}"
            return []
        _elapsed = time.time() - _start
        items = self._parse(raw)
        if not items:
            logger.warning("[memory-extract] 耗时=%.1fs 但未提炼出条目，raw 前 200 字：%s",
                           _elapsed, str(raw)[:200].replace("\n", " "))
        else:
            logger.info("[memory-extract] 耗时=%.1fs raw=%d字 条目=%d",
                        _elapsed, len(raw or ""), len(items))
        return items

    async def extract_and_persist(self, content: str, nis_core_scope_id: str = None, project_root: str = None, dry_run: bool = False, auto: bool = False) -> dict:
        """提炼 + 落盘（项目/全局 .md + 结构化索引）。

        Args:
            content: 待提炼对话
            nis_core_scope_id: 全局作用域 id（preference/decision 落到这里，可被全局检索）
            project_root: 当前项目根目录（project 作用域节点用它作 project_id 绑定，避免跨项目串）
            dry_run: True 只返回候选（outcome 判定）不落盘；False 提炼并落盘
            auto: True=自动提炼（60s 空闲触发，静默低权重）；False=用户确认提交（正常权重）

        Returns:
            {"ok": bool, "saved": n, "items": [已分类条目], "counts": {...}, "llm_used": bool, "msg": str}
            ok=False 且 msg=no_items 表示 LLM 正常返回但判断无值得提炼内容（不是失败）；
            其余 ok=False（msg 为原因）才是真失败。
        """
        items = await self.extract(content)
        if not items:
            if getattr(self, "_last_error", ""):
                return {"ok": False, "saved": 0, "items": [], "llm_used": self.has_llm(), "counts": {}, "msg": self._last_error}
            return {"ok": True, "saved": 0, "items": [], "llm_used": self.has_llm(), "counts": {}, "msg": "no_items"}
        if dry_run:
            return await self.preview_items(items, nis_core_scope_id=nis_core_scope_id, project_root=project_root)
        return await self.persist_items(items, nis_core_scope_id=nis_core_scope_id, project_root=project_root, auto=auto)

    async def preview_items(self, items: list[dict], nis_core_scope_id: str = None, project_root: str = None) -> dict:
        """仅判定每条 outcome（dry-run upsert），不落盘。用于前端先展示候选，用户勾选后再提交。"""
        for it in items:
            node_type = it["node_type"]
            scope = _scope_of(node_type)
            scope_id = nis_core_scope_id if scope == "global" else project_root
            verdict = None
            if self._distill is not None:
                try:
                    verdict = self._distill.preview(
                        title=it["title"],
                        content=it["content"],
                        node_type=node_type if node_type != "progress" else "fact",
                        scope=scope,
                        scope_id=scope_id,
                    )
                except Exception:
                    verdict = None
            if verdict is not None:
                it["outcome"] = verdict.get("outcome")
                it["hit_id"] = verdict.get("hit_id")
                it["old_content"] = verdict.get("old_content")
                it["reason"] = verdict.get("reason")
            else:
                it["outcome"] = "created"
        return {
            "ok": True,
            "saved": 0,
            "items": items,
            "counts": {},
            "dry_run": True,
            "llm_used": self.has_llm(),
        }

    async def persist_items(self, items: list[dict], nis_core_scope_id: str = None, project_root: str = None, auto: bool = False) -> dict:
        """只对给定条目落盘（用户勾选后提交）。返回每条最终 outcome + counts。

        auto=True（自动提炼）：降权 importance=0.35 + 打 pending_review 标记进审核区，
        用户到记忆星系「采纳」（转 user_explicit 0.85）或「丢弃」（软删），不直接生效。
        """
        saved = 0
        counts = {"created": 0, "already_exists": 0, "merged": 0, "conflict": 0}
        importance = 0.35 if auto else 0.85
        tags = ["pending_review"] if auto else []
        for it in items:
            node_type = it["node_type"]
            title = it["title"]
            body = it["content"]
            outcome = "created"
            hit_id = None
            old_content = None
            reason = None

            # 1. 结构化索引（memory_nodes + memory_records）：决策/偏好→全局，其余→项目
            if self._distill is not None:
                try:
                    from core.memory.models import MemorySourceType
                    scope = _scope_of(node_type)
                    scope_id = nis_core_scope_id if scope == "global" else project_root
                    # P2-1/P1-1：用户勾选提交 = 用户确认 → user_explicit 高可信（自动提炼=system_infer 低权重+待确认）
                    distill_res = self._distill.distill(
                        title=title,
                        content=body,
                        node_type=node_type if node_type != "progress" else "fact",
                        scope=scope,
                        scope_id=scope_id,
                        tags=tags,
                        importance=importance,
                        source_type=(
                            MemorySourceType.SYSTEM_INFER.value if auto
                            else MemorySourceType.USER_EXPLICIT.value
                        ),
                    )
                    if isinstance(distill_res, dict):
                        outcome = str(distill_res.get("outcome") or "created")
                        hit_id = distill_res.get("hit_id")
                        old_content = distill_res.get("old_content")
                        reason = distill_res.get("reason")
                    if outcome != "conflict":
                        saved += 1
                except Exception:
                    pass
                # 项目进度额外记一份全局记录（PROJECT_FACT）：默认检索不命中，
                # 用户显式提到之前做的项目时（Layer 3 历史检索 / MEMORY_QUERY）才能搜到
                # 注意：此副本是"进度"的检索镜像，不随主节点进审核区（去掉 pending_review），
                # 避免同一进度出现两份待确认卡片。
                if node_type == "progress" and nis_core_scope_id:
                    try:
                        self._distill.distill(
                            title=title,
                            content=body,
                            node_type="fact",
                            scope="global",
                            scope_id=nis_core_scope_id,
                            tags=[t for t in tags if t != "pending_review"] + ["项目进度"],
                        )
                    except Exception:
                        pass

            # 2. 偏好/决策 → 全局 ~/.nis；教训 → 项目 + 全局；模式/进度 → 项目
            if node_type == "preference" and self._global_memory is not None:
                try:
                    self._global_memory.append_entry("preference", title, body)
                except Exception:
                    pass
            elif node_type == "decision" and self._global_memory is not None:
                try:
                    self._global_memory.append_entry("decision", title, body)
                except Exception:
                    pass
            else:
                if node_type in PROJECT_FILE and self._project_memory is not None:
                    try:
                        self._project_memory.append_section(PROJECT_FILE[node_type], title, body)
                    except Exception:
                        pass
                if node_type in GLOBAL_FILE and self._global_memory is not None:
                    try:
                        self._global_memory.append_entry(node_type, title, body)
                    except Exception:
                        pass

            it["outcome"] = outcome
            it["hit_id"] = hit_id
            it["old_content"] = old_content
            it["reason"] = reason
            counts[outcome] = counts.get(outcome, 0) + 1

        return {
            "ok": True,
            "saved": saved,
            "items": items,
            "counts": counts,
            "llm_used": self.has_llm(),
        }

    # ── 解析 ──────────────────────────────────
    @staticmethod
    def _parse(raw: str) -> list[dict]:
        """解析 LLM 输出为条目列表（容错：围栏/数组/单对象）"""
        if not raw:
            return []
        m = re.search(r"\[.*\]|\{.*\}", raw, re.DOTALL)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []

        if isinstance(data, dict):
            data = data.get("items", [data])
        if not isinstance(data, list):
            return []

        out = []
        for item in data:
            if not isinstance(item, dict):
                continue
            node_type = str(item.get("node_type") or "").strip()
            if node_type not in VALID_TYPES:
                continue
            title = str(item.get("title") or "").strip()[:60]
            content = str(item.get("content") or "").strip()[:500]
            if not title or not content:
                continue
            out.append({"node_type": node_type, "title": title, "content": content})
        return out

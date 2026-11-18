"""NIS Memory System — 记忆提炼引擎"""

from __future__ import annotations

import uuid
from typing import Optional

from core.memory.models import (
    MemorySourceType, MemoryType, ScopeType,
)
from core.memory.store import MemoryStore
from core.memory.upsert import (
    VALID_NODE_TYPES, NODE_TYPE_TO_MEMORY_TYPE, upsert_memory,
)


class DistillEngine:
    """用户触发提炼：从对话中提取结构化记忆（落库前查重合并，避免重复堆积）"""

    def __init__(self, store: MemoryStore) -> None:
        self.store = store

    @staticmethod
    def _gen_id(prefix: str = "mnode") -> str:
        return f"{prefix}_{uuid.uuid4().hex[:12]}"

    def _find_duplicate(
        self,
        title: str,
        content: str,
        scope_type: ScopeType,
        scope_id: str,
        memory_type: MemoryType,
    ) -> Optional[Memory]:
        """查重：同作用域 + 同类型 下，内容高度相似/完全相同 → 返回旧记忆（兼容旧接口）。"""
        from core.memory.upsert import _find_candidate
        return _find_candidate(self.store, content, scope_type, scope_id, memory_type)

    def distill(
        self,
        title: str,
        content: str,
        node_type: str,
        scope: str = "project",
        scope_id: str = None,
        tags: list = None,
        source_window: str = None,
        source_conversation: str = None,
        importance: float = 0.85,
        source_type: str = None,
    ) -> dict:
        """提炼一条记忆

        落库前查重：同作用域+同类型 已有相同/相似记忆 → 更新旧记忆（不新增），
        返回 {node_id, memory_id, title, ...}（dup_merged=True 表示合并到了旧记忆，
        outcome 表示 created/already_exists/merged/conflict）。

        Args:
            title: 记忆标题（自动生成简短标题利于检索）
            content: 记忆完整内容
            node_type: 类型（preference/decision/pitfall/pattern/fact）
            scope: 作用域（global/project）
            scope_id: 目标作用域 ID
            tags: 标签列表
            source_window: 来源窗口 ID
            source_conversation: 来源对话文件路径
            importance: 重要度权重（P2-1：自动提炼=0.5 静默低权重；用户确认=0.85）
            source_type: 来源标记（None=system_infer；用户勾选提交传 user_explicit）
        """
        verdict = upsert_memory(
            self.store,
            title=title,
            content=content,
            node_type=node_type,
            scope=scope,
            scope_id=scope_id,
            tags=tags or [],
            source_type=source_type or MemorySourceType.SYSTEM_INFER.value,
            created_by="distill",
            confidence=0.9,
            importance=importance,
            conflict_mode="ask",
        )
        return {
            "node_id": verdict.node_id,
            "memory_id": verdict.memory_id,
            "title": verdict.title,
            "node_type": verdict.node_type,
            "scope": verdict.scope,
            "created_at": verdict.created_at,
            "dup_merged": verdict.outcome in ("merged", "already_exists"),
            "outcome": verdict.outcome,
            "reason": verdict.reason,
            "old_content": verdict.old_content,
            "new_content": verdict.new_content,
            "hit_id": verdict.hit_id,
        }

    def preview(
        self,
        title: str,
        content: str,
        node_type: str,
        scope: str = "project",
        scope_id: str = None,
    ) -> dict:
        """提炼预览：只判定 outcome（created/already_exists/merged/conflict），不落盘。"""
        verdict = upsert_memory(
            self.store,
            title=title,
            content=content,
            node_type=node_type,
            scope=scope,
            scope_id=scope_id,
            tags=[],
            source_type=MemorySourceType.SYSTEM_INFER.value,
            created_by="distill",
            conflict_mode="ask",
            dry_run=True,
        )
        return {
            "outcome": verdict.outcome,
            "memory_id": verdict.memory_id,
            "hit_id": verdict.hit_id,
            "old_content": verdict.old_content,
            "reason": verdict.reason,
        }

    def auto_generate_title(self, content: str) -> str:
        """从内容自动生成标题（简单规则，不调用 LLM）"""
        # 取第一行或前 30 个字符
        first_line = content.strip().split("\n")[0]
        if len(first_line) <= 40:
            return first_line
        return first_line[:37] + "..."

    def get_distilled_nodes(
        self,
        scope: str = None,
        node_type: str = None,
        scope_id: str = None,
        limit: int = 50,
    ) -> list[dict]:
        """获取已提炼的记忆节点"""
        from core.memory.memory_graph import MemoryGraph
        graph = MemoryGraph(self.store)

        return graph.list_nodes(
            scope=scope, node_type=node_type,
            project_id=scope_id, enabled_only=False,
        )[:limit]

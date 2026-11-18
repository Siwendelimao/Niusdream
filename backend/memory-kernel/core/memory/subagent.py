"""NIS Memory System — Sub-Agent Memory Protocol"""

from __future__ import annotations

import time
import uuid
from typing import Optional

from core.memory.models import (
    DeliveryPackage,
    Memory,
    MemoryStatus,
    MemoryType,
    ScopeType,
    SubAgentContext,
    SearchQuery,
    EvidenceType,
)
from core.memory.store import MemoryStore


class SubAgentProtocol:
    """子 Agent 记忆协议
    
    管理子 Agent 的完整生命周期：
    - 启动时：注入授权上下文
    - 执行中：权限边界检查
    - 结束时：处理交付包，提交候选记忆
    """

    def __init__(self, store: MemoryStore, nis_core_scope_id: str) -> None:
        self._store = store
        self._nis_core_scope_id = nis_core_scope_id

    def create_context(
        self,
        task_id: str,
        task_description: str,
        project_scope_id: str = None,
    ) -> SubAgentContext:
        """创建子 Agent 启动时的授权上下文"""
        authorized = {
            "nis_summary": self._load_nis_summary(),
            "user_profile": self._load_user_profile(),
        }

        # 添加项目级上下文
        if project_scope_id:
            project_facts = self._load_project_facts(project_scope_id)
            authorized["project_facts"] = project_facts["facts"]
            authorized["relevant_project_decisions"] = project_facts["decisions"]

        return SubAgentContext(
            task_id=task_id,
            task_description=task_description,
            authorized_context=authorized,
        )

    def process_delivery(
        self,
        package: DeliveryPackage,
        project_scope_id: str = None,
    ) -> dict:
        """处理子 Agent 结束时提交的交付包"""
        result = {
            "task_id": package.task_id,
            "processed_at": time.time(),
            "accepted": [],
            "rejected": [],
        }

        # 处理项目记忆候选
        if project_scope_id:
            for candidate in package.project_memory_candidates:
                memory = self._create_memory_from_candidate(
                    candidate, ScopeType.PROJECT, project_scope_id, package.task_id
                )
                if memory:
                    self._store.add(memory)
                    result["accepted"].append(candidate.get("content", "")[:50])

        # 处理中心记忆候选（子 Agent 不能直接写，只能提案）
        for candidate in package.nis_core_candidates:
            content = candidate.get("content", "")
            if content:
                self._store.add(Memory(
                    id="",
                    scope_type=ScopeType.NIS_CORE,
                    scope_id=self._nis_core_scope_id,
                    memory_type=MemoryType.SEMANTIC,
                    content=content,
                    status=MemoryStatus.CANDIDATE,
                    confidence=candidate.get("confidence", 0.7),
                    source_type=EvidenceType.SUBAGENT_INFERENCE.value,
                    created_by=f"subagent:{package.task_id}",
                ))
                result["accepted"].append(f"[中心候选] {content[:50]}")

        return result

    def check_permission(self, context: SubAgentContext, action: str) -> bool:
        """检查子 Agent 是否有权限执行操作"""
        perms = context.permissions

        if action == "read_nis_core":
            return perms.get("can_read_nis_core", False)
        elif action == "read_project_memory":
            return perms.get("can_read_project_memory", True)
        elif action == "write_project_memory":
            return perms.get("can_write_project_memory", False)
        elif action == "propose_memory":
            return perms.get("can_propose_memory", True)
        elif action == "modify_nis_identity":
            return False
        elif action == "modify_nis_persona":
            return False
        elif action == "read_other_project":
            return False
        elif action == "write_nis_core_directly":
            return False

        return False

    def _load_nis_summary(self) -> str:
        """加载 NIS 身份摘要"""
        blocks = self._store.get_context(ScopeType.NIS_CORE, self._nis_core_scope_id)
        summary_parts = []
        for block in blocks:
            if block.memory_type in (MemoryType.IDENTITY, MemoryType.PERSONA):
                summary_parts.append(block.content)
        return "; ".join(summary_parts) if summary_parts else "NIS 认知助手"

    def _load_user_profile(self) -> dict:
        """加载用户资料"""
        memories = self._store.get_memories_by_type(
            scope_type=ScopeType.NIS_CORE,
            scope_id=self._nis_core_scope_id,
            memory_types=[MemoryType.USER_PROFILE, MemoryType.PREFERENCE],
        )
        profile = {}
        for mem in memories:
            if mem.structured_value:
                profile.update(mem.structured_value)
            else:
                profile[mem.memory_type.value] = mem.content
        return profile

    def _load_project_facts(self, project_scope_id: str) -> dict:
        """加载项目事实和决策"""
        memories = self._store.get_memories_by_type(
            scope_type=ScopeType.PROJECT,
            scope_id=project_scope_id,
            memory_types=[MemoryType.PROJECT_FACT, MemoryType.PROJECT_DECISION],
        )
        facts = []
        decisions = []
        for mem in memories:
            if mem.memory_type == MemoryType.PROJECT_FACT:
                facts.append(mem.content)
            elif mem.memory_type == MemoryType.PROJECT_DECISION:
                decisions.append(mem.content)
        return {"facts": facts, "decisions": decisions}

    def _create_memory_from_candidate(
        self,
        candidate: dict,
        scope_type: ScopeType,
        scope_id: str,
        task_id: str,
    ) -> Optional[Memory]:
        """从候选创建记忆"""
        content = candidate.get("content", "")
        if not content:
            return None

        try:
            memory_type = MemoryType(candidate.get("memory_type", "project_fact"))
        except ValueError:
            memory_type = MemoryType.PROJECT_FACT

        memory = Memory(
            id="",
            scope_type=scope_type,
            scope_id=scope_id,
            memory_type=memory_type,
            content=content,
            structured_value=candidate.get("structured_value"),
            confidence=candidate.get("confidence", 0.8),
            importance=candidate.get("importance", 0.5),
            source_type=EvidenceType.SUBAGENT_INFERENCE.value,
            created_by=f"subagent:{task_id}",
            status=MemoryStatus.ACTIVE,
        )
        return memory

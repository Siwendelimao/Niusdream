"""NIS Memory System — Consolidation Agent"""

from __future__ import annotations

import time
from typing import Optional

from core.memory.models import (
    Memory,
    MemoryStatus,
    MemoryType,
    ScopeType,
    SearchQuery,
    EvidenceType,
    Project,
)
from core.memory.store import MemoryStore


class ConsolidationAgent:
    """巩固 Agent
    
    项目结束时自动触发，提炼项目中的高价值内容：
    1. 项目归档摘要
    2. 项目知识沉淀（保留在项目记忆中）
    3. NIS 中心记忆晋升候选
    """

    def __init__(self, store: MemoryStore, nis_core_scope_id: str) -> None:
        self._store = store
        self._nis_core_scope_id = nis_core_scope_id

    def consolidate(self, project_id: str) -> dict:
        """执行项目巩固
        
        Returns:
            {
                "project_id": str,
                "archive_summary": dict,
                "knowledge_retained": list,
                "promotion_candidates": list,
                "processed_at": float,
            }
        """
        project = self._store.get_project(project_id)
        if not project:
            return {"error": "project not found"}

        result = {
            "project_id": project_id,
            "processed_at": time.time(),
        }

        # 1. 收集项目活跃记忆（仅项目相关类型）
        project_memory_types = [
            MemoryType.PROJECT_FACT,
            MemoryType.PROJECT_DECISION,
            MemoryType.PROJECT_LESSON,
            MemoryType.PROJECT_CONSTRAINT,
            MemoryType.PROJECT_ARTIFACT,
            MemoryType.PROCEDURE,
            MemoryType.SEMANTIC,
        ]
        memories = self._store.get_memories_by_type(
            scope_type=ScopeType.PROJECT,
            scope_id=project.scope_id,
            memory_types=project_memory_types,
            top_k=100,
        )

        # 2. 生成归档摘要
        result["archive_summary"] = self._build_archive_summary(project, memories)

        # 3. 识别知识沉淀（保留在项目记忆中）
        result["knowledge_retained"] = self._identify_knowledge(memories)

        # 4. 生成晋升候选
        result["promotion_candidates"] = self._extract_promotion_candidates(
            memories, project_scope_id=project.scope_id
        )

        # 5. 保存晋升候选到中心（状态为 CANDIDATE）
        for candidate in result["promotion_candidates"]:
            self._store.add(Memory(
                id="",
                scope_type=ScopeType.NIS_CORE,
                scope_id=self._nis_core_scope_id,
                memory_type=MemoryType.SEMANTIC,
                content=candidate["content"],
                structured_value=candidate.get("structured_value"),
                confidence=candidate.get("confidence", 0.8),
                importance=candidate.get("importance", 0.7),
                source_type=EvidenceType.NIS_INFERENCE.value,
                created_by=f"consolidation:{project_id}",
                status=MemoryStatus.CANDIDATE,
                tags=["promotion_candidate", f"source_project:{project_id}"],
            ))

        return result

    def _build_archive_summary(
        self, project: Project, memories: list[Memory]
    ) -> dict:
        """生成项目归档摘要"""
        facts = []
        decisions = []
        lessons = []
        constraints = []

        for mem in memories:
            if mem.memory_type == MemoryType.PROJECT_FACT:
                facts.append(mem.content)
            elif mem.memory_type == MemoryType.PROJECT_DECISION:
                decisions.append(mem.content)
            elif mem.memory_type == MemoryType.PROJECT_LESSON:
                lessons.append(mem.content)
            elif mem.memory_type == MemoryType.PROJECT_CONSTRAINT:
                constraints.append(mem.content)

        return {
            "project_name": project.name,
            "goal": project.goal,
            "tech_stack": project.tech_stack,
            "current_phase": project.current_phase,
            "progress": project.progress,
            "facts_count": len(facts),
            "decisions_count": len(decisions),
            "lessons_count": len(lessons),
            "facts": facts[:20],
            "decisions": decisions[:20],
            "lessons": lessons[:20],
            "constraints": constraints[:10],
        }

    def _identify_knowledge(self, memories: list[Memory]) -> list[str]:
        """识别应保留在项目记忆中的知识"""
        knowledge = []
        for mem in memories:
            if mem.memory_type in (
                MemoryType.PROJECT_FACT,
                MemoryType.PROJECT_DECISION,
                MemoryType.PROJECT_LESSON,
            ):
                if mem.importance >= 0.6:
                    knowledge.append(mem.content)
        return knowledge

    def _extract_promotion_candidates(
        self, memories: list[Memory], project_scope_id: str
    ) -> list[dict]:
        """提取可晋升到中心记忆的候选"""
        candidates = []

        for mem in memories:
            # 只考虑高置信度、高重要性的记忆
            if mem.confidence < 0.8 or mem.importance < 0.7:
                continue

            # 检查是否符合晋升条件
            if self._is_promotable(mem, project_scope_id):
                candidates.append({
                    "content": mem.content,
                    "structured_value": mem.structured_value,
                    "memory_type": mem.memory_type.value,
                    "confidence": mem.confidence,
                    "importance": mem.importance,
                    "evidence": [mem.content],
                    "promotion_reason": self._get_promotion_reason(mem),
                    "source_memory_id": mem.id,
                })

        return candidates

    def _is_promotable(self, memory: Memory, project_scope_id: str) -> bool:
        """判断记忆是否符合晋升条件"""
        # 用户偏好：置信度 ≥ 0.85 且内容与偏好相关
        if memory.memory_type == MemoryType.PROJECT_FACT:
            if memory.confidence < 0.85:
                return False
            # 检查是否为稳定偏好（关键词匹配 + 跨项目验证）
            is_preference = any(kw in memory.content for kw in ["偏好", "习惯", "喜欢", "倾向"])
            if not is_preference:
                return False
            # 验证跨项目出现次数
            return self._count_cross_project_occurrences(memory.content) >= 2

        # 用户工作方式/经验：重要性 ≥ 0.85
        if memory.memory_type == MemoryType.PROJECT_LESSON:
            return memory.importance >= 0.85

        # 可复用技能
        if memory.memory_type == MemoryType.PROCEDURE:
            return memory.confidence >= 0.8

        return False

    def _count_cross_project_occurrences(self, content: str) -> int:
        """计算内容跨项目出现次数"""
        # 提取关键词（取前 10 字符作为锚点）
        anchor = content[:10] if len(content) >= 10 else content
        if len(anchor) < 3:
            return 0

        # 搜索所有项目作用域的记忆
        results = self._store.search_memories(
            text=anchor,
            scope_type=ScopeType.PROJECT,
            memory_types=[MemoryType.PROJECT_FACT],
            top_k=50,
        )
        # 统计匹配的项目数
        project_ids = set()
        for mem in results:
            if mem.scope_id not in project_ids:
                project_ids.add(mem.scope_id)
        return len(project_ids)

    def _get_promotion_reason(self, memory: Memory) -> str:
        """获取晋升原因"""
        if memory.memory_type == MemoryType.PROJECT_FACT:
            return "用户稳定偏好"
        elif memory.memory_type == MemoryType.PROJECT_LESSON:
            return "重要项目经验"
        elif memory.memory_type == MemoryType.PROCEDURE:
            return "可复用工作方法"
        return "高价值内容"


class PromotionManager:
    """晋升管理器"""

    def __init__(self, store: MemoryStore, nis_core_scope_id: str) -> None:
        self._store = store
        self._nis_core_scope_id = nis_core_scope_id

    def approve_promotion(self, candidate_id: str, reviewer: str = "user") -> Optional[Memory]:
        """批准晋升：candidate → active + 版本链更新"""
        candidate = self._store.get(candidate_id)
        if not candidate or candidate.status != MemoryStatus.CANDIDATE:
            return None

        # 检查是否与现有中心记忆冲突
        existing = self._find_similar_core_memory(candidate)
        if existing:
            # 建立版本链：替代旧记忆
            result = self._store.approve_candidate(candidate_id, reviewer=reviewer)
            if result:
                self._store.change_state(
                    existing.id, MemoryStatus.SUPERSEDED,
                    reason=f"superseded by {candidate_id}",
                )
                # 更新版本链
                self._update_version_chain(candidate_id, existing.id)
            return result
        else:
            # 无冲突，直接通过
            return self._store.approve_candidate(candidate_id, reviewer=reviewer)

    def reject_promotion(self, candidate_id: str, reviewer: str = "user") -> Optional[Memory]:
        """拒绝晋升"""
        return self._store.reject_candidate(candidate_id, reviewer=reviewer)

    def demote_to_project(self, memory_id: str, project_scope_id: str) -> Optional[Memory]:
        """将中心记忆降级到项目（保留原记忆类型）"""
        memory = self._store.get(memory_id)
        if not memory or memory.scope_type != ScopeType.NIS_CORE:
            return None

        # 创建项目作用域的新记忆（保留原记忆类型）
        new_memory = Memory(
            id="",
            scope_type=ScopeType.PROJECT,
            scope_id=project_scope_id,
            memory_type=memory.memory_type,
            content=memory.content,
            structured_value=memory.structured_value,
            confidence=memory.confidence,
            importance=memory.importance,
            source_type=EvidenceType.NIS_INFERENCE.value,
            created_by="demotion",
            status=MemoryStatus.ACTIVE,
            tags=memory.tags,
        )
        self._store.add(new_memory)

        # 原中心记忆标记为 recalled
        self._store.change_state(memory_id, MemoryStatus.RECALLED,
                                  reason=f"demoted to project {project_scope_id}")
        return new_memory

    def revoke_promotion(self, memory_id: str) -> Optional[Memory]:
        """撤销晋升（撤回已晋升到中心的记忆）"""
        memory = self._store.get(memory_id)
        if not memory or memory.scope_type != ScopeType.NIS_CORE:
            return None
        return self._store.change_state(memory_id, MemoryStatus.RECALLED,
                                        reason="promotion revoked")

    def _find_similar_core_memory(self, candidate: Memory) -> Optional[Memory]:
        """查找相似的中心记忆（用于版本链，使用公开 API）"""
        anchor = candidate.content[:10]
        if len(anchor) < 3:
            return None

        # 使用公开 search_memories API（LIKE 子串匹配）
        results = self._store.search_memories(
            text=anchor,
            scope_type=ScopeType.NIS_CORE,
            scope_id=self._nis_core_scope_id,
            top_k=5,
        )
        for mem in results:
            if mem.status == MemoryStatus.ACTIVE and mem.id != candidate.id:
                return mem
        return None

    def _update_version_chain(self, new_id: str, old_id: str) -> None:
        """更新版本链（使用公开 update API + 事件日志）"""
        # 使用公开 update 方法（含乐观锁 + 事件日志）
        self._store.update(
            new_id,
            {"supersedes": old_id},
            expected_version=self._store.get(new_id).version,
        )
        self._store.update(
            old_id,
            {"superseded_by": new_id},
            expected_version=self._store.get(old_id).version,
        )

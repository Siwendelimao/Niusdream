"""NIS Memory System — Core Memory Block Management"""

from __future__ import annotations

import time
from typing import Optional

from core.memory.models import (
    Memory,
    MemoryStatus,
    MemoryType,
    ScopeType,
    EvidenceType,
)
from core.memory.store import MemoryStore, _row_to_memory


CORE_MEMORY_TYPES = {
    MemoryType.IDENTITY,
    MemoryType.PERSONA,
    MemoryType.USER_PROFILE,
    MemoryType.PREFERENCE,
    MemoryType.COMMITMENT,
}

MODIFIABLE_TYPES = {
    MemoryType.PERSONA,
    MemoryType.USER_PROFILE,
    MemoryType.PREFERENCE,
    MemoryType.COMMITMENT,
}


class CoreMemoryStore:
    """固定块存储（借鉴 Letta 的 blocks 概念）"""

    def __init__(self, store: MemoryStore, nis_core_scope_id: str) -> None:
        self.store = store
        self.nis_core_scope_id = nis_core_scope_id

    def initialize_identity(self, name: str, role: str) -> Memory:
        """初始化 NIS 身份（不可修改；已存在则跳过，防重启重复写）"""
        existing = self._get_existing(MemoryType.IDENTITY)
        if existing:
            return existing
        identity = Memory(
            id="",
            scope_type=ScopeType.NIS_CORE,
            scope_id=self.nis_core_scope_id,
            memory_type=MemoryType.IDENTITY,
            content=f"Name: {name}\nRole: {role}",
            status=MemoryStatus.ACTIVE,
            confidence=1.0,
            importance=1.0,
            source_reliability=1.0,
            created_by="system",
            approved_by="system",
            user_override=True,
            policy_lock=True,
            recorded_at=time.time(),
        )
        return self.store.add(identity)

    def initialize_persona(self, tone: str, values: str) -> Memory:
        """初始化 NIS 人格（已存在则跳过，防重启重复写）"""
        existing = self._get_existing(MemoryType.PERSONA)
        if existing:
            return existing
        persona = Memory(
            id="",
            scope_type=ScopeType.NIS_CORE,
            scope_id=self.nis_core_scope_id,
            memory_type=MemoryType.PERSONA,
            content=f"Tone: {tone}\nValues: {values}",
            status=MemoryStatus.ACTIVE,
            confidence=1.0,
            importance=1.0,
            source_reliability=1.0,
            created_by="system",
            approved_by="system",
            recorded_at=time.time(),
        )
        return self.store.add(persona)

    def set_block(self, memory_type: MemoryType, content: str,
                  actor: str = "user") -> Optional[Memory]:
        """设置固定块"""
        if memory_type not in CORE_MEMORY_TYPES:
            raise ValueError(f"{memory_type} is not a core memory type")
        if memory_type == MemoryType.IDENTITY:
            raise PermissionError("Identity cannot be modified")

        existing = self._get_existing(memory_type)
        if existing:
            return self.store.update(
                existing.id,
                {"content": content},
                expected_version=existing.version,
            )
        else:
            memory = Memory(
                id="",
                scope_type=ScopeType.NIS_CORE,
                scope_id=self.nis_core_scope_id,
                memory_type=memory_type,
                content=content,
                status=MemoryStatus.ACTIVE,
                confidence=1.0,
                importance=1.0,
                source_reliability=1.0,
                source_type=EvidenceType.EXPLICIT_USER.value,
                created_by=actor,
                approved_by=actor,
                recorded_at=time.time(),
            )
            return self.store.add(memory)

    def get_block(self, memory_type: MemoryType) -> Optional[Memory]:
        """获取固定块"""
        return self._get_existing(memory_type)

    def load_core_memory(self) -> list[Memory]:
        """加载所有固定块（每次对话调用）"""
        return self.store.get_context(
            ScopeType.NIS_CORE, self.nis_core_scope_id
        )

    def _get_existing(self, memory_type: MemoryType) -> Optional[Memory]:
        conn = self.store._conn()
        row = conn.execute(
            """SELECT * FROM memory_records
               WHERE scope_type = ? AND scope_id = ?
               AND memory_type = ? AND status = 'active'
               LIMIT 1""",
            (ScopeType.NIS_CORE.value, self.nis_core_scope_id,
             memory_type.value),
        ).fetchone()
        conn.close()
        return _row_to_memory(row) if row else None

"""NIS Memory System — State Machine"""

from __future__ import annotations

from core.memory.models import MemoryStatus


VALID_TRANSITIONS: dict[MemoryStatus, set[MemoryStatus]] = {
    MemoryStatus.CANDIDATE: {
        MemoryStatus.ACTIVE,
        MemoryStatus.REJECTED,
        MemoryStatus.QUARANTINED,
    },
    MemoryStatus.ACTIVE: {
        MemoryStatus.INACTIVE,
        MemoryStatus.SUPERSEDED,
        MemoryStatus.EXPIRED,
        MemoryStatus.RECALLED,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.INACTIVE: {
        MemoryStatus.ACTIVE,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.QUARANTINED: {
        MemoryStatus.ACTIVE,
        MemoryStatus.REJECTED,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.EXPIRED: {
        MemoryStatus.ACTIVE,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.SUPERSEDED: {
        MemoryStatus.ACTIVE,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.RECALLED: {
        MemoryStatus.ACTIVE,
        MemoryStatus.SOFT_DELETED,
    },
    MemoryStatus.SOFT_DELETED: {
        MemoryStatus.ACTIVE,
        MemoryStatus.HARD_DELETED,
    },
    MemoryStatus.REJECTED: set(),
    MemoryStatus.HARD_DELETED: set(),
}


def can_transition(from_status: MemoryStatus, to_status: MemoryStatus) -> bool:
    """检查状态转换是否合法"""
    allowed = VALID_TRANSITIONS.get(from_status, set())
    return to_status in allowed


def is_searchable(status: MemoryStatus) -> bool:
    """状态是否参与普通检索"""
    return status == MemoryStatus.ACTIVE


def is_recoverable(status: MemoryStatus) -> bool:
    """状态是否可恢复"""
    return status not in (MemoryStatus.REJECTED, MemoryStatus.HARD_DELETED)


def is_terminal(status: MemoryStatus) -> bool:
    """是否为终态"""
    return len(VALID_TRANSITIONS.get(status, set())) == 0

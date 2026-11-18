"""NIS Memory System — Data Models"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class MemoryStatus(str, Enum):
    CANDIDATE = "candidate"
    ACTIVE = "active"
    INACTIVE = "inactive"
    QUARANTINED = "quarantined"
    EXPIRED = "expired"
    SUPERSEDED = "superseded"
    REJECTED = "rejected"
    RECALLED = "recalled"
    SOFT_DELETED = "soft_deleted"
    HARD_DELETED = "hard_deleted"


class ScopeType(str, Enum):
    NIS_CORE = "nis_core"
    PROJECT = "project"
    WINDOW = "window"
    TASK = "task"


class MemorySourceType(str, Enum):
    """记忆来源语义化：谁/怎么来的（影响可信度与冲突优先级）。"""
    USER_EXPLICIT = "user_explicit"      # 用户明确说/主动告诉
    USER_IMPLICIT = "user_implicit"      # 从用户行为推断
    SYSTEM_INFER = "system_infer"        # 系统/模型自动推断（提炼）
    SYSTEM_OBSERVED = "system_observed"  # 工具观察到的客观事实
    IMPORTED = "imported"                # 导入


class MemoryType(str, Enum):
    IDENTITY = "identity"
    PERSONA = "persona"
    USER_PROFILE = "user_profile"
    PREFERENCE = "preference"
    COMMITMENT = "commitment"
    SEMANTIC = "semantic"
    PROCEDURE = "procedure"
    PROJECT_FACT = "project_fact"
    PROJECT_DECISION = "project_decision"
    PROJECT_CONSTRAINT = "project_constraint"
    PROJECT_STATE = "project_state"
    PROJECT_LESSON = "project_lesson"
    PROJECT_ARTIFACT = "project_artifact"


class EvidenceType(str, Enum):
    EXPLICIT_USER = "explicit_user"
    REPEATED_USER = "repeated_user"
    TOOL_VERIFIED = "tool_verified"
    DOCUMENT_VERIFIED = "document_verified"
    NIS_INFERENCE = "nis_inference"
    SUBAGENT_INFERENCE = "subagent_inference"
    MODEL_SUMMARY = "model_summary"
    SYSTEM = "system"


class ControlRuleType(str, Enum):
    DO_NOT_STORE = "do_not_store"
    DO_NOT_RECALL = "do_not_recall"
    ALWAYS_CONFIRM = "always_confirm"
    FORCED_SCOPE = "forced_scope"


@dataclass
class Memory:
    id: str
    scope_type: ScopeType
    scope_id: str
    memory_type: MemoryType
    content: str
    status: MemoryStatus
    confidence: float = 0.8
    importance: float = 0.5
    source_reliability: float = 0.8
    structured_value: Optional[dict] = None
    valid_from: Optional[float] = None
    valid_until: Optional[float] = None
    observed_at: Optional[float] = None
    recorded_at: float = 0.0
    last_confirmed_at: Optional[float] = None
    timezone: str = "Asia/Shanghai"
    time_precision: str = "exact"
    temporal_source: str = "system_recorded"
    version: int = 1
    supersedes: Optional[str] = None
    superseded_by: Optional[str] = None
    source_type: Optional[str] = None
    source_event_ids: Optional[list] = None
    source_window_id: Optional[str] = None
    source_agent_id: Optional[str] = None
    created_by: str = ""
    approved_by: Optional[str] = None
    user_override: bool = False
    policy_lock: bool = False
    tags: list[str] = field(default_factory=list)
    embedding_provider: Optional[str] = None
    embedding_model: Optional[str] = None
    embedding_dimensions: Optional[int] = None
    embedding_version: Optional[str] = None
    vector_id: Optional[str] = None
    indexed_at: Optional[float] = None
    reindex_status: str = "pending"
    retention_policy: str = "default"
    closed_at: Optional[float] = None
    archived_at: Optional[float] = None
    searchable_after_close: bool = False
    consolidation_eligible: bool = True
    auto_purge_at: Optional[float] = None
    created_at: float = 0.0
    updated_at: float = 0.0
    deleted_at: Optional[float] = None


@dataclass
class SearchQuery:
    text: str
    scope_type: ScopeType
    scope_id: str
    caller_type: str = "nis_core"
    caller_id: str = ""
    memory_types: Optional[list] = None
    top_k: int = 10
    time_filter: str = "current"
    include_deleted: bool = False


@dataclass
class SearchResult:
    memories: list[Memory] = field(default_factory=list)
    scores: list[float] = field(default_factory=list)
    retrieval_method: str = "fts"
    total_candidates: int = 0
    filtered_count: int = 0
    query_time_ms: float = 0.0


@dataclass
class MemoryEvent:
    event_id: str
    event_type: str
    memory_id: str
    aggregate_id: str
    aggregate_version: int
    actor_type: str
    actor_id: str
    idempotency_key: Optional[str] = None
    causation_id: Optional[str] = None
    correlation_id: Optional[str] = None
    previous_status: Optional[str] = None
    new_status: Optional[str] = None
    previous_value: Optional[str] = None
    new_value: Optional[str] = None
    reason: Optional[str] = None
    source_message_id: Optional[str] = None
    occurred_at: float = 0.0


@dataclass
class Scope:
    id: str
    scope_type: ScopeType
    status: str = "active"
    owner_id: Optional[str] = None
    parent_scope_id: Optional[str] = None
    created_at: float = 0.0


@dataclass
class ControlRule:
    id: str
    rule_type: ControlRuleType
    target_memory_type: Optional[str] = None
    target_subtype: Optional[str] = None
    target_key: Optional[str] = None
    pattern: Optional[str] = None
    semantic_condition: Optional[str] = None
    scope_type: Optional[str] = None
    priority: int = 0
    is_active: bool = True
    expires_at: Optional[float] = None
    created_at: float = 0.0


@dataclass
class Project:
    id: str
    scope_id: str
    name: str
    status: str = "active"
    goal: str = None
    tech_stack: list = None
    current_phase: str = None
    progress: float = 0
    root_path: str = None
    created_at: float = 0.0
    archived_at: float = None
    knowledge_enabled: bool = False
    knowledge_top_k: int = 3
    knowledge_max_chars: int = 500


@dataclass
class Window:
    id: str
    project_id: str = None
    scope_id: str = None
    title: str = ""
    status: str = "active"
    state_json: dict = None
    created_at: float = 0.0
    closed_at: float = None


@dataclass
class Proposal:
    id: str
    source_scope_type: str
    source_scope_id: str
    target_scope_type: str
    memory_type: str
    content: str
    structured_value: Optional[dict] = None
    evidence: Optional[list] = None
    confidence: float = 0.8
    importance: float = 0.5
    proposed_by: str = ""
    promotion_reason: Optional[str] = None
    requires_user_confirmation: bool = True
    status: str = "pending"
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[float] = None
    created_at: float = 0.0


@dataclass
class DeliveryPackage:
    """子 Agent 结束时提交的交付包"""
    task_id: str
    status: str = "completed"
    result_summary: str = ""
    files_changed: list[str] = field(default_factory=list)
    project_memory_candidates: list[dict] = field(default_factory=list)
    nis_core_candidates: list[dict] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    submitted_at: float = 0.0


@dataclass
class SubAgentContext:
    """子 Agent 启动时接收的授权上下文"""
    task_id: str
    task_description: str = ""
    authorized_context: dict = field(default_factory=dict)
    permissions: dict = field(default_factory=lambda: {
        "can_read_nis_core": False,
        "can_read_project_memory": True,
        "can_write_project_memory": False,
        "can_propose_memory": True,
    })


# ── Phase 5: 语义检索抽象接口 ──────────────────────


class EmbeddingProvider(ABC):
    """Embedding 生成器抽象接口"""

    @abstractmethod
    def embed(self, text: str) -> list[float]:
        """将单条文本转换为向量"""
        ...

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """批量转换文本为向量"""
        ...

    @property
    @abstractmethod
    def dimensions(self) -> int:
        """返回向量维度"""
        ...

    @property
    @abstractmethod
    def model_name(self) -> str:
        """返回模型名称"""
        ...


class RetrievalBackend(ABC):
    """检索后端抽象接口（可替换 FTS5 / Mem0 / Qdrant）"""

    @abstractmethod
    def upsert(self, memory_id: str, vector: list[float]) -> None:
        """插入或更新向量"""
        ...

    @abstractmethod
    def delete(self, memory_id: str) -> None:
        """删除向量"""
        ...

    @abstractmethod
    def search(
        self,
        query_vector: list[float],
        scope_ids: list[str],
        top_k: int = 10,
    ) -> list[tuple[str, float]]:
        """向量检索，返回 [(memory_id, score), ...]"""
        ...

    @abstractmethod
    def get_stats(self) -> dict:
        """返回索引统计信息"""
        ...


def create_retrieval_backend(
    backend_type: str,
    db_path: str,
    dimensions: int,
) -> RetrievalBackend:
    """工厂函数：创建检索后端
    
    Args:
        backend_type: "sqlite" | "mem0" | "qdrant" | "chroma"
        db_path: 数据库路径
        dimensions: 向量维度
    
    Returns:
        RetrievalBackend 实例
    
    Raises:
        NotImplementedError: 未支持的后端类型
    """
    if backend_type == "sqlite":
        from core.memory.vector_index import SqliteVectorIndex
        return SqliteVectorIndex(db_path, dimensions)
    elif backend_type == "mem0":
        raise NotImplementedError(
            "Mem0 backend not yet implemented. "
            "Install mem0ai and implement Mem0RetrievalBackend."
        )
    elif backend_type == "qdrant":
        raise NotImplementedError(
            "Qdrant backend not yet implemented. "
            "Install qdrant-client and implement QdrantRetrievalBackend."
        )
    elif backend_type == "chroma":
        raise NotImplementedError(
            "Chroma backend not yet implemented. "
            "Install chromadb and implement ChromaRetrievalBackend."
        )
    else:
        raise ValueError(f"Unknown backend type: {backend_type}")

# NIS Memory System

from core.memory.models import (
    Memory,
    MemoryStatus,
    MemoryType,
    ScopeType,
    SearchQuery,
    SearchResult,
    MemoryEvent,
    Scope,
    ControlRule,
    ControlRuleType,
    Proposal,
    EvidenceType,
    DeliveryPackage,
    SubAgentContext,
    EmbeddingProvider,
    RetrievalBackend,
)
from core.memory.store import MemoryStore, VersionConflictError, InvalidTransitionError

# ── 向量检索 = 可选能力（不是硬依赖）────────────────────────────────────────
# embedding.py / vector_index.py 都 `import numpy`。此前这里是 **eager** 导入：
# 环境里没有 numpy / sentence-transformers 时，整个 `core.memory` 包 import 直接炸，
# 连带 `core.memory.memory_graph`（记忆网图 / 记忆导出）等**与向量无关**的功能一起挂掉，
# 前端只能看到 "No module named 'numpy'"（用户实测：记忆导出失败）。
# 现在降级为条件导入：缺依赖时跳过，向量相关能力由调用方（memory_bridge._ensure_embedding）
# 自行 try/except 后回退 FTS 检索，其余功能完全不受影响。
try:
    from core.memory.vector_index import SqliteVectorIndex
    from core.memory.embedding import (
        HashingEmbedder,
        SentenceTransformerEmbedder,
        OpenAIEmbedder,
        create_embedder,
    )
    _VECTOR_DEPS_OK = True
    _VECTOR_DEPS_ERR = ""
except Exception as _exc:  # pragma: no cover - 仅在环境缺 numpy 等依赖时走到
    _VECTOR_DEPS_OK = False
    _VECTOR_DEPS_ERR = str(_exc)
    SqliteVectorIndex = None            # type: ignore[assignment]
    HashingEmbedder = None              # type: ignore[assignment]
    SentenceTransformerEmbedder = None  # type: ignore[assignment]
    OpenAIEmbedder = None               # type: ignore[assignment]
    create_embedder = None              # type: ignore[assignment]
from core.memory.project_memory import ProjectMemoryManager
from core.memory.global_memory import GlobalMemoryManager
from core.memory.session_logger import SessionLogger
from core.memory.memory_graph import MemoryGraph
from core.memory.distill import DistillEngine
from core.memory.storage_backend import StorageBackend, CacheBackend, ObjectStorage
from core.memory.sqlite_backend import SQLiteBackend
from core.memory.redis_cache import MemoryCacheBackend, RedisCacheBackend, create_cache_backend
from core.memory.object_storage import LocalObjectStorage, S3ObjectStorage, create_object_storage
from core.memory.plugin_manager import PluginManager, PluginInfo, PluginType, PluginStatus
from core.memory.mcp_expert import McpExpert, McpTask, McpResult
from core.memory.external_mcp import ExternalMcpServer, McpServerConfig, get_builtin_mcp_servers
from core.memory.mcp_plugin import McpPlugin, PluginRegistry
from core.memory.goal_mode import GoalMode, GoalCheckpoint, CheckpointManager, RetryConfig, RetryPolicy, SubGoal
from core.memory.audit import AuditLogger, AuditLog, PartnerStats, OverallStats
from core.memory.goal_tracker import GoalTracker, DriftResult
from core.memory.tool_risk import ToolRiskLevel, ToolRiskRule, ToolRiskManager, RiskCheckResult
from core.memory.task_template import TaskTemplate, TaskTemplateManager
from core.memory.alert import AlertSeverity, AlertRule, AlertEvent, AlertNotifier
from core.memory.monitoring import EventBroadcaster, DashboardAggregator, LogEvent, MetricsUpdate

__all__ = [
    "Memory",
    "MemoryStatus",
    "MemoryType",
    "ScopeType",
    "SearchQuery",
    "SearchResult",
    "MemoryEvent",
    "Scope",
    "ControlRule",
    "ControlRuleType",
    "Proposal",
    "EvidenceType",
    "DeliveryPackage",
    "SubAgentContext",
    "EmbeddingProvider",
    "RetrievalBackend",
    "MemoryStore",
    "VersionConflictError",
    "InvalidTransitionError",
    "SqliteVectorIndex",
    "HashingEmbedder",
    "SentenceTransformerEmbedder",
    "OpenAIEmbedder",
    "create_embedder",
    "ProjectMemoryManager",
    "GlobalMemoryManager",
    "SessionLogger",
    "MemoryGraph",
    "DistillEngine",
    "StorageBackend",
    "CacheBackend",
    "ObjectStorage",
    "SQLiteBackend",
    "MemoryCacheBackend",
    "RedisCacheBackend",
    "create_cache_backend",
    "LocalObjectStorage",
    "S3ObjectStorage",
    "create_object_storage",
    "PluginManager",
    "PluginInfo",
    "PluginType",
    "PluginStatus",
    "McpExpert",
    "McpTask",
    "McpResult",
    "ExternalMcpServer",
    "McpServerConfig",
    "get_builtin_mcp_servers",
    "McpPlugin",
    "PluginRegistry",
    "GoalMode",
    "GoalCheckpoint",
    "CheckpointManager",
    "RetryConfig",
    "RetryPolicy",
    "SubGoal",
    "AuditLogger",
    "AuditLog",
    "PartnerStats",
    "OverallStats",
    "GoalTracker",
    "DriftResult",
    "ToolRiskLevel",
    "ToolRiskRule",
    "ToolRiskManager",
    "RiskCheckResult",
    "TaskTemplate",
    "TaskTemplateManager",
    "AlertSeverity",
    "AlertRule",
    "AlertEvent",
    "AlertNotifier",
    "EventBroadcaster",
    "DashboardAggregator",
    "LogEvent",
    "MetricsUpdate",
]

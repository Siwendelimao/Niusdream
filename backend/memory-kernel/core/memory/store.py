"""NIS Memory System — MemoryStore Implementation (SQLite + FTS5)"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import uuid
from typing import Optional

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
    EmbeddingProvider,
    RetrievalBackend,
)
from core.memory.schema import init_db
from core.memory.state_machine import can_transition, is_searchable


class MemoryStore:
    """记忆存储实现（SQLite + FTS5 + 可选向量检索 Phase 5 + 缓存/对象存储 Phase 6）"""

    def __init__(
        self,
        db_path: str,
        embedding_provider: EmbeddingProvider = None,
        retrieval_backend: RetrievalBackend = None,
        auto_index: bool = False,
        cache: Any = None,
        object_storage: Any = None,
    ) -> None:
        self.db_path = db_path
        init_db(db_path)
        self._embedding_provider = embedding_provider
        self._retrieval_backend = retrieval_backend
        self._auto_index = auto_index
        self._cache = cache
        self._object_storage = object_storage

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
        except Exception:
            pass
        return conn

    @staticmethod
    def _gen_id(prefix: str = "mem") -> str:
        return f"{prefix}_{uuid.uuid4().hex[:12]}"

    # ── 作用域管理 ──────────────────────────────────

    def create_scope(self, scope_type: ScopeType, parent_id: str = None,
                     owner_id: str = None) -> Scope:
        # NIS_CORE 是全局根作用域，必须全局唯一：已存在则复用（避免每次重启新建导致记忆检索跨重启断开）
        if scope_type == ScopeType.NIS_CORE and not parent_id:
            conn = self._conn()
            row = conn.execute(
                "SELECT id FROM scopes WHERE scope_type='nis_core' AND parent_scope_id IS NULL "
                "ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            conn.close()
            if row:
                return Scope(
                    id=row["id"],
                    scope_type=scope_type,
                    parent_scope_id=None,
                    owner_id=owner_id,
                    created_at=time.time(),
                )
        scope = Scope(
            id=self._gen_id("scope"),
            scope_type=scope_type,
            parent_scope_id=parent_id,
            owner_id=owner_id,
            created_at=time.time(),
        )
        conn = self._conn()
        conn.execute(
            "INSERT INTO scopes (id, scope_type, owner_id, parent_scope_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (scope.id, scope.scope_type.value, scope.owner_id,
             scope.parent_scope_id, scope.status, scope.created_at),
        )
        conn.commit()
        conn.close()
        return scope

    def get_scope(self, scope_id: str) -> Optional[Scope]:
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM scopes WHERE id = ?", (scope_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return Scope(
            id=row["id"],
            scope_type=ScopeType(row["scope_type"]),
            owner_id=row["owner_id"],
            parent_scope_id=row["parent_scope_id"],
            status=row["status"],
            created_at=row["created_at"],
        )

    def _get_ancestor_scope_ids(self, scope_id: str) -> list:
        """获取作用域的所有祖先作用域 ID（使用递归 CTE 一次性查询）"""
        conn = self._conn()
        rows = conn.execute(
            """
            WITH RECURSIVE ancestors(id) AS (
                SELECT parent_scope_id FROM scopes WHERE id = ?
                UNION ALL
                SELECT s.parent_scope_id FROM scopes s
                INNER JOIN ancestors a ON s.id = a.id
                WHERE s.parent_scope_id IS NOT NULL
            )
            SELECT id FROM ancestors WHERE id IS NOT NULL
            """,
            (scope_id,)
        ).fetchall()
        conn.close()
        return [row[0] for row in rows]

    def can_access(self, memory_scope_id: str, query_scope_id: str) -> bool:
        """判断 query_scope 是否能访问 memory_scope 的记忆
        
        规则：
        - query_scope 可以访问自己作用域内的记忆
        - query_scope 可以访问祖先作用域的记忆（子可读父）
        - 不能访问兄弟或后代作用域的记忆
        """
        if memory_scope_id == query_scope_id:
            return True
        # 检查 memory_scope 是否是 query_scope 的祖先
        ancestor_ids = self._get_ancestor_scope_ids(query_scope_id)
        return memory_scope_id in ancestor_ids

    # ── 项目管理 ──────────────────────────────────

    def create_project(self, name: str, goal: str = None,
                       tech_stack: list = None,
                       parent_scope_id: str = None,
                       root_path: str = None,
                       knowledge_enabled: bool = False,
                       knowledge_top_k: int = 3,
                       knowledge_max_chars: int = 500) -> "Project":
        """创建项目（自动创建 project scope + .nis/ 目录）"""
        from core.memory.models import Project

        now = time.time()
        project_id = self._gen_id("proj")
        scope_id = self._gen_id("scope")

        conn = self._conn()
        # 创建 project scope
        conn.execute(
            "INSERT INTO scopes (id, scope_type, parent_scope_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (scope_id, ScopeType.PROJECT.value, parent_scope_id, "active", now),
        )
        # 创建项目记录
        conn.execute(
            """INSERT INTO projects (id, scope_id, name, status, goal,
               tech_stack, root_path, created_at, knowledge_enabled, knowledge_top_k, knowledge_max_chars)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (project_id, scope_id, name, "active", goal,
             _json_dump(tech_stack), root_path, now,
             int(knowledge_enabled), knowledge_top_k, knowledge_max_chars),
        )
        conn.commit()
        conn.close()

        # 自动创建 .nis/ 目录
        if root_path:
            from core.memory.project_memory import ProjectMemoryManager
            ProjectMemoryManager(root_path).ensure_exists(name, goal, tech_stack)

        return Project(
            id=project_id,
            scope_id=scope_id,
            name=name,
            status="active",
            goal=goal,
            tech_stack=tech_stack,
            root_path=root_path,
            created_at=now,
            knowledge_enabled=knowledge_enabled,
            knowledge_top_k=knowledge_top_k,
            knowledge_max_chars=knowledge_max_chars,
        )

    def get_project(self, project_id: str) -> "Project":
        """获取项目"""
        from core.memory.models import Project

        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return Project(
            id=row["id"],
            scope_id=row["scope_id"],
            name=row["name"],
            status=row["status"],
            goal=row["goal"],
            tech_stack=_json_load(row["tech_stack"]),
            current_phase=row["current_phase"],
            progress=row["progress"] or 0,
            root_path=row["root_path"],
            created_at=row["created_at"],
            archived_at=row["archived_at"],
            knowledge_enabled=bool(row["knowledge_enabled"]) if "knowledge_enabled" in row.keys() else False,
            knowledge_top_k=row["knowledge_top_k"] if "knowledge_top_k" in row.keys() else 3,
            knowledge_max_chars=row["knowledge_max_chars"] if "knowledge_max_chars" in row.keys() else 500,
        )

    def archive_project(self, project_id: str) -> bool:
        """归档项目"""
        conn = self._conn()
        cursor = conn.execute(
            "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = ?",
            (time.time(), project_id),
        )
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    # ── 项目成员管理 ──────────────────────────────────

    def set_project_member(self, project_id: str, partner_id: str,
                           enabled: bool = True,
                           added_by: str = "user",
                           reason: str = None) -> None:
        """添加/更新项目成员（存在则更新状态，不存在则插入）"""
        conn = self._conn()
        row = conn.execute(
            "SELECT 1 FROM project_partners WHERE project_id = ? AND partner_id = ?",
            (project_id, partner_id),
        ).fetchone()
        now = time.time()
        if row:
            conn.execute(
                "UPDATE project_partners SET enabled = ?, reason = COALESCE(?, reason), added_by = ? "
                "WHERE project_id = ? AND partner_id = ?",
                (int(enabled), reason, added_by, project_id, partner_id),
            )
        else:
            conn.execute(
                "INSERT INTO project_partners (project_id, partner_id, enabled, added_by, reason, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, partner_id, int(enabled), added_by, reason, now),
            )
        conn.commit()
        conn.close()

    def get_project_members(self, project_id: str) -> list[dict]:
        """获取项目成员名单（含启停状态）"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT partner_id, enabled, added_by, reason FROM project_partners "
            "WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
        conn.close()
        return [
            {
                "partner_id": r["partner_id"],
                "enabled": bool(r["enabled"]),
                "added_by": r["added_by"],
                "reason": r["reason"],
            }
            for r in rows
        ]

    def get_enabled_project_members(self, project_id: str) -> list[dict]:
        """仅返回已启用的成员（任务派发时筛人用）"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT partner_id, enabled, added_by, reason FROM project_partners "
            "WHERE project_id = ? AND enabled = 1 ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
        conn.close()
        return [
            {
                "partner_id": r["partner_id"],
                "enabled": True,
                "added_by": r["added_by"],
                "reason": r["reason"],
            }
            for r in rows
        ]

    def remove_project_member(self, project_id: str, partner_id: str) -> None:
        """移除项目成员"""
        conn = self._conn()
        conn.execute(
            "DELETE FROM project_partners WHERE project_id = ? AND partner_id = ?",
            (project_id, partner_id),
        )
        conn.commit()
        conn.close()

    def clear_project_members(self, project_id: str) -> None:
        """清空项目成员（删除项目时调用）"""
        conn = self._conn()
        conn.execute("DELETE FROM project_partners WHERE project_id = ?", (project_id,))
        conn.commit()
        conn.close()

    # ── 窗口管理 ──────────────────────────────────

    def create_window(self, project_id: str = None, title: str = "",
                      parent_scope_id: str = None) -> "Window":
        """创建窗口（自动创建 window scope）"""
        from core.memory.models import Window

        now = time.time()
        window_id = self._gen_id("win")
        scope_id = self._gen_id("scope")

        conn = self._conn()
        # 确定父作用域：优先使用项目 scope，否则使用传入的 parent_scope_id
        actual_parent = parent_scope_id
        if project_id:
            proj = conn.execute(
                "SELECT scope_id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if proj:
                actual_parent = proj["scope_id"]

        # 创建 window scope
        conn.execute(
            "INSERT INTO scopes (id, scope_type, parent_scope_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (scope_id, ScopeType.WINDOW.value, actual_parent, "active", now),
        )
        # 创建窗口记录
        conn.execute(
            "INSERT INTO windows (id, project_id, scope_id, title, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (window_id, project_id, scope_id, title, "active", now),
        )
        conn.commit()
        conn.close()

        return Window(
            id=window_id,
            project_id=project_id,
            scope_id=scope_id,
            title=title,
            status="active",
            created_at=now,
        )

    def get_window(self, window_id: str) -> "Window":
        """获取窗口"""
        from core.memory.models import Window

        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM windows WHERE id = ?", (window_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return Window(
            id=row["id"],
            project_id=row["project_id"],
            scope_id=row["scope_id"],
            title=row["title"],
            status=row["status"],
            state_json=_json_load(row["state_json"]),
            created_at=row["created_at"],
            closed_at=row["closed_at"],
        )

    def save_window_state(self, window_id: str, state: dict) -> None:
        """保存窗口状态（可恢复）"""
        conn = self._conn()
        conn.execute(
            "UPDATE windows SET state_json = ? WHERE id = ?",
            (_json_dump(state), window_id),
        )
        conn.commit()
        conn.close()

    def restore_window_state(self, window_id: str) -> dict:
        """恢复窗口状态"""
        conn = self._conn()
        row = conn.execute(
            "SELECT state_json FROM windows WHERE id = ?", (window_id,)
        ).fetchone()
        conn.close()
        return _json_load(row["state_json"]) if row else None

    def close_window(self, window_id: str, 
                     consolidate: bool = True) -> dict:
        """关闭窗口（可选提炼结论到项目记忆）"""
        conn = self._conn()
        now = time.time()

        # 获取窗口信息
        win = conn.execute(
            "SELECT * FROM windows WHERE id = ?", (window_id,)
        ).fetchone()
        if not win:
            conn.close()
            return {}

        # 提取值（在关闭连接前）
        win_project_id = win["project_id"]
        win_scope_id = win["scope_id"]

        # 更新状态
        conn.execute(
            "UPDATE windows SET status = 'closed', closed_at = ? WHERE id = ?",
            (now, window_id),
        )
        conn.commit()
        conn.close()

        result = {"window_id": window_id, "closed_at": now}

        # 提炼结论到项目记忆
        if consolidate and win_project_id:
            summary = self._consolidate_window(win_project_id, win_scope_id)
            result["consolidated_summary"] = summary

        return result

    def _consolidate_window(self, project_id: str, window_scope_id: str) -> str:
        """提炼窗口重要结论为项目事件"""
        conn = self._conn()
        rows = conn.execute(
            """SELECT content FROM memory_records
               WHERE scope_type = ? AND scope_id = ? AND status = 'active'
               ORDER BY importance DESC LIMIT 10""",
            (ScopeType.WINDOW.value, window_scope_id),
        ).fetchall()
        conn.close()

        if not rows:
            return ""

        # 使用 JSON 序列化避免分隔符歧义
        contents = [r["content"][:200] for r in rows]
        evidence_json = _json_dump(contents)
        summary = "; ".join(contents[:3])

        # 写入项目记忆
        proj = self.get_project(project_id)
        if proj:
            self.add(Memory(
                id="",
                scope_type=ScopeType.PROJECT,
                scope_id=proj.scope_id,
                memory_type=MemoryType.PROJECT_LESSON,
                content=f"窗口结论提炼: {summary[:500]}",
                structured_value={"evidence": contents},
                status=MemoryStatus.ACTIVE,
                source_type=EvidenceType.SYSTEM.value,
                created_by="nis",
            ))

        return summary

    def get_project_windows(self, project_id: str) -> list:
        """获取项目下所有窗口"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM windows WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()
        conn.close()
        from core.memory.models import Window
        return [Window(
            id=r["id"], project_id=r["project_id"], scope_id=r["scope_id"],
            title=r["title"], status=r["status"],
            state_json=_json_load(r["state_json"]),
            created_at=r["created_at"], closed_at=r["closed_at"],
        ) for r in rows]

    def load_project_context(self, project_id: str) -> dict:
        """加载项目上下文（新窗口打开时调用）"""
        project = self.get_project(project_id)
        if not project:
            return {}

        # 获取项目核心状态摘要
        conn = self._conn()
        snapshot = conn.execute(
            "SELECT * FROM project_state_snapshots WHERE project_id = ?",
            (project_id,),
        ).fetchone()

        # 获取项目相关记忆（最近 20 条 active）
        memories = conn.execute(
            """SELECT * FROM memory_records
               WHERE scope_type = ? AND scope_id = ? AND status = 'active'
               ORDER BY importance DESC, updated_at DESC LIMIT 20""",
            (ScopeType.PROJECT.value, project.scope_id),
        ).fetchall()
        conn.close()

        return {
            "project": project,
            "snapshot": _json_load(snapshot["summary_json"]) if snapshot else None,
            "recent_memories": [_row_to_memory(m) for m in memories],
        }

    def save_project_snapshot(self, project_id: str, summary: dict) -> None:
        """保存项目状态摘要"""
        conn = self._conn()
        conn.execute(
            """INSERT OR REPLACE INTO project_state_snapshots
               (project_id, summary_json, updated_at)
               VALUES (?, ?, ?)""",
            (project_id, _json_dump(summary), time.time()),
        )
        conn.commit()
        conn.close()

    # ── 记忆 CRUD ──────────────────────────────────

    def add(self, candidate: Memory, idempotency_key: str = None) -> Memory:
        """写入记忆（自动执行控制规则检查）"""
        # 控制规则检查
        rule = self.check_control_rules(
            candidate.content, candidate.memory_type, candidate.scope_type
        )
        if rule == ControlRuleType.DO_NOT_STORE:
            candidate.status = MemoryStatus.REJECTED
            return candidate
        elif rule == ControlRuleType.ALWAYS_CONFIRM:
            candidate.status = MemoryStatus.CANDIDATE
        elif rule == ControlRuleType.FORCED_SCOPE:
            # 强制限定作用域（根据规则目标）
            pass

        now = time.time()
        if not candidate.id:
            candidate.id = self._gen_id("mem")
        candidate.recorded_at = now
        candidate.created_at = now
        candidate.updated_at = now

        conn = self._conn()
        cols = [
            "id", "scope_type", "scope_id", "memory_type", "subtype", "content",
            "structured_value", "status", "confidence", "importance", "source_reliability",
            "valid_from", "valid_until", "observed_at", "recorded_at", "last_confirmed_at",
            "timezone", "time_precision", "temporal_source",
            "version", "supersedes", "superseded_by",
            "source_type", "source_event_ids", "source_window_id", "source_agent_id",
            "created_by", "approved_by", "user_override", "policy_lock",
            "tags", "search_keywords", "embedding_provider", "embedding_model",
            "embedding_dimensions", "embedding_version", "vector_id", "indexed_at",
            "reindex_status", "retention_policy", "closed_at", "archived_at",
            "searchable_after_close", "consolidation_eligible", "auto_purge_at",
            "created_at", "updated_at", "deleted_at",
        ]
        values = [
            candidate.id, candidate.scope_type.value, candidate.scope_id,
            candidate.memory_type.value, _safe_get(candidate, "subtype"),
            candidate.content,
            _json_dump(candidate.structured_value),
            candidate.status.value, candidate.confidence, candidate.importance,
            candidate.source_reliability,
            candidate.valid_from, candidate.valid_until, candidate.observed_at,
            candidate.recorded_at, candidate.last_confirmed_at,
            candidate.timezone, candidate.time_precision, candidate.temporal_source,
            candidate.version, candidate.supersedes, candidate.superseded_by,
            candidate.source_type,
            _json_dump(candidate.source_event_ids),
            candidate.source_window_id, candidate.source_agent_id,
            candidate.created_by, candidate.approved_by,
            int(candidate.user_override), int(candidate.policy_lock),
            _json_dump(candidate.tags),
            _safe_get(candidate, "search_keywords"),
            candidate.embedding_provider, candidate.embedding_model,
            candidate.embedding_dimensions, candidate.embedding_version,
            candidate.vector_id, candidate.indexed_at, candidate.reindex_status,
            candidate.retention_policy, candidate.closed_at, candidate.archived_at,
            int(candidate.searchable_after_close),
            int(candidate.consolidation_eligible), candidate.auto_purge_at,
            candidate.created_at, candidate.updated_at, candidate.deleted_at,
        ]
        placeholders = ",".join(["?"] * len(cols))
        conn.execute(
            f"INSERT INTO memory_records ({','.join(cols)}) VALUES ({placeholders})",
            values,
        )

        # 写入事件
        event = MemoryEvent(
            event_id=self._gen_id("evt"),
            event_type="MemoryCreated",
            memory_id=candidate.id,
            aggregate_id=candidate.id,
            aggregate_version=1,
            actor_type="system",
            actor_id=candidate.created_by,
            idempotency_key=idempotency_key,
            new_status=candidate.status.value,
            new_value=candidate.content,
            occurred_at=now,
        )
        self._write_event(conn, event)
        conn.commit()
        conn.close()

        # Phase 5: 自动索引
        if (self._auto_index and self._embedding_provider
                and self._retrieval_backend
                and candidate.status == MemoryStatus.ACTIVE):
            try:
                self.index_memory(candidate.id)
            except Exception:
                pass  # 索引失败不影响写入

        # Phase 6: 使缓存失效
        self.invalidate_context_cache(candidate.scope_type, candidate.scope_id)

        return candidate

    def get(self, memory_id: str) -> Optional[Memory]:
        """获取记忆"""
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM memory_records WHERE id = ?", (memory_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return _row_to_memory(row)

    def update(self, memory_id: str, changes: dict, expected_version: int,
               idempotency_key: str = None) -> Optional[Memory]:
        """更新记忆（乐观锁）"""
        memory = self.get(memory_id)
        if not memory:
            return None
        if memory.version != expected_version:
            raise VersionConflictError(
                f"Version conflict: expected {expected_version}, got {memory.version}"
            )

        now = time.time()
        new_version = memory.version + 1

        # 应用变更
        allowed_fields = {"content", "structured_value", "confidence", "importance",
                          "valid_until", "tags", "search_keywords",
                          "source_type", "last_confirmed_at", "user_override",
                          "supersedes", "superseded_by"}
        set_clauses = []
        params = []
        for key, value in changes.items():
            if key in allowed_fields:
                set_clauses.append(f"{key} = ?")
                if key in ("structured_value", "tags"):
                    params.append(_json_dump(value))
                else:
                    params.append(value)

        if not set_clauses:
            return memory

        set_clauses.append("version = ?")
        params.append(new_version)
        set_clauses.append("updated_at = ?")
        params.append(now)
        params.append(memory_id)
        params.append(expected_version)

        conn = self._conn()
        cursor = conn.execute(
            f"UPDATE memory_records SET {', '.join(set_clauses)} "
            f"WHERE id = ? AND version = ?",
            params,
        )
        if cursor.rowcount == 0:
            conn.close()
            raise VersionConflictError("Update failed: version conflict")

        # 写入事件
        event = MemoryEvent(
            event_id=self._gen_id("evt"),
            event_type="MemoryUpdated",
            memory_id=memory_id,
            aggregate_id=memory_id,
            aggregate_version=new_version,
            actor_type="system",
            actor_id="nis",
            idempotency_key=idempotency_key,
            previous_value=memory.content,
            new_value=changes.get("content", memory.content),
            occurred_at=now,
        )
        self._write_event(conn, event)
        conn.commit()
        conn.close()
        return self.get(memory_id)

    def change_state(self, memory_id: str, new_status: MemoryStatus,
                     reason: str = "") -> Optional[Memory]:
        """状态转换"""
        memory = self.get(memory_id)
        if not memory:
            return None
        if not can_transition(memory.status, new_status):
            raise InvalidTransitionError(
                f"Cannot transition from {memory.status} to {new_status}"
            )

        now = time.time()
        conn = self._conn()
        # 软删除/硬删除时设置 deleted_at
        if new_status in (MemoryStatus.SOFT_DELETED, MemoryStatus.HARD_DELETED):
            conn.execute(
                "UPDATE memory_records SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ?",
                (new_status.value, now, now, memory_id),
            )
        else:
            conn.execute(
                "UPDATE memory_records SET status = ?, updated_at = ? WHERE id = ?",
                (new_status.value, now, memory_id),
            )

        event = MemoryEvent(
            event_id=self._gen_id("evt"),
            event_type="MemoryStateChanged",
            memory_id=memory_id,
            aggregate_id=memory_id,
            aggregate_version=memory.version,
            actor_type="system",
            actor_id="nis",
            previous_status=memory.status.value,
            new_status=new_status.value,
            reason=reason,
            occurred_at=now,
        )
        self._write_event(conn, event)
        conn.commit()
        conn.close()
        return self.get(memory_id)

    # ── 检索 ──────────────────────────────────────

    def search(self, query: SearchQuery = None, text: str = "",
               scope_type: ScopeType = None, scope_id: str = None,
               memory_types: list = None, top_k: int = 10,
               time_filter: str = "current",
               mode: str = "auto") -> SearchResult:
        """混合检索（FTS5 + 可选向量检索）

        mode 参数：
          - "auto": 有向量后端时混合检索，否则仅 FTS5
          - "fts": 仅 FTS5 检索
          - "vector": 仅向量检索（需配置 embedding + backend）
          - "hybrid": FTS5 + 向量混合（需配置）
        """
        if query is None:
            query = SearchQuery(
                text=text, scope_type=scope_type, scope_id=scope_id,
                memory_types=memory_types, top_k=top_k, time_filter=time_filter,
            )

        start = time.time()
        has_vector = (
            self._embedding_provider is not None
            and self._retrieval_backend is not None
        )

        # 追踪是否发生降级
        degraded = False

        if mode == "fts":
            result = self._search_fts(query)
        elif mode == "vector":
            if has_vector:
                result = self._search_vector(query)
            else:
                # 降级：请求 vector 但无后端
                result = self._search_fts(query)
                degraded = True
        elif mode == "hybrid":
            if has_vector:
                result = self._search_hybrid(query)
            else:
                # 降级：请求 hybrid 但无后端
                result = self._search_fts(query)
                degraded = True
        else:  # auto
            if has_vector:
                result = self._search_hybrid(query)
            else:
                result = self._search_fts(query)

        # 关键：FTS 命中后按 重要性×新鲜度 重排（让旧/不重要的记忆不压过新/重要的）
        if result.retrieval_method == "fts":
            result.memories, result.scores = _rerank_by_importance_freshness(
                result.memories, result.scores,
            )

        elapsed = (time.time() - start) * 1000
        result.query_time_ms = elapsed
        # 标记降级信息
        if degraded:
            result.retrieval_method = f"{result.retrieval_method}_degraded"
        return result

    def _search_fts(self, query: SearchQuery) -> SearchResult:
        """FTS5 检索（原有逻辑）"""
        conn = self._conn()

        ancestor_ids = self._get_ancestor_scope_ids(query.scope_id)
        scope_placeholders = ",".join(["?"] * (len(ancestor_ids) + 1))
        conditions = [f"m.scope_id IN ({scope_placeholders})", "m.status = 'active'"]
        params: list = [query.scope_id] + ancestor_ids

        now = time.time()
        if query.time_filter == "current":
            conditions.append("(m.valid_until IS NULL OR m.valid_until > ?)")
            params.append(now)
            conditions.append("m.superseded_by IS NULL")

        if query.memory_types:
            placeholders = ",".join("?" * len(query.memory_types))
            conditions.append(f"m.memory_type IN ({placeholders})")
            params.extend([mt.value for mt in query.memory_types])

        where_clause = " AND ".join(conditions)
        normalized_query = _normalize_query(query.text)

        import re
        chinese_chars = re.findall(r'[\u4e00-\u9fff]', query.text)
        # 纯中文 ≤3 字走 LIKE：trigram 分词器对 2 字中文词（如"隔离"）无法 MATCH
        use_like_fallback = len(chinese_chars) > 0 and len(query.text.replace(" ", "")) <= 3

        if use_like_fallback:
            like_pattern = f"%{query.text}%"
            rows = conn.execute(
                f"""
                SELECT m.*, 1.0 as score
                FROM memory_records m
                WHERE m.content LIKE ? AND {where_clause}
                ORDER BY m.importance DESC
                LIMIT ?
                """,
                [like_pattern] + params + [query.top_k],
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT m.*, bm25(memory_fts) as score
                FROM memory_fts f
                JOIN memory_records m ON m.rowid = f.rowid
                WHERE memory_fts MATCH ? AND {where_clause}
                ORDER BY score
                LIMIT ?
                """,
                [normalized_query] + params + [query.top_k],
            ).fetchall()

        conn.close()
        memories = [_row_to_memory(row) for row in rows]
        scores = [-row["score"] for row in rows] if rows else []

        return SearchResult(
            memories=memories,
            scores=scores,
            retrieval_method="fts",
            total_candidates=len(memories),
            filtered_count=0,
        )

    def _search_vector(self, query: SearchQuery) -> SearchResult:
        """纯向量检索"""
        query_vector = self._embedding_provider.embed(query.text)
        ancestor_ids = self._get_ancestor_scope_ids(query.scope_id)
        scope_ids = [query.scope_id] + ancestor_ids

        vector_results = self._retrieval_backend.search(
            query_vector, scope_ids=scope_ids, top_k=query.top_k,
        )

        if not vector_results:
            return SearchResult(
                memories=[], scores=[], retrieval_method="vector",
                total_candidates=0, filtered_count=0,
            )

        memory_ids = [mid for mid, _ in vector_results]
        score_map = {mid: score for mid, score in vector_results}

        # 从数据库获取完整记忆
        conn = self._conn()
        placeholders = ",".join(["?"] * len(memory_ids))
        rows = conn.execute(
            f"""SELECT * FROM memory_records
                WHERE id IN ({placeholders}) AND status = 'active'
                ORDER BY importance DESC""",
            memory_ids,
        ).fetchall()
        conn.close()

        memories = []
        scores = []
        for row in rows:
            mem = _row_to_memory(row)
            memories.append(mem)
            scores.append(score_map.get(mem.id, 0.0))

        return SearchResult(
            memories=memories,
            scores=scores,
            retrieval_method="vector",
            total_candidates=len(memories),
            filtered_count=0,
        )

    def _search_hybrid(self, query: SearchQuery) -> SearchResult:
        """混合检索：FTS5 + 向量，加权融合"""
        # 扩大候选集
        extended_query = SearchQuery(
            text=query.text,
            scope_type=query.scope_type,
            scope_id=query.scope_id,
            memory_types=query.memory_types,
            top_k=query.top_k * 3,
            time_filter=query.time_filter,
        )

        fts_result = self._search_fts(extended_query)
        vector_result = self._search_vector(extended_query)

        # 加权融合（RRF: Reciprocal Rank Fusion）
        k = 60  # RRF 常数
        score_map: dict[str, float] = {}
        memory_map: dict[str, Memory] = {}

        for rank, (mem, score) in enumerate(zip(fts_result.memories, fts_result.scores)):
            rrf_score = 1.0 / (k + rank + 1)
            # FTS5 bm25 为负值，取绝对值归一化
            normalized_fts = 1.0 / (1.0 + abs(score))
            score_map[mem.id] = score_map.get(mem.id, 0.0) + rrf_score * normalized_fts
            memory_map[mem.id] = mem

        for rank, (mem, score) in enumerate(zip(vector_result.memories, vector_result.scores)):
            rrf_score = 1.0 / (k + rank + 1)
            score_map[mem.id] = score_map.get(mem.id, 0.0) + rrf_score * score
            if mem.id not in memory_map:
                memory_map[mem.id] = mem

        # 0914：时效 × 重要性轻混（混合路径也享用——此前重排只在 FTS 降级路径做，hybrid 缺）
        # blend = 相关度(归一) × 0.6 + importance × 新鲜度衰减 × 0.4
        # 目的：相关但"很旧/不重要"的记忆适度下沉；刚确认过/重要的适度上浮。
        now = time.time()
        max_s = max(score_map.values()) if score_map else 0.0
        if max_s <= 0:
            max_s = 1.0

        def _blend(mid: str) -> float:
            m = memory_map[mid]
            rel = score_map[mid] / max_s
            fr = _freshness_decay(
                getattr(m, "updated_at", None) or getattr(m, "recorded_at", None),
                60.0, now,
            )
            imp = getattr(m, "importance", 0.5) or 0.5
            return rel * 0.6 + imp * fr * 0.4

        sorted_ids = sorted(score_map.keys(), key=_blend, reverse=True)[:query.top_k]

        memories = [memory_map[mid] for mid in sorted_ids]
        scores = [round(_blend(mid), 6) for mid in sorted_ids]

        return SearchResult(
            memories=memories,
            scores=scores,
            retrieval_method="hybrid",
            total_candidates=len(score_map),
            filtered_count=max(0, len(score_map) - len(memories)),
        )

    # ── Phase 5: 向量索引管理 ──────────────────────

    def search_similar(self, text: str, scope_id: str, top_k: int = 20, min_score: float = 0.0) -> list:
        """语义相似检索：encode 文本 → 向量检索同 scope 的相似记忆，返回 [(memory_id, cosine_score)] 降序。

        供自动关联建边用：新记忆落库后查语义相近的已有记忆，>min_score 则连 related 边。
        向量索引里存的是 memory_records 的 id（= 星系节点的 md_section）。
        """
        if not self._embedding_provider or not self._retrieval_backend:
            return []
        try:
            query_vector = self._embedding_provider.embed(text)
            results = self._retrieval_backend.search(query_vector, scope_ids=[scope_id], top_k=top_k)
            return [(mid, score) for mid, score in results if score >= min_score]
        except Exception:
            return []

    def index_memory(self, memory_id: str) -> bool:
        """为单条记忆生成 embedding 并写入向量索引"""
        if not self._embedding_provider or not self._retrieval_backend:
            return False

        memory = self.get(memory_id)
        if not memory or memory.status != MemoryStatus.ACTIVE:
            return False

        vector = self._embedding_provider.embed(memory.content)
        self._retrieval_backend.upsert(memory_id, vector, scope_id=memory.scope_id)

        # 计算当前版本（与 reindex_all 保持一致）
        current_version = self._get_embedding_version()

        # 更新记忆元数据
        conn = self._conn()
        conn.execute(
            """UPDATE memory_records SET
                embedding_provider = ?, embedding_model = ?,
                embedding_dimensions = ?, embedding_version = ?,
                vector_id = ?, indexed_at = ?, reindex_status = 'indexed'
               WHERE id = ?""",
            (
                self._embedding_provider.__class__.__name__,
                self._embedding_provider.model_name,
                self._embedding_provider.dimensions,
                current_version,
                memory_id,
                time.time(),
                memory_id,
            ),
        )
        conn.commit()
        conn.close()
        return True

    def reindex_all(self, scope_type: ScopeType = None,
                    scope_id: str = None) -> int:
        """批量重建向量索引（带版本管理）"""
        if not self._embedding_provider or not self._retrieval_backend:
            return 0

        # 计算当前版本标识
        current_version = self._get_embedding_version()
        last_version = self._get_index_metadata("embedding_version")

        # 版本一致且已有索引时跳过
        if current_version == last_version and self._retrieval_backend.get_stats()["total_vectors"] > 0:
            return 0

        conn = self._conn()
        conditions = ["status = 'active'"]
        params: list = []

        if scope_type:
            conditions.append("scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("scope_id = ?")
            params.append(scope_id)

        where_clause = " AND ".join(conditions)
        rows = conn.execute(
            f"SELECT id, content, scope_id FROM memory_records WHERE {where_clause}",
            params,
        ).fetchall()
        conn.close()

        if not rows:
            return 0

        # 批量生成 embedding
        texts = [row["content"] for row in rows]
        vectors = self._embedding_provider.embed_batch(texts)

        # 批量写入向量索引
        items = [
            (row["id"], vec, row["scope_id"])
            for row, vec in zip(rows, vectors)
        ]
        count = self._retrieval_backend.bulk_upsert(items)

        # 更新元数据
        conn = self._conn()
        for row in rows:
            conn.execute(
                """UPDATE memory_records SET
                    embedding_provider = ?, embedding_model = ?,
                    embedding_dimensions = ?, embedding_version = ?,
                    vector_id = ?, indexed_at = ?, reindex_status = 'indexed'
                   WHERE id = ?""",
                (
                    self._embedding_provider.__class__.__name__,
                    self._embedding_provider.model_name,
                    self._embedding_provider.dimensions,
                    current_version,
                    row["id"],
                    time.time(),
                    row["id"],
                ),
            )
        conn.commit()
        conn.close()

        # 更新 index_metadata
        self._set_index_metadata("embedding_version", current_version)
        self._set_index_metadata("embedding_model", self._embedding_provider.model_name)
        self._set_index_metadata("embedding_dimensions", str(self._embedding_provider.dimensions))
        self._set_index_metadata("last_rebuild_at", str(time.time()))

        return count

    def _get_embedding_version(self) -> str:
        """计算当前 embedding 版本标识（基于 provider + model + dimensions）"""
        if not self._embedding_provider:
            return "none"
        raw = f"{self._embedding_provider.__class__.__name__}:{self._embedding_provider.model_name}:{self._embedding_provider.dimensions}"
        import hashlib
        return hashlib.md5(raw.encode()).hexdigest()[:8]

    def _get_index_metadata(self, key: str) -> Optional[str]:
        """读取 index_metadata"""
        conn = self._conn()
        row = conn.execute(
            "SELECT value FROM index_metadata WHERE key = ?", (key,)
        ).fetchone()
        conn.close()
        return row["value"] if row else None

    def _set_index_metadata(self, key: str, value: str) -> None:
        """写入 index_metadata"""
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO index_metadata (key, value, updated_at) VALUES (?, ?, ?)",
            (key, value, time.time()),
        )
        conn.commit()
        conn.close()

    def needs_reindex(self) -> bool:
        """检查是否需要重建索引（embedding 模型变更后）"""
        if not self._embedding_provider or not self._retrieval_backend:
            return False
        current_version = self._get_embedding_version()
        last_version = self._get_index_metadata("embedding_version")
        return current_version != last_version

    def remove_from_index(self, memory_id: str) -> bool:
        """从向量索引中移除"""
        if not self._retrieval_backend:
            return False
        self._retrieval_backend.delete(memory_id)
        return True

    def get_index_stats(self) -> dict:
        """获取向量索引统计"""
        if not self._retrieval_backend:
            return {"enabled": False}
        stats = self._retrieval_backend.get_stats()
        stats["enabled"] = True
        stats["auto_index"] = self._auto_index
        stats["embedding_model"] = (
            self._embedding_provider.model_name
            if self._embedding_provider else None
        )
        return stats

    def get_context(self, scope_type: ScopeType, scope_id: str,
                    window_id: str = None) -> list[Memory]:
        """获取当前上下文（Core Memory + 按需检索，带缓存）"""
        # 尝试缓存
        cached = self.get_cached_context(scope_type, scope_id)
        if cached is not None:
            return cached

        conn = self._conn()
        rows = conn.execute(
            """SELECT * FROM memory_records
               WHERE scope_type = ? AND scope_id = ? AND status = 'active'
               AND memory_type IN (?, ?, ?, ?, ?)
               ORDER BY importance DESC""",
            (scope_type.value, scope_id,
             MemoryType.IDENTITY.value, MemoryType.PERSONA.value,
             MemoryType.USER_PROFILE.value, MemoryType.PREFERENCE.value,
             MemoryType.COMMITMENT.value),
        ).fetchall()
        conn.close()

        memories = [_row_to_memory(row) for row in rows]

        # 写入缓存
        self.set_cached_context(scope_type, scope_id, memories)

        return memories

    # ── Phase 6: 缓存 + 对象存储 ──────────────────────

    def get_cached_context(self, scope_type: ScopeType, scope_id: str) -> Optional[list[Memory]]:
        """带缓存的 Core Memory 获取"""
        if not self._cache:
            return None

        cache_key = f"context:{scope_type.value}:{scope_id}"
        cached = self._cache.get(cache_key)
        if cached:
            try:
                import json
                data = json.loads(cached)
                return [self._dict_to_memory(m) for m in data]
            except Exception:
                pass
        return None

    def set_cached_context(self, scope_type: ScopeType, scope_id: str,
                           memories: list[Memory], ttl: int = 300) -> None:
        """缓存 Core Memory"""
        if not self._cache:
            return

        cache_key = f"context:{scope_type.value}:{scope_id}"
        import json
        data = json.dumps([self._memory_to_dict(m) for m in memories], ensure_ascii=False)
        self._cache.set(cache_key, data, ttl)

    def invalidate_context_cache(self, scope_type: ScopeType, scope_id: str) -> None:
        """使缓存失效"""
        if not self._cache:
            return
        cache_key = f"context:{scope_type.value}:{scope_id}"
        self._cache.delete(cache_key)

    def put_object(self, key: str, data: bytes) -> Optional[str]:
        """存储对象到对象存储"""
        if not self._object_storage:
            return None
        return self._object_storage.put(key, data)

    def get_object(self, key: str) -> Optional[bytes]:
        """从对象存储获取对象"""
        if not self._object_storage:
            return None
        return self._object_storage.get(key)

    def delete_object(self, key: str) -> bool:
        """从对象存储删除对象"""
        if not self._object_storage:
            return False
        return self._object_storage.delete(key)

    @staticmethod
    def _memory_to_dict(memory: Memory) -> dict:
        """Memory 对象转为字典（用于缓存序列化）
        
        包含所有可序列化字段，确保缓存回环不丢失数据。
        枚举类型转为字符串，列表/字典保持原样。
        """
        return {
            "id": memory.id,
            "scope_type": memory.scope_type.value,
            "scope_id": memory.scope_id,
            "memory_type": memory.memory_type.value,
            "content": memory.content,
            "status": memory.status.value,
            "confidence": memory.confidence,
            "importance": memory.importance,
            "source_reliability": memory.source_reliability,
            "structured_value": _json_dump(memory.structured_value),
            "valid_from": memory.valid_from,
            "valid_until": memory.valid_until,
            "observed_at": memory.observed_at,
            "recorded_at": memory.recorded_at,
            "last_confirmed_at": memory.last_confirmed_at,
            "timezone": memory.timezone,
            "time_precision": memory.time_precision,
            "temporal_source": memory.temporal_source,
            "version": memory.version,
            "supersedes": memory.supersedes,
            "superseded_by": memory.superseded_by,
            "source_type": memory.source_type,
            "source_event_ids": _json_dump(memory.source_event_ids),
            "source_window_id": memory.source_window_id,
            "source_agent_id": memory.source_agent_id,
            "created_by": memory.created_by,
            "approved_by": memory.approved_by,
            "user_override": int(memory.user_override),
            "policy_lock": int(memory.policy_lock),
            "tags": memory.tags,
            "embedding_provider": memory.embedding_provider,
            "embedding_model": memory.embedding_model,
            "embedding_dimensions": memory.embedding_dimensions,
            "embedding_version": memory.embedding_version,
            "vector_id": memory.vector_id,
            "indexed_at": memory.indexed_at,
            "reindex_status": memory.reindex_status,
            "retention_policy": memory.retention_policy,
            "closed_at": memory.closed_at,
            "archived_at": memory.archived_at,
            "searchable_after_close": int(memory.searchable_after_close),
            "consolidation_eligible": int(memory.consolidation_eligible),
            "auto_purge_at": memory.auto_purge_at,
            "created_at": memory.created_at,
            "updated_at": memory.updated_at,
            "deleted_at": memory.deleted_at,
        }

    @staticmethod
    def _dict_to_memory(data: dict) -> Memory:
        """从字典重建 Memory 对象（缓存反序列化）"""
        from core.memory.models import Memory, MemoryStatus, MemoryType, ScopeType
        return Memory(
            id=data.get("id", ""),
            scope_type=ScopeType(data.get("scope_type", "nis_core")),
            scope_id=data.get("scope_id", ""),
            memory_type=MemoryType(data.get("memory_type", "semantic")),
            content=data.get("content", ""),
            status=MemoryStatus(data.get("status", "active")),
            confidence=data.get("confidence", 0.8),
            importance=data.get("importance", 0.5),
            source_reliability=data.get("source_reliability", 0.8),
            structured_value=_json_load(data.get("structured_value")),
            valid_from=data.get("valid_from"),
            valid_until=data.get("valid_until"),
            observed_at=data.get("observed_at"),
            recorded_at=data.get("recorded_at", 0),
            last_confirmed_at=data.get("last_confirmed_at"),
            timezone=data.get("timezone", "Asia/Shanghai"),
            time_precision=data.get("time_precision", "exact"),
            temporal_source=data.get("temporal_source", "system_recorded"),
            version=data.get("version", 1),
            supersedes=data.get("supersedes"),
            superseded_by=data.get("superseded_by"),
            source_type=data.get("source_type"),
            source_event_ids=_json_load(data.get("source_event_ids")),
            source_window_id=data.get("source_window_id"),
            source_agent_id=data.get("source_agent_id"),
            created_by=data.get("created_by", ""),
            approved_by=data.get("approved_by"),
            user_override=bool(data.get("user_override", False)),
            policy_lock=bool(data.get("policy_lock", False)),
            tags=data.get("tags", []),
            embedding_provider=data.get("embedding_provider"),
            embedding_model=data.get("embedding_model"),
            embedding_dimensions=data.get("embedding_dimensions"),
            embedding_version=data.get("embedding_version"),
            vector_id=data.get("vector_id"),
            indexed_at=data.get("indexed_at"),
            reindex_status=data.get("reindex_status", "pending"),
            retention_policy=data.get("retention_policy", "default"),
            closed_at=data.get("closed_at"),
            archived_at=data.get("archived_at"),
            searchable_after_close=bool(data.get("searchable_after_close", False)),
            consolidation_eligible=bool(data.get("consolidation_eligible", True)),
            auto_purge_at=data.get("auto_purge_at"),
            created_at=data.get("created_at", 0),
            updated_at=data.get("updated_at", 0),
            deleted_at=data.get("deleted_at"),
        )

    # ── 事件日志 ──────────────────────────────────

    def _write_event(self, conn, event: MemoryEvent) -> None:
        conn.execute(
            """INSERT INTO memory_events (
                event_id, event_type, memory_id, aggregate_id, aggregate_version,
                idempotency_key, causation_id, correlation_id,
                actor_type, actor_id, previous_status, new_status,
                previous_value, new_value, reason, source_message_id, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event.event_id, event.event_type, event.memory_id,
                event.aggregate_id, event.aggregate_version,
                event.idempotency_key, event.causation_id, event.correlation_id,
                event.actor_type, event.actor_id, event.previous_status,
                event.new_status, event.previous_value, event.new_value,
                event.reason, event.source_message_id, event.occurred_at,
            ),
        )

    def get_events(self, memory_id: str) -> list[MemoryEvent]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM memory_events WHERE memory_id = ? ORDER BY occurred_at",
            (memory_id,),
        ).fetchall()
        conn.close()
        return [_row_to_event(row) for row in rows]

    # ── 候选提案审核 ──────────────────────────────────

    def get_candidates(
        self,
        scope_type: ScopeType = None,
        scope_id: str = None,
        status: MemoryStatus = MemoryStatus.CANDIDATE,
    ) -> list[Memory]:
        """获取候选记忆（待审核）"""
        conditions = ["m.status = ?"]
        params: list = [status.value]

        if scope_type:
            conditions.append("m.scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("m.scope_id = ?")
            params.append(scope_id)

        where_clause = " AND ".join(conditions)

        conn = self._conn()
        rows = conn.execute(
            f"""SELECT * FROM memory_records m WHERE {where_clause}
                ORDER BY m.confidence DESC""",
            params,
        ).fetchall()
        conn.close()
        return [_row_to_memory(row) for row in rows]

    def approve_candidate(self, memory_id: str, reviewer: str = "user") -> Optional[Memory]:
        """审核通过候选记忆"""
        return self._review_candidate(memory_id, MemoryStatus.ACTIVE, reviewer)

    def reject_candidate(self, memory_id: str, reviewer: str = "user",
                         reason: str = "") -> Optional[Memory]:
        """审核拒绝候选记忆"""
        return self._review_candidate(memory_id, MemoryStatus.REJECTED, reviewer)

    def _review_candidate(self, memory_id: str, new_status: MemoryStatus,
                          reviewer: str) -> Optional[Memory]:
        """审核候选记忆（通过状态机 + 事件日志）"""
        memory = self.get(memory_id)
        if not memory or memory.status != MemoryStatus.CANDIDATE:
            return None
        # 使用状态机转换（自动写事件日志）
        result = self.change_state(memory_id, new_status, reason=f"reviewed by {reviewer}")
        if result and new_status == MemoryStatus.ACTIVE:
            # 设置审批人
            conn = self._conn()
            conn.execute(
                "UPDATE memory_records SET approved_by = ? WHERE id = ?",
                (reviewer, memory_id),
            )
            conn.commit()
            conn.close()
            return self.get(memory_id)
        return result

    def get_memories_by_type(
        self,
        scope_type: ScopeType = None,
        scope_id: str = None,
        memory_types: list = None,
        status: str = "active",
        top_k: int = 50,
    ) -> list[Memory]:
        """按类型获取记忆（不使用 FTS5 文本搜索）"""
        conditions = ["status = ?"]
        params: list = [status]

        if scope_type:
            conditions.append("scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("scope_id = ?")
            params.append(scope_id)
        if memory_types:
            placeholders = ",".join(["?"] * len(memory_types))
            conditions.append(f"memory_type IN ({placeholders})")
            params.extend([mt.value for mt in memory_types])

        where_clause = " AND ".join(conditions)

        conn = self._conn()
        rows = conn.execute(
            f"""SELECT * FROM memory_records
                WHERE {where_clause}
                ORDER BY importance DESC, updated_at DESC
                LIMIT ?""",
            params + [top_k],
        ).fetchall()
        conn.close()
        return [_row_to_memory(row) for row in rows]

    def search_memories(
        self,
        text: str = None,
        scope_type: ScopeType = None,
        scope_id: str = None,
        memory_types: list = None,
        status: str = "active",
        top_k: int = 50,
    ) -> list[Memory]:
        """搜索记忆（使用 LIKE 子串匹配，不依赖 FTS5）"""
        conditions = ["status = ?"]
        params: list = [status]

        if text:
            conditions.append("content LIKE ?")
            params.append(f"%{text}%")
        if scope_type:
            conditions.append("scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("scope_id = ?")
            params.append(scope_id)
        if memory_types:
            placeholders = ",".join(["?"] * len(memory_types))
            conditions.append(f"memory_type IN ({placeholders})")
            params.extend([mt.value for mt in memory_types])

        where_clause = " AND ".join(conditions)

        conn = self._conn()
        rows = conn.execute(
            f"""SELECT * FROM memory_records
                WHERE {where_clause}
                ORDER BY importance DESC, updated_at DESC
                LIMIT ?""",
            params + [top_k],
        ).fetchall()
        conn.close()
        return [_row_to_memory(row) for row in rows]

    # ── 控制规则 ──────────────────────────────────

    def add_control_rule(self, rule: ControlRule) -> ControlRule:
        if not rule.id:
            rule.id = self._gen_id("rule")
        rule.created_at = time.time()
        conn = self._conn()
        conn.execute(
            """INSERT INTO memory_control_rules (
                id, rule_type, target_memory_type, target_subtype, target_key,
                pattern, semantic_condition, scope_type, priority, is_active,
                expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                rule.id, rule.rule_type.value, rule.target_memory_type,
                rule.target_subtype, rule.target_key, rule.pattern,
                rule.semantic_condition, rule.scope_type, rule.priority,
                int(rule.is_active), rule.expires_at, rule.created_at,
            ),
        )
        conn.commit()
        conn.close()
        return rule

    def check_control_rules(self, content: str, memory_type: MemoryType,
                            scope_type: ScopeType) -> Optional[ControlRuleType]:
        """检查内容是否命中控制规则，返回最高优先级的规则类型"""
        conn = self._conn()
        rows = conn.execute(
            """SELECT * FROM memory_control_rules
               WHERE is_active = 1
               ORDER BY priority DESC""",
        ).fetchall()
        conn.close()

        now = time.time()
        for row in rows:
            if row["expires_at"] and row["expires_at"] < now:
                continue
            if row["scope_type"] and row["scope_type"] != scope_type.value:
                continue
            if row["target_memory_type"] and row["target_memory_type"] != memory_type.value:
                continue
            if row["pattern"] and _match_pattern(row["pattern"], content):
                return ControlRuleType(row["rule_type"])
            if row["target_key"] and row["target_key"] in content:
                return ControlRuleType(row["rule_type"])
        return None

    # ── Phase 6: 数据管理与维护 ──────────────────────

    def export_data(self, scope_type: ScopeType = None,
                    scope_id: str = None) -> dict:
        """导出记忆数据（JSON 格式，供用户下载/备份）"""
        conn = self._conn()
        conditions = ["1=1"]
        params: list = []

        if scope_type:
            conditions.append("scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("scope_id = ?")
            params.append(scope_id)

        where_clause = " AND ".join(conditions)

        memories = conn.execute(
            f"SELECT * FROM memory_records WHERE {where_clause} ORDER BY created_at",
            params,
        ).fetchall()

        events = conn.execute(
            f"""SELECT e.* FROM memory_events e
                JOIN memory_records m ON e.memory_id = m.id
                WHERE {where_clause} ORDER BY e.occurred_at""",
            params,
        ).fetchall()

        scopes = conn.execute("SELECT * FROM scopes").fetchall()
        projects = conn.execute("SELECT * FROM projects").fetchall()
        windows = conn.execute("SELECT * FROM windows").fetchall()

        conn.close()

        return {
            "version": "1.0",
            "exported_at": time.time(),
            "memories": [dict(m) for m in memories],
            "events": [dict(e) for e in events],
            "scopes": [dict(s) for s in scopes],
            "projects": [dict(p) for p in projects],
            "windows": [dict(w) for w in windows],
        }

    def import_data(self, data: dict, overwrite: bool = False) -> dict:
        """导入记忆数据（从导出文件恢复）"""
        result = {"imported": 0, "skipped": 0, "errors": []}

        if not overwrite:
            existing = self.get_statistics()
            if existing["total_memories"] > 0:
                result["errors"].append("Database not empty. Use overwrite=True to replace.")
                return result

        for scope in data.get("scopes", []):
            try:
                conn = self._conn()
                conn.execute(
                    """INSERT OR IGNORE INTO scopes (id, scope_type, owner_id, parent_scope_id, status, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (scope["id"], scope["scope_type"], scope.get("owner_id"),
                     scope.get("parent_scope_id"), scope.get("status", "active"),
                     scope["created_at"]),
                )
                conn.commit()
                conn.close()
            except Exception as e:
                result["errors"].append(f"scope {scope.get('id')}: {e}")

        for proj in data.get("projects", []):
            try:
                conn = self._conn()
                conn.execute(
                    """INSERT OR IGNORE INTO projects (id, scope_id, name, status, goal, tech_stack, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (proj["id"], proj["scope_id"], proj["name"], proj.get("status", "active"),
                     proj.get("goal"), proj.get("tech_stack"), proj["created_at"]),
                )
                conn.commit()
                conn.close()
            except Exception as e:
                result["errors"].append(f"project {proj.get('id')}: {e}")

        for mem in data.get("memories", []):
            try:
                conn = self._conn()
                conn.execute(
                    """INSERT OR IGNORE INTO memory_records
                       (id, scope_type, scope_id, memory_type, content, status, confidence, importance,
                        source_type, created_by, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (mem["id"], mem["scope_type"], mem["scope_id"], mem["memory_type"],
                     mem["content"], mem.get("status", "active"), mem.get("confidence", 0.8),
                     mem.get("importance", 0.5), mem.get("source_type"), mem.get("created_by"),
                     mem["created_at"], mem.get("updated_at", mem["created_at"])),
                )
                conn.commit()
                conn.close()
                result["imported"] += 1
            except Exception as e:
                result["errors"].append(f"memory {mem.get('id')}: {e}")
                result["skipped"] += 1

        # 导入窗口
        for win in data.get("windows", []):
            try:
                conn = self._conn()
                conn.execute(
                    """INSERT OR IGNORE INTO windows (id, project_id, scope_id, title, status, state_json, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (win["id"], win.get("project_id"), win.get("scope_id"), win.get("title"),
                     win.get("status", "active"), win.get("state_json"), win["created_at"]),
                )
                conn.commit()
                conn.close()
            except Exception as e:
                result["errors"].append(f"window {win.get('id')}: {e}")

        # 导入事件日志
        for evt in data.get("events", []):
            try:
                conn = self._conn()
                conn.execute(
                    """INSERT OR IGNORE INTO memory_events
                       (event_id, event_type, memory_id, aggregate_id, aggregate_version,
                        idempotency_key, causation_id, correlation_id,
                        actor_type, actor_id, previous_status, new_status,
                        previous_value, new_value, reason, source_message_id, occurred_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (evt["event_id"], evt["event_type"], evt["memory_id"], evt["aggregate_id"],
                     evt.get("aggregate_version", 1), evt.get("idempotency_key"),
                     evt.get("causation_id"), evt.get("correlation_id"),
                     evt["actor_type"], evt["actor_id"], evt.get("previous_status"),
                     evt.get("new_status"), evt.get("previous_value"), evt.get("new_value"),
                     evt.get("reason"), evt.get("source_message_id"), evt["occurred_at"]),
                )
                conn.commit()
                conn.close()
            except Exception as e:
                result["errors"].append(f"event {evt.get('event_id')}: {e}")

        return result

    def get_statistics(self, scope_type: ScopeType = None,
                       scope_id: str = None) -> dict:
        """获取记忆统计信息"""
        conn = self._conn()
        conditions = ["1=1"]
        params: list = []

        if scope_type:
            conditions.append("scope_type = ?")
            params.append(scope_type.value)
        if scope_id:
            conditions.append("scope_id = ?")
            params.append(scope_id)

        where_clause = " AND ".join(conditions)

        total = conn.execute(
            f"SELECT COUNT(*) as cnt FROM memory_records WHERE {where_clause}", params
        ).fetchone()["cnt"]

        active = conn.execute(
            f"SELECT COUNT(*) as cnt FROM memory_records WHERE {where_clause} AND status = 'active'",
            params,
        ).fetchone()["cnt"]

        by_type = {}
        rows = conn.execute(
            f"""SELECT memory_type, COUNT(*) as cnt FROM memory_records
                WHERE {where_clause} GROUP BY memory_type""", params
        ).fetchall()
        for row in rows:
            by_type[row["memory_type"]] = row["cnt"]

        candidates = conn.execute(
            f"""SELECT COUNT(*) as cnt FROM memory_records
                WHERE {where_clause} AND status = 'candidate'""", params
        ).fetchone()["cnt"]

        expired = conn.execute(
            f"""SELECT COUNT(*) as cnt FROM memory_records
                WHERE {where_clause} AND status = 'active'
                AND valid_until IS NOT NULL AND valid_until < ?""",
            params + [time.time()],
        ).fetchone()["cnt"]

        deleted = conn.execute(
            f"""SELECT COUNT(*) as cnt FROM memory_records
                WHERE {where_clause} AND status = 'soft_deleted'""", params
        ).fetchone()["cnt"]

        conn.close()

        return {
            "total_memories": total,
            "active": active,
            "candidates": candidates,
            "expired": expired,
            "soft_deleted": deleted,
            "by_type": by_type,
        }

    def purge_deleted(self, days_old: int = 30) -> int:
        """清理超过恢复期的软删除记忆（硬删除，保留原始 deleted_at）"""
        cutoff = time.time() - (days_old * 86400)
        conn = self._conn()
        cursor = conn.execute(
            """UPDATE memory_records SET status = 'hard_deleted'
               WHERE status = 'soft_deleted' AND deleted_at < ?""",
            (cutoff,),
        )
        conn.commit()
        count = cursor.rowcount
        conn.close()
        return count

    def cleanup_expired(self) -> int:
        """清理过期记忆（标记为 expired）"""
        conn = self._conn()
        cursor = conn.execute(
            """UPDATE memory_records SET status = 'expired'
               WHERE status = 'active'
               AND valid_until IS NOT NULL AND valid_until < ?""",
            (time.time(),),
        )
        conn.commit()
        count = cursor.rowcount
        conn.close()
        return count

    def vacuum_old_events(self, keep_days: int = 90) -> int:
        """清理旧事件日志"""
        cutoff = time.time() - (keep_days * 86400)
        conn = self._conn()
        cursor = conn.execute(
            """DELETE FROM memory_events
               WHERE occurred_at < ?
               AND memory_id IN (
                   SELECT id FROM memory_records WHERE status = 'hard_deleted'
               )""",
            (cutoff,),
        )
        conn.commit()
        count = cursor.rowcount
        conn.close()
        return count

    # ── 遗忘机制：分层归档（Core 豁免；Hot/Warm/Cold 按活跃度） ──

    # Core 类型（用户身份/人格/基本偏好）：永不降级、永不归档、永不清理
    CORE_MEMORY_TYPES = ("identity", "persona", "user_profile")

    def memory_layer(self, mem: Memory) -> str:
        """分层判定：
        - core: identity/persona/user_profile（+高 importance 的 preference）→ 永活
        - hot: 最近 7 天活跃
        - warm: 最近 30 天活跃
        - cold: 30 天未访问 + importance 低 → 不参与默认检索，可归档
        """
        if mem.memory_type.value in self.CORE_MEMORY_TYPES:
            return "core"
        if mem.memory_type.value == "preference" and mem.importance >= 0.7:
            return "core"
        now = time.time()
        last_active = mem.last_confirmed_at or mem.updated_at or mem.created_at
        days = (now - last_active) / 86400
        if days <= 7:
            return "hot"
        if days <= 30:
            return "warm"
        return "cold"

    def archive_cold(self, min_importance: float = 0.3, max_count: int = 500) -> dict:
        """膨胀控制：active 记忆超阈值时，把 Cold 层低 importance 记忆标记为
        retention_policy='archive'（不再参与默认检索，保留数据可恢复）。"""
        conn = self._conn()
        total = conn.execute(
            "SELECT COUNT(*) FROM memory_records WHERE status = 'active'"
        ).fetchone()[0]
        if total <= max_count:
            conn.close()
            return {"archived": 0, "total": total, "below_threshold": True}

        cutoff = time.time() - 30 * 86400
        placeholders = ",".join("?" * len(self.CORE_MEMORY_TYPES))
        # ★0927 netfix：标准 sqlite3 无 SQLITE_ENABLE_UPDATE_DELETE_LIMIT → 原 UPDATE...LIMIT
        # 必抛 OperationalError（实测），archive_cold 从未生效、memory_maintenance 永远失败。
        # 改走 rowid 子查询（任何 sqlite 都支持），语义不变：只归档最旧的 200 条候选。
        cursor = conn.execute(
            f"""UPDATE memory_records
                SET retention_policy = 'archive', updated_at = ?
                WHERE rowid IN (
                    SELECT rowid FROM memory_records
                    WHERE status = 'active'
                      AND retention_policy != 'archive'
                      AND memory_type NOT IN ({placeholders})
                      AND importance < ?
                      AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)
                      AND (updated_at IS NULL OR updated_at < ?)
                    ORDER BY updated_at IS NOT NULL, updated_at ASC
                    LIMIT 200
                )""",
            (time.time(),) + self.CORE_MEMORY_TYPES + (min_importance, cutoff, cutoff),
        )
        conn.commit()
        count = cursor.rowcount
        conn.close()
        return {"archived": count, "total": total, "below_threshold": False}

    def maintenance(self) -> dict:
        """每日维护：清理软删/过期/旧事件 + 膨胀归档"""
        purged = self.purge_deleted(days_old=30)
        expired = self.cleanup_expired()
        vacuumed = self.vacuum_old_events(keep_days=90)
        archived = self.archive_cold()
        return {
            "purged_soft_deleted": purged,
            "expired": expired,
            "vacuumed_events": vacuumed,
            "archived_cold": archived,
        }


class VersionConflictError(Exception):
    pass


class InvalidTransitionError(Exception):
    pass


# ── 辅助函数 ──────────────────────────────────


def _safe_get(obj, attr, default=None):
    return getattr(obj, attr, default)


def _json_dump(value):
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _json_load(value):
    if value is None:
        return None
    return json.loads(value)


def _freshness_decay(updated_at: Optional[float], half_life_days: float = 60.0, now: Optional[float] = None) -> float:
    """新鲜度衰减系数：距最后更新越久，系数越小（0~1）。

    用于记忆排序降权——旧偏好/旧决策排后面，最近确认的排前面。
    半衰期：经过 half_life_days 天，权重降为 1/2。
    """
    if not updated_at:
        return 0.5
    now = now or time.time()
    days = max(0.0, (now - updated_at) / 86400.0)
    return 1.0 / (1.0 + days / half_life_days)


def _rerank_by_importance_freshness(memories: list, scores: list, half_life_days: float = 60.0) -> tuple:
    """按 重要性 × 新鲜度衰减 重新排序（FTS 命中后二次排序）。

    排序分 = bm25 相关度(归一化 0~1) × 0.5 + importance × 新鲜度 × 0.5，
    让"相关但旧/不重要"的记忆不压过"相关且重要/新鲜"的。
    """
    if not memories:
        return memories, scores
    now = time.time()
    ranked = []
    for i, m in enumerate(memories):
        raw_score = scores[i] if i < len(scores) else 0.0
        relevance = 1.0 / (1.0 + abs(raw_score))  # bm25 分数越小越相关（负数），近似归一
        freshness = _freshness_decay(getattr(m, "updated_at", None) or getattr(m, "recorded_at", None), half_life_days, now)
        importance = getattr(m, "importance", 0.5) or 0.5
        final = relevance * 0.5 + importance * freshness * 0.5
        ranked.append((final, i))
    ranked.sort(key=lambda x: x[0], reverse=True)
    new_memories = [memories[i] for _, i in ranked]
    new_scores = [scores[i] if i < len(scores) else 0.0 for _, i in ranked]
    return new_memories, new_scores


def _normalize_query(text: str) -> str:
    """规范化查询文本用于 FTS5（trigram 分词器）
    对每个词做 FTS5 转义（含特殊字符如 c++ / c# / a+b 等，避免语法报错），多词用 OR 连接。
    """
    if not text or text == "*":
        return text

    # FTS5 特殊字符：每个词用双引号包裹即可安全匹配字面量（含 + / * 等）
    def _quote_term(t: str) -> str:
        t = t.replace('"', '""')
        return f'"{t}"'

    words = text.split()
    if len(words) > 1:
        return " OR ".join(_quote_term(w) for w in words)
    return _quote_term(text)


def _match_pattern(pattern: str, text: str) -> bool:
    """简单的模式匹配"""
    import re
    try:
        return bool(re.search(pattern, text, re.IGNORECASE))
    except re.error:
        return pattern.lower() in text.lower()


def _row_to_memory(row) -> Memory:
    return Memory(
        id=row["id"],
        scope_type=ScopeType(row["scope_type"]),
        scope_id=row["scope_id"],
        memory_type=MemoryType(row["memory_type"]),
        content=row["content"],
        status=MemoryStatus(row["status"]),
        confidence=row["confidence"],
        importance=row["importance"],
        source_reliability=row["source_reliability"] or 0.8,
        structured_value=_json_load(row["structured_value"]),
        valid_from=row["valid_from"],
        valid_until=row["valid_until"],
        observed_at=row["observed_at"],
        recorded_at=row["recorded_at"],
        last_confirmed_at=row["last_confirmed_at"],
        timezone=row["timezone"] or "Asia/Shanghai",
        time_precision=row["time_precision"] or "exact",
        temporal_source=row["temporal_source"] or "system_recorded",
        version=row["version"],
        supersedes=row["supersedes"],
        superseded_by=row["superseded_by"],
        source_type=row["source_type"],
        source_event_ids=_json_load(row["source_event_ids"]),
        source_window_id=row["source_window_id"],
        source_agent_id=row["source_agent_id"],
        created_by=row["created_by"],
        approved_by=row["approved_by"],
        user_override=bool(row["user_override"]),
        policy_lock=bool(row["policy_lock"]),
        tags=_json_load(row["tags"]) or [],
        embedding_provider=row["embedding_provider"],
        embedding_model=row["embedding_model"],
        embedding_dimensions=row["embedding_dimensions"],
        embedding_version=row["embedding_version"],
        vector_id=row["vector_id"],
        indexed_at=row["indexed_at"],
        reindex_status=row["reindex_status"] or "pending",
        retention_policy=row["retention_policy"] or "default",
        closed_at=row["closed_at"],
        archived_at=row["archived_at"],
        searchable_after_close=bool(row["searchable_after_close"]),
        consolidation_eligible=bool(row["consolidation_eligible"]),
        auto_purge_at=row["auto_purge_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
    )

def _row_to_event(row) -> MemoryEvent:
    return MemoryEvent(
        event_id=row["event_id"],
        event_type=row["event_type"],
        memory_id=row["memory_id"],
        aggregate_id=row["aggregate_id"],
        aggregate_version=row["aggregate_version"],
        idempotency_key=row["idempotency_key"],
        causation_id=row["causation_id"],
        correlation_id=row["correlation_id"],
        actor_type=row["actor_type"],
        actor_id=row["actor_id"],
        previous_status=row["previous_status"],
        new_status=row["new_status"],
        previous_value=row["previous_value"],
        new_value=row["new_value"],
        reason=row["reason"],
        source_message_id=row["source_message_id"],
        occurred_at=row["occurred_at"],
    )

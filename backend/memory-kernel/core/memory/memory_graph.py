"""NIS Memory System — 记忆网图（节点/关系/搜索）"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Optional

from core.memory.store import MemoryStore


class MemoryGraph:
    """记忆节点/关系的 CRUD + 搜索"""

    def __init__(self, store: MemoryStore) -> None:
        self.store = store

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.store.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _gen_id(prefix: str = "mnode") -> str:
        return f"{prefix}_{uuid.uuid4().hex[:12]}"

    # ── 节点管理 ──────────────────────────────────

    def add_node(
        self,
        title: str,
        content: str,
        summary: str = "",
        node_type: str = "fact",
        scope: str = "project",
        project_id: str = None,
        tags: list = None,
        md_file: str = None,
        md_section: str = None,
        source_window: str = None,
        source_conversation: str = None,
        source_type: str = None,
    ) -> str:
        """添加记忆节点"""
        node_id = self._gen_id()
        now = time.time()

        conn = self._conn()
        conn.execute(
            """INSERT INTO memory_nodes (
                id, title, content, summary, node_type, scope, project_id,
                tags, enabled, md_file, md_section, source_window,
                source_conversation, source_type, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                node_id, title, content, summary or content[:200],
                node_type, scope, project_id,
                json.dumps(tags or [], ensure_ascii=False),
                1, md_file, md_section,
                source_window, source_conversation,
                source_type, now, now,
            ),
        )
        conn.commit()
        conn.close()
        return node_id

    def get_node(self, node_id: str) -> Optional[dict]:
        """获取记忆节点"""
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM memory_nodes WHERE id = ?", (node_id,)
        ).fetchone()
        conn.close()

        if not row:
            return None
        return self._row_to_node(row)

    def toggle_node(self, node_id: str, enabled: bool) -> bool:
        """停用/启用记忆节点"""
        conn = self._conn()
        cursor = conn.execute(
            "UPDATE memory_nodes SET enabled = ?, updated_at = ? WHERE id = ?",
            (1 if enabled else 0, time.time(), node_id),
        )
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    def delete_node(self, node_id: str) -> bool:
        """删除记忆节点（级联删除关系）"""
        conn = self._conn()
        conn.execute(
            "DELETE FROM memory_edges WHERE source_node = ? OR target_node = ?",
            (node_id, node_id),
        )
        cursor = conn.execute(
            "DELETE FROM memory_nodes WHERE id = ?", (node_id,)
        )
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    def update_node(self, node_id: str, **kwargs) -> bool:
        """更新记忆节点"""
        allowed = {"title", "content", "summary", "tags", "md_file", "md_section", "source_type"}
        set_clauses = []
        params = []
        for key, value in kwargs.items():
            if key in allowed:
                set_clauses.append(f"{key} = ?")
                if key == "tags":
                    params.append(json.dumps(value, ensure_ascii=False))
                else:
                    params.append(value)

        if not set_clauses:
            return False

        set_clauses.append("updated_at = ?")
        params.append(time.time())
        params.append(node_id)

        conn = self._conn()
        cursor = conn.execute(
            f"UPDATE memory_nodes SET {', '.join(set_clauses)} WHERE id = ?",
            params,
        )
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    def list_nodes(
        self,
        scope: str = None,
        node_type: str = None,
        project_id: str = None,
        enabled_only: bool = True,
    ) -> list[dict]:
        """列出记忆节点

        项目隔离：指定 project_id 时，scope='project' 的节点必须 project_id 精确匹配；
        未绑定项目的 project 节点（project_id 为空）只在"全部/全局"视图出现，不进任何项目专属视图，
        避免项目 A 的进度被项目 B 看到。
        """
        conditions = ["1=1"]
        params = []

        if scope and scope != "all":
            conditions.append("scope = ?")
            params.append(scope)
        if node_type:
            conditions.append("node_type = ?")
            params.append(node_type)
        if project_id:
            # 项目专属视图：全局节点都显示；项目节点必须匹配当前 project_id
            conditions.append("(scope != 'project' OR project_id = ?)")
            params.append(project_id)
        if enabled_only:
            conditions.append("enabled = 1")

        where_clause = " AND ".join(conditions)

        conn = self._conn()
        rows = conn.execute(
            f"SELECT * FROM memory_nodes WHERE {where_clause} ORDER BY created_at DESC",
            params,
        ).fetchall()
        conn.close()

        return [self._row_to_node(row) for row in rows]

    # ── 关系管理 ──────────────────────────────────

    def add_edge(self, source_id: str, target_id: str, relation: str = "related") -> str:
        """添加记忆关系"""
        edge_id = self._gen_id("medge")
        conn = self._conn()
        conn.execute(
            """INSERT INTO memory_edges (id, source_node, target_node, relation, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (edge_id, source_id, target_id, relation, time.time()),
        )
        conn.commit()
        conn.close()
        return edge_id

    def get_edges(self, node_id: str) -> list[dict]:
        """获取节点的所有关系"""
        conn = self._conn()
        rows = conn.execute(
            """SELECT * FROM memory_edges
               WHERE source_node = ? OR target_node = ?
               ORDER BY created_at""",
            (node_id, node_id),
        ).fetchall()
        conn.close()

        return [dict(row) for row in rows]

    def delete_edge(self, edge_id: str) -> bool:
        """删除关系"""
        conn = self._conn()
        cursor = conn.execute("DELETE FROM memory_edges WHERE id = ?", (edge_id,))
        conn.commit()
        conn.close()
        return cursor.rowcount > 0

    # ── 搜索 ──────────────────────────────────────

    @staticmethod
    def _escape_fts_query(query: str) -> str:
        """转义 FTS5 特殊字符，避免语法错误"""
        import re
        special_chars = r'[\*\:\^\"\'\(\)\[\]\{\}\-\+\!\@\~\\]'
        if re.search(special_chars, query):
            # 有 FTS5 特殊字符时，用双引号包裹并转义内部双引号
            escaped = query.replace('"', '""')
            return f'"{escaped}"'
        return query

    @staticmethod
    def _has_fts_special_chars(query: str) -> bool:
        """检查是否包含 FTS5 特殊字符"""
        import re
        return bool(re.search(r'[\*\:\^\"\'\(\)\[\]\{\}\-\+\!\@\~\\]', query))

    @staticmethod
    def _sanitize_for_like(query: str) -> str:
        """清理查询中的 LIKE 特殊字符（% _）和 FTS5 特殊字符"""
        import re
        # 移除所有 FTS5 特殊字符和 LIKE 通配符
        return re.sub(r'[\*\:\^\"\'\(\)\[\]\{\}\-\+\!\@\~\\%_]', '', query).strip()

    def search(
        self,
        query: str,
        scope: str = "all",
        node_type: str = None,
        limit: int = 20,
    ) -> list[dict]:
        """搜索记忆节点（FTS5 + 作用域过滤）"""
        conn = self._conn()

        import re
        chinese_chars = re.findall(r'[\u4e00-\u9fff]', query)
        short_chinese = len(chinese_chars) > 0 and len(query.replace(" ", "")) < 3
        has_special = self._has_fts_special_chars(query)

        # 短中文 或 含 FTS5 特殊字符 → 回退 LIKE（清理特殊字符）
        if short_chinese or has_special:
            sql = """SELECT *, 1.0 as score FROM memory_nodes
                     WHERE enabled = 1 AND (title LIKE ? OR summary LIKE ? OR tags LIKE ?)"""
            safe_query = self._sanitize_for_like(query)
            like_pattern = f"%{safe_query}%"
            params: list = [like_pattern, like_pattern, like_pattern]
        else:
            # FTS5 MATCH（已转义）
            safe_query = self._escape_fts_query(query)
            sql = """SELECT mn.*, -bm25(memory_nodes_fts) as score
                     FROM memory_nodes mn
                     JOIN memory_nodes_fts f ON mn.rowid = f.rowid
                     WHERE mn.enabled = 1 AND memory_nodes_fts MATCH ?"""
            params = [safe_query]

        if scope != "all":
            sql += " AND scope = ?"
            params.append(scope)
        if node_type:
            sql += " AND node_type = ?"
            params.append(node_type)

        sql += " ORDER BY score LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        conn.close()

        return [self._row_to_node(row) for row in rows]

    # ── 网图导出 ──────────────────────────────────

    def get_graph(self, scope: str = "all", project_id: str = None) -> dict:
        """导出完整网图（供前端渲染）。只显示启用节点（停用/重复合并的不再展示）。"""
        nodes = self.list_nodes(scope=scope, project_id=project_id, enabled_only=True)
        node_ids = [n["id"] for n in nodes]

        if not node_ids:
            return {"nodes": [], "edges": []}

        conn = self._conn()
        placeholders = ",".join(["?"] * len(node_ids))
        rows = conn.execute(
            f"""SELECT * FROM memory_edges
                WHERE source_node IN ({placeholders})
                OR target_node IN ({placeholders})""",
            node_ids + node_ids,
        ).fetchall()
        conn.close()

        edges = [dict(row) for row in rows]

        return {"nodes": nodes, "edges": edges}

    # ── 同步 .md → memory_nodes ──────────────────

    def sync_from_md(self, entries: list[dict], scope: str, project_id: str = None) -> int:
        """从 .md 文件条目同步到 memory_nodes 表"""
        count = 0
        for entry in entries:
            # 检查是否已存在（按 md_file + md_section）
            conn = self._conn()
            existing = conn.execute(
                "SELECT id FROM memory_nodes WHERE md_file = ? AND md_section = ?",
                (entry.get("md_file"), entry.get("md_section")),
            ).fetchone()
            conn.close()

            if existing:
                continue

            self.add_node(
                title=entry.get("title", ""),
                content=entry.get("content", ""),
                summary=entry.get("content", "")[:200],
                node_type="fact",
                scope=scope,
                project_id=project_id,
                md_file=entry.get("md_file"),
                md_section=entry.get("md_section"),
            )
            count += 1

        return count

    # ── 辅助 ──────────────────────────────────────

    def _row_to_node(self, row) -> dict:
        return {
            "id": row["id"],
            "title": row["title"],
            "content": row["content"],
            "summary": row["summary"],
            "node_type": row["node_type"],
            "scope": row["scope"],
            "project_id": row["project_id"],
            "tags": json.loads(row["tags"]) if row["tags"] else [],
            "enabled": bool(row["enabled"]),
            "md_file": row["md_file"],
            "md_section": row["md_section"],
            "source_window": row["source_window"],
            "source_conversation": row["source_conversation"],
            "source_type": row["source_type"] if "source_type" in row.keys() else None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

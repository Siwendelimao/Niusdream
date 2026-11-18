"""NIS Memory System — SQLite Vector Index (Phase 5)"""

from __future__ import annotations

import json
import math
import sqlite3
import struct
import time
from typing import Optional

import numpy as np

from core.memory.models import RetrievalBackend


# ── 向量编码/解码 ──────────────────────────────────


def _encode_vector(vec: list[float]) -> bytes:
    """将 float 列表编码为紧凑的 bytes（float32）"""
    return struct.pack(f"<{len(vec)}f", *vec)


def _decode_vector(data: bytes, dimensions: int) -> list[float]:
    """将 bytes 解码为 float 列表"""
    return list(struct.unpack(f"<{dimensions}f", data))


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """计算余弦相似度"""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ── SQLite 向量索引实现 ──────────────────────────────


class SqliteVectorIndex(RetrievalBackend):
    """基于 SQLite 的向量索引存储

    使用独立表 memory_vectors 存储 embedding，检索时加载到内存计算余弦相似度。
    适合万级以下记忆规模（Phase 5 目标）。
    """

    def __init__(self, db_path: str, dimensions: int) -> None:
        self._db_path = db_path
        self._dimensions = dimensions
        self._ensure_table()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_table(self) -> None:
        conn = self._conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS memory_vectors (
                memory_id       TEXT PRIMARY KEY,
                scope_id        TEXT NOT NULL,
                dimensions      INTEGER NOT NULL,
                vector_data     BLOB NOT NULL,
                created_at      REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_vectors_scope
            ON memory_vectors(scope_id)
        """)
        conn.commit()
        conn.close()

    @property
    def dimensions(self) -> int:
        return self._dimensions

    # ── RetrievalBackend 接口实现 ──────────────────

    def upsert(self, memory_id: str, vector: list[float],
               scope_id: str = None) -> None:
        """插入或更新向量"""
        if len(vector) != self._dimensions:
            raise ValueError(
                f"Vector dimension mismatch: expected {self._dimensions}, got {len(vector)}"
            )
        conn = self._conn()
        conn.execute(
            """INSERT OR REPLACE INTO memory_vectors
               (memory_id, scope_id, dimensions, vector_data, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (memory_id, scope_id, self._dimensions,
             _encode_vector(vector), time.time()),
        )
        conn.commit()
        conn.close()

    def delete(self, memory_id: str) -> None:
        """删除向量"""
        conn = self._conn()
        conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (memory_id,))
        conn.commit()
        conn.close()

    def search(
        self,
        query_vector: list[float],
        scope_ids: list[str],
        top_k: int = 10,
    ) -> list[tuple[str, float]]:
        """向量检索，返回 [(memory_id, score), ...] 按分数降序"""
        if not scope_ids:
            return []

        conn = self._conn()
        placeholders = ",".join(["?"] * len(scope_ids))
        rows = conn.execute(
            f"""SELECT memory_id, vector_data FROM memory_vectors
                WHERE scope_id IN ({placeholders})""",
            scope_ids,
        ).fetchall()
        conn.close()

        if not rows:
            return []

        query = np.array(query_vector, dtype=np.float32)
        results = []
        for row in rows:
            vec = np.array(_decode_vector(row["vector_data"], self._dimensions), dtype=np.float32)
            score = _cosine_similarity(query, vec)
            results.append((row["memory_id"], score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    def get_stats(self) -> dict:
        """返回索引统计信息"""
        conn = self._conn()
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM memory_vectors"
        ).fetchone()
        conn.close()
        return {
            "total_vectors": row["cnt"] if row else 0,
            "dimensions": self._dimensions,
            "backend": "sqlite",
        }

    # ── 批量操作 ──────────────────────────────────

    def bulk_upsert(self, items: list[tuple[str, list[float], str]]) -> int:
        """批量插入向量，返回插入数量"""
        conn = self._conn()
        now = time.time()
        count = 0
        for memory_id, vector, scope_id in items:
            if len(vector) != self._dimensions:
                continue
            conn.execute(
                """INSERT OR REPLACE INTO memory_vectors
                   (memory_id, scope_id, dimensions, vector_data, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (memory_id, scope_id, self._dimensions,
                 _encode_vector(vector), now),
            )
            count += 1
        conn.commit()
        conn.close()
        return count

    def get_vector(self, memory_id: str) -> Optional[list[float]]:
        """获取指定记忆的向量"""
        conn = self._conn()
        row = conn.execute(
            "SELECT vector_data FROM memory_vectors WHERE memory_id = ?",
            (memory_id,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        return _decode_vector(row["vector_data"], self._dimensions)

    def clear(self) -> int:
        """清空所有向量，返回删除数量"""
        conn = self._conn()
        row = conn.execute("SELECT COUNT(*) as cnt FROM memory_vectors").fetchone()
        count = row["cnt"] if row else 0
        conn.execute("DELETE FROM memory_vectors")
        conn.commit()
        conn.close()
        return count

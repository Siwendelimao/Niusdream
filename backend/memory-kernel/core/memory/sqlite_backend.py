"""NIS Memory System — SQLite 存储后端实现"""

from __future__ import annotations

import sqlite3
from typing import Any

from core.memory.storage_backend import StorageBackend


class SQLiteBackend(StorageBackend):
    """SQLite 存储后端"""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn: sqlite3.Connection = None

    def connect(self) -> None:
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row

    def disconnect(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        return self._conn.execute(sql, params)

    def executemany(self, sql: str, params_list: list) -> sqlite3.Cursor:
        return self._conn.executemany(sql, params_list)

    def executescript(self, sql: str) -> sqlite3.Cursor:
        return self._conn.executescript(sql)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def last_row_id(self) -> int:
        return self._conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    @property
    def backend_type(self) -> str:
        return "sqlite"

    @property
    def raw_connection(self) -> sqlite3.Connection:
        """返回原始 SQLite 连接（供特殊操作使用）"""
        return self._conn

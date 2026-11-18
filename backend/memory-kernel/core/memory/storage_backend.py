"""NIS Memory System — 存储后端抽象接口 (Phase 6)"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional


class StorageBackend(ABC):
    """存储后端抽象接口

    支持 SQLite（默认）和 PostgreSQL（大规模部署）切换。
    所有数据库操作通过此接口，后端可替换。
    """

    @abstractmethod
    def connect(self) -> None:
        """建立连接"""
        ...

    @abstractmethod
    def disconnect(self) -> None:
        """关闭连接"""
        ...

    @abstractmethod
    def execute(self, sql: str, params: tuple = ()) -> Any:
        """执行 SQL，返回游标"""
        ...

    @abstractmethod
    def executemany(self, sql: str, params_list: list) -> Any:
        """批量执行 SQL"""
        ...

    @abstractmethod
    def executescript(self, sql: str) -> Any:
        """执行多行 SQL 脚本"""
        ...

    @abstractmethod
    def commit(self) -> None:
        """提交事务"""
        ...

    @abstractmethod
    def rollback(self) -> None:
        """回滚事务"""
        ...

    @abstractmethod
    def last_row_id(self) -> int:
        """返回最后插入行的 rowid"""
        ...

    @property
    @abstractmethod
    def backend_type(self) -> str:
        """返回后端类型标识：'sqlite' | 'postgresql'"""
        ...


class CacheBackend(ABC):
    """缓存后端抽象接口（Redis / 内存）"""

    @abstractmethod
    def get(self, key: str) -> Optional[str]:
        """获取缓存值"""
        ...

    @abstractmethod
    def set(self, key: str, value: str, ttl: int = 300) -> None:
        """设置缓存值，ttl 单位秒"""
        ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """删除缓存"""
        ...

    @abstractmethod
    def exists(self, key: str) -> bool:
        """检查 key 是否存在"""
        ...

    @abstractmethod
    def clear(self) -> None:
        """清空缓存"""
        ...


class ObjectStorage(ABC):
    """对象存储抽象接口（本地文件系统 / S3 兼容）"""

    @abstractmethod
    def put(self, key: str, data: bytes) -> str:
        """存储对象，返回存储路径/URL"""
        ...

    @abstractmethod
    def get(self, key: str) -> Optional[bytes]:
        """获取对象"""
        ...

    @abstractmethod
    def delete(self, key: str) -> bool:
        """删除对象"""
        ...

    @abstractmethod
    def exists(self, key: str) -> bool:
        """检查对象是否存在"""
        ...

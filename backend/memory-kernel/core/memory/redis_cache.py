"""NIS Memory System — Redis 缓存层（带内存回退）"""

from __future__ import annotations

import json
import time
from typing import Optional

from core.memory.storage_backend import CacheBackend


class MemoryCacheBackend(CacheBackend):
    """纯内存缓存后端（Redis 不可用时的回退）"""

    def __init__(self) -> None:
        self._store: dict[str, tuple[str, float]] = {}  # key -> (value, expire_at)

    def get(self, key: str) -> Optional[str]:
        if key in self._store:
            value, expire_at = self._store[key]
            if expire_at > time.time():
                return value
            else:
                del self._store[key]
        return None

    def set(self, key: str, value: str, ttl: int = 300) -> None:
        self._store[key] = (value, time.time() + ttl)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def exists(self, key: str) -> bool:
        return self.get(key) is not None

    def clear(self) -> None:
        self._store.clear()


class RedisCacheBackend(CacheBackend):
    """Redis 缓存后端"""

    def __init__(self, host: str = "localhost", port: int = 6379,
                 db: int = 0, prefix: str = "nis:") -> None:
        self._host = host
        self._port = port
        self._db = db
        self._prefix = prefix
        self._client = None
        self._fallback = MemoryCacheBackend()

    def _ensure_connected(self) -> bool:
        """确保 Redis 连接可用"""
        if self._client is not None:
            return True
        try:
            import redis
            self._client = redis.Redis(
                host=self._host, port=self._port, db=self._db,
                socket_timeout=2, decode_responses=True,
            )
            self._client.ping()
            return True
        except Exception:
            self._client = None
            return False

    def _prefixed(self, key: str) -> str:
        return f"{self._prefix}{key}"

    def get(self, key: str) -> Optional[str]:
        if not self._ensure_connected():
            return self._fallback.get(key)
        try:
            return self._client.get(self._prefixed(key))
        except Exception:
            return self._fallback.get(key)

    def set(self, key: str, value: str, ttl: int = 300) -> None:
        if not self._ensure_connected():
            self._fallback.set(key, value, ttl)
            return
        try:
            self._client.setex(self._prefixed(key), ttl, value)
        except Exception:
            self._fallback.set(key, value, ttl)

    def delete(self, key: str) -> None:
        if self._ensure_connected():
            try:
                self._client.delete(self._prefixed(key))
            except Exception:
                pass
        self._fallback.delete(key)

    def exists(self, key: str) -> bool:
        if not self._ensure_connected():
            return self._fallback.exists(key)
        try:
            return bool(self._client.exists(self._prefixed(key)))
        except Exception:
            return self._fallback.exists(key)

    def clear(self) -> None:
        if self._ensure_connected():
            try:
                keys = self._client.keys(f"{self._prefix}*")
                if keys:
                    self._client.delete(*keys)
            except Exception:
                pass
        self._fallback.clear()


def create_cache_backend(
    backend: str = "memory",
    **kwargs,
) -> CacheBackend:
    """创建缓存后端

    Args:
        backend: "memory" | "redis"
        **kwargs: Redis 连接参数（host, port, db）
    """
    if backend == "redis":
        return RedisCacheBackend(**kwargs)
    return MemoryCacheBackend()

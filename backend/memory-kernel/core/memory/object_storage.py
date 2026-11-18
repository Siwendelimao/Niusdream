"""NIS Memory System — 对象存储接口（本地文件系统 / S3 兼容）"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import Optional

from core.memory.storage_backend import ObjectStorage


class LocalObjectStorage(ObjectStorage):
    """本地文件系统对象存储"""

    def __init__(self, base_dir: str = None) -> None:
        if not base_dir:
            base_dir = os.path.join(os.path.expanduser("~"), ".nis", "objects")
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path_for(self, key: str) -> Path:
        """根据 key 生成存储路径（按前 2 字符分目录，避免单目录文件过多）"""
        prefix = hashlib.md5(key.encode()).hexdigest()[:2]
        dir_path = self._base / prefix
        dir_path.mkdir(exist_ok=True)
        return dir_path / key

    def put(self, key: str, data: bytes) -> str:
        """存储对象，返回存储路径"""
        path = self._path_for(key)
        path.write_bytes(data)
        return str(path)

    def get(self, key: str) -> Optional[bytes]:
        """获取对象"""
        path = self._path_for(key)
        if path.exists():
            return path.read_bytes()
        return None

    def delete(self, key: str) -> bool:
        """删除对象"""
        path = self._path_for(key)
        if path.exists():
            path.unlink()
            return True
        return False

    def exists(self, key: str) -> bool:
        """检查对象是否存在"""
        return self._path_for(key).exists()


class S3ObjectStorage(ObjectStorage):
    """S3 兼容对象存储（预留接口）"""

    def __init__(self, bucket: str, endpoint: str = None,
                 access_key: str = None, secret_key: str = None) -> None:
        self._bucket = bucket
        self._endpoint = endpoint
        self._access_key = access_key
        self._secret_key = secret_key
        self._client = None

    def _ensure_client(self) -> bool:
        if self._client is not None:
            return True
        try:
            import boto3
            self._client = boto3.client(
                "s3",
                endpoint_url=self._endpoint,
                aws_access_key_id=self._access_key,
                aws_secret_access_key=self._secret_key,
            )
            return True
        except Exception:
            return False

    def put(self, key: str, data: bytes) -> str:
        if not self._ensure_client():
            raise ConnectionError(
                f"S3 client not available. Failed to store object: {key}"
            )
        try:
            self._client.put_object(Bucket=self._bucket, Key=key, Body=data)
        except Exception as e:
            raise ConnectionError(
                f"Failed to store object to S3: {key}. Error: {e}"
            ) from e
        return f"s3://{self._bucket}/{key}"

    def get(self, key: str) -> Optional[bytes]:
        if not self._ensure_client():
            return None
        try:
            resp = self._client.get_object(Bucket=self._bucket, Key=key)
            return resp["Body"].read()
        except Exception:
            return None

    def delete(self, key: str) -> bool:
        if self._ensure_client():
            try:
                self._client.delete_object(Bucket=self._bucket, Key=key)
                return True
            except Exception:
                return False
        return False

    def exists(self, key: str) -> bool:
        if self._ensure_client():
            try:
                self._client.head_object(Bucket=self._bucket, Key=key)
                return True
            except Exception:
                return False
        return False


def create_object_storage(
    backend: str = "local",
    **kwargs,
) -> ObjectStorage:
    """创建对象存储后端

    Args:
        backend: "local" | "s3"
        **kwargs: S3 连接参数（bucket, endpoint, access_key, secret_key）
    """
    if backend == "s3":
        return S3ObjectStorage(**kwargs)
    return LocalObjectStorage(kwargs.get("base_dir"))

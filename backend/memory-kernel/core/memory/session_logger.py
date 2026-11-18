"""NIS Memory System — 对话自动记录"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Optional


class SessionLogger:
    """每轮对话自动保存到 sessions/YYYY-MM-DD.md"""

    def __init__(self, sessions_dir: str, broadcaster: Any = None) -> None:
        self.sessions_dir = Path(sessions_dir)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._broadcaster = broadcaster

    def log_turn(self, user_msg: str, assistant_msg: str,
                 timestamp: float = None) -> None:
        """追加一轮对话到当天的 session 文件"""
        if timestamp is None:
            timestamp = time.time()

        filepath = self._get_today_file()
        time_str = time.strftime("%H:%M:%S", time.localtime(timestamp))

        entry = (
            f"## [{time_str}] User\n\n"
            f"{user_msg}\n\n"
            f"## [{time_str}] Assistant\n\n"
            f"{assistant_msg}\n\n"
            f"---\n\n"
        )

        with open(filepath, "a", encoding="utf-8") as f:
            f.write(entry)

        self._push_event(
            sender="Session",
            avatar="💬",
            action=f"对话: {user_msg[:60]}",
            status="success",
            timestamp=timestamp,
        )

    def log_distillation(self, title: str, content: str,
                         node_type: str, timestamp: float = None) -> None:
        """记录一次提炼操作"""
        if timestamp is None:
            timestamp = time.time()

        filepath = self._get_today_file()
        time_str = time.strftime("%H:%M:%S", time.localtime(timestamp))

        entry = (
            f"## [{time_str}] 提炼 [{node_type}]\n"
            f"**{title}**\n\n"
            f"{content}\n\n"
            f"---\n\n"
        )

        with open(filepath, "a", encoding="utf-8") as f:
            f.write(entry)

        self._push_event(
            sender="Distiller",
            avatar="🧪",
            action=f"提炼: {title[:60]}",
            status="success",
            timestamp=timestamp,
        )

    def _push_event(self, sender: str, avatar: str, action: str,
                    status: str, timestamp: float) -> None:
        if self._broadcaster is None:
            return
        from core.memory.monitoring import LogEvent
        event = LogEvent(
            task_id="session",
            round_num=0,
            sender=sender,
            avatar=avatar,
            action=action,
            status=status,
            timestamp=timestamp,
        )
        try:
            self._broadcaster.send_log_event(event)
        except Exception:
            pass

    def _get_today_file(self) -> Path:
        """获取今天的 session 文件路径"""
        date_str = time.strftime("%Y-%m-%d")
        return self.sessions_dir / f"{date_str}.md"

    def get_recent_files(self, n: int = 2) -> list[Path]:
        """获取最近 n 天的 session 文件"""
        files = sorted(self.sessions_dir.glob("*.md"), reverse=True)
        return files[:n]

    def get_file_for_date(self, date_str: str) -> Optional[Path]:
        """获取指定日期的 session 文件"""
        filepath = self.sessions_dir / f"{date_str}.md"
        return filepath if filepath.exists() else None

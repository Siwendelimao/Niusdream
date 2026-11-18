from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

WsBroadcaster = Callable[[dict], Awaitable[None]]


@dataclass
class LogEvent:
    task_id: str
    round_num: int
    sender: str
    avatar: str
    action: str
    status: str
    duration_ms: int = 0
    token_input: int = 0
    token_output: int = 0
    timestamp: float = 0.0
    memory_hits: int = 0
    background: bool = False
    memory_details: list = field(default_factory=list)
    critic_verdict: str = ""
    critic_issues: list = field(default_factory=list)
    critic_hint: str = ""
    drift_score: float = 0.0
    drift_detail: str = ""
    error_type: str = ""
    error_message: str = ""
    retry_count: int = 0
    max_retries: int = 3
    stuck_reason: str = ""
    stuck_detail: str = ""
    stuck_suggestions: list = field(default_factory=list)
    circuit_open: bool = False
    circuit_recovery_seconds: int = 0

    def to_dict(self) -> dict:
        return {
            "type": "LOG_EVENT",
            "timestamp": self.timestamp,
            "task_id": self.task_id,
            "round": self.round_num,
            "sender": self.sender,
            "avatar": self.avatar,
            "action": self.action,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "token_input": self.token_input,
            "token_output": self.token_output,
            "memory_hits": self.memory_hits,
            "memory_details": self.memory_details,
            "critic_verdict": self.critic_verdict,
            "critic_issues": self.critic_issues,
            "critic_hint": self.critic_hint,
            "drift_score": self.drift_score,
            "drift_detail": self.drift_detail,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "stuck_reason": self.stuck_reason,
            "stuck_detail": self.stuck_detail,
            "stuck_suggestions": self.stuck_suggestions,
            "circuit_open": self.circuit_open,
            "circuit_recovery_seconds": self.circuit_recovery_seconds,
            "background": self.background,
        }


@dataclass
class MetricsUpdate:
    goal_progress: str = ""
    active_partner: str = ""
    active_avatar: str = ""
    total_calls: int = 0
    success_rate: float = 0.0
    alert_count: int = 0
    token_total: int = 0
    token_rate: float = 0.0
    system_health: str = "healthy"
    circuit_breaker: str = "closed"
    drift_score: float = 0.0
    timestamp: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": "METRICS_UPDATE",
            "timestamp": self.timestamp,
            "goal_progress": self.goal_progress,
            "active_partner": self.active_partner,
            "active_avatar": self.active_avatar,
            "total_calls": self.total_calls,
            "success_rate": self.success_rate,
            "alert_count": self.alert_count,
            "token_total": self.token_total,
            "token_rate": self.token_rate,
            "system_health": self.system_health,
            "circuit_breaker": self.circuit_breaker,
            "drift_score": self.drift_score,
        }


class DashboardAggregator:
    def __init__(
        self,
        audit_logger: Any = None,
        alert_notifier: Any = None,
        goal_mode: Any = None,
        usage_storage: Any = None,
    ) -> None:
        self._audit = audit_logger
        self._alerts = alert_notifier
        self._goal_mode = goal_mode
        self._usage_storage = usage_storage

    def get_dashboard_data(self) -> dict:
        metrics = self.get_metrics()
        metrics["partner_stats"] = self.get_partner_stats()
        return metrics

    def get_metrics(self) -> dict:
        metrics = MetricsUpdate(timestamp=time.time())

        if self._audit:
            stats = self._audit.get_overall_stats()
            metrics.total_calls = stats.total_calls
            metrics.success_rate = stats.success_rate
            metrics.token_total = 0

        if self._alerts:
            metrics.alert_count = len(self._alerts.get_history())

        metrics.system_health = self._calc_health(metrics)
        return metrics.to_dict()

    def get_partner_stats(self) -> dict:
        if not self._audit:
            return {}
        return self._audit.get_overall_stats().by_partner

    def get_hourly_trend(self, hours: int = 24) -> list:
        """获取按小时聚合的 Token 消耗趋势。"""
        if self._usage_storage is None:
            return []
        return self._usage_storage.get_hourly_trend(hours)

    def get_history(self, hours: int = 24) -> list:
        return []

    def _calc_health(self, metrics: MetricsUpdate) -> str:
        if metrics.total_calls == 0:
            return "healthy"
        if metrics.alert_count > 5 or metrics.success_rate < 0.7:
            return "critical"
        if metrics.alert_count > 2 or metrics.success_rate < 0.85:
            return "warning"
        return "healthy"
        if metrics.alert_count > 5 or metrics.success_rate < 0.7:
            return "critical"
        if metrics.alert_count > 2 or metrics.success_rate < 0.85:
            return "warning"
        return "healthy"


class EventBroadcaster:
    def __init__(self) -> None:
        self._ws: Optional[WsBroadcaster] = None
        self._sync_handler: Optional[Callable[[LogEvent], None]] = None

    def set_ws_broadcaster(self, ws: WsBroadcaster) -> None:
        self._ws = ws

    def set_sync_handler(self, handler: Callable[[LogEvent], None]) -> None:
        self._sync_handler = handler

    def send_log_event(self, event: LogEvent) -> None:
        if self._sync_handler is not None:
            self._sync_handler(event)
        if self._ws is not None:
            import asyncio
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self._ws(event.to_dict()))
            except RuntimeError:
                pass
            except Exception:
                pass

    async def broadcast_log_event(self, event: LogEvent) -> None:
        if self._ws is None:
            return
        try:
            await self._ws(event.to_dict())
        except Exception:
            logger.warning("广播日志事件失败: %s", event.action)

    async def broadcast_metrics(self, metrics: MetricsUpdate) -> None:
        if self._ws is None:
            return
        try:
            await self._ws(metrics.to_dict())
        except Exception:
            logger.warning("广播指标更新失败")

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class AlertSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class AlertRule:
    name: str
    condition: str
    severity: AlertSeverity
    message_template: str
    enabled: bool = True
    cooldown_seconds: float = 60.0
    last_triggered_at: float = 0.0

    def should_trigger(self, now: float = None) -> bool:
        if not self.enabled:
            return False
        now = now or time.time()
        return (now - self.last_triggered_at) >= self.cooldown_seconds

    def mark_triggered(self) -> None:
        self.last_triggered_at = time.time()


@dataclass
class AlertEvent:
    alert_id: str
    rule_name: str
    severity: AlertSeverity
    message: str
    created_at: float = 0.0
    metadata: dict = field(default_factory=dict)


class AlertNotifier:
    def __init__(self, broadcaster: Any = None) -> None:
        self._rules: dict[str, AlertRule] = {}
        self._history: list[AlertEvent] = []
        self._callbacks: list[Callable[[AlertEvent], Any]] = []
        self._broadcaster = broadcaster
        self._register_defaults()

    def _register_defaults(self) -> None:
        defaults = [
            AlertRule(
                name="goal_failed",
                condition="goal_status == 'failed'",
                severity=AlertSeverity.ERROR,
                message_template="目标执行失败：{goal_id}（{completed}/{total} 步）",
                cooldown_seconds=0,
            ),
            AlertRule(
                name="step_timeout",
                condition="step_duration > 300",
                severity=AlertSeverity.WARNING,
                message_template="步骤执行超时：{step_index}（{duration_ms}ms）",
                cooldown_seconds=30,
            ),
            AlertRule(
                name="high_drift",
                condition="drift_score > 0.7",
                severity=AlertSeverity.WARNING,
                message_template="目标漂移预警：{detail}",
                cooldown_seconds=60,
            ),
            AlertRule(
                name="circuit_open",
                condition="circuit_breaker_open == True",
                severity=AlertSeverity.CRITICAL,
                message_template="熔断器已打开，目标 {goal_id} 暂停执行",
                cooldown_seconds=0,
            ),
        ]
        for rule in defaults:
            self._rules[rule.name] = rule

    def register_rule(self, rule: AlertRule) -> None:
        self._rules[rule.name] = rule

    def register_callback(self, callback: Callable[[AlertEvent], Any]) -> None:
        self._callbacks.append(callback)

    def check_and_fire(self, rule_name: str, context: dict = None) -> Optional[AlertEvent]:
        rule = self._rules.get(rule_name)
        if not rule or not rule.should_trigger():
            return None

        message = rule.message_template.format(**(context or {}))
        event = AlertEvent(
            alert_id=f"alert_{uuid.uuid4().hex[:12]}",
            rule_name=rule_name,
            severity=rule.severity,
            message=message,
            created_at=time.time(),
            metadata=context or {},
        )
        rule.mark_triggered()
        self._history.append(event)

        for cb in self._callbacks:
            try:
                cb(event)
            except Exception:
                pass

        self._push_alert_event(event, context)
        return event

    def _push_alert_event(self, event: AlertEvent, context: dict = None) -> None:
        if self._broadcaster is None:
            return
        from core.memory.monitoring import LogEvent
        severity_to_status = {
            "info": "success",
            "warning": "warning",
            "error": "fail",
            "critical": "circuit",
        }
        log_event = LogEvent(
            task_id=context.get("goal_id", "") if context else "",
            round_num=context.get("step_index", 0) if context else 0,
            sender="System",
            avatar="🔔",
            action=event.message,
            status=severity_to_status.get(event.severity.value, "warning"),
            timestamp=event.created_at,
            drift_score=context.get("drift_score", 0.0) if context else 0.0,
            drift_detail=context.get("detail", "") if context else "",
            circuit_open=(event.rule_name == "circuit_open"),
            stuck_detail=context.get("detail", "") if context else "",
            stuck_suggestions=context.get("suggestions", []) if context else [],
        )
        self._broadcaster.send_log_event(log_event)

    def get_history(self, limit: int = 50) -> list[AlertEvent]:
        return self._history[-limit:]

    def clear_history(self) -> None:
        self._history.clear()

    def list_rules(self) -> list[AlertRule]:
        return list(self._rules.values())

"""NIS Memory System — Goal 模式（全链路管控）

面向终极目标的全链路执行模式：
- 确定终极目标 → 拆解子目标 → 制定计划 → 确认 → 执行到底
- 每步验证 + Checkpoint 断点续传 + 重试/熔断
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


# ── 配置 ──────────────────────────────────────────

@dataclass
class RetryConfig:
    """重试 + 熔断配置"""
    max_retries_per_method: int = 2      # 单方法重试 ≤2 次
    max_total_failures: int = 5           # 总失败 ≤5 次停止
    backoff_base: float = 1.0            # 退避基数（秒）
    backoff_multiplier: float = 2.0      # 退避倍数
    circuit_breaker_threshold: int = 5   # 熔断阈值
    circuit_breaker_timeout: float = 30  # 熔断恢复时间（秒）
    step_timeout: float = 300            # 每步超时（秒）


# ── Checkpoint ────────────────────────────────────

@dataclass
class GoalCheckpoint:
    """目标执行断点"""
    goal_id: str
    goal_description: str
    current_step: int = 0
    total_steps: int = 0
    completed_steps: list[int] = field(default_factory=list)
    failed_steps: list[int] = field(default_factory=list)
    state: dict = field(default_factory=dict)
    status: str = "pending"  # pending / running / paused / completed / failed
    created_at: float = 0.0
    updated_at: float = 0.0
    error_message: str = ""

    def to_dict(self) -> dict:
        return {
            "goal_id": self.goal_id,
            "goal_description": self.goal_description,
            "current_step": self.current_step,
            "total_steps": self.total_steps,
            "completed_steps": json.dumps(self.completed_steps),
            "failed_steps": json.dumps(self.failed_steps),
            "state": json.dumps(self.state, ensure_ascii=False),
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error_message": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: dict) -> GoalCheckpoint:
        return cls(
            goal_id=data["goal_id"],
            goal_description=data["goal_description"],
            current_step=data["current_step"],
            total_steps=data["total_steps"],
            completed_steps=json.loads(data["completed_steps"]),
            failed_steps=json.loads(data["failed_steps"]),
            state=json.loads(data["state"]),
            status=data["status"],
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            error_message=data.get("error_message", ""),
        )


class CheckpointManager:
    """Checkpoint 持久化（SQLite）"""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._ensure_table()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_table(self) -> None:
        conn = self._conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS goal_checkpoints (
                goal_id              TEXT PRIMARY KEY,
                goal_description     TEXT NOT NULL,
                current_step         INTEGER DEFAULT 0,
                total_steps          INTEGER DEFAULT 0,
                completed_steps      TEXT DEFAULT '[]',
                failed_steps         TEXT DEFAULT '[]',
                state                TEXT DEFAULT '{}',
                status               TEXT DEFAULT 'pending',
                created_at           REAL NOT NULL,
                updated_at           REAL NOT NULL,
                error_message        TEXT DEFAULT ''
            )
        """)
        conn.commit()
        conn.close()

    def save(self, checkpoint: GoalCheckpoint) -> None:
        """保存 checkpoint"""
        conn = self._conn()
        conn.execute(
            """INSERT OR REPLACE INTO goal_checkpoints (
                goal_id, goal_description, current_step, total_steps,
                completed_steps, failed_steps, state, status,
                created_at, updated_at, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                checkpoint.goal_id,
                checkpoint.goal_description,
                checkpoint.current_step,
                checkpoint.total_steps,
                json.dumps(checkpoint.completed_steps),
                json.dumps(checkpoint.failed_steps),
                json.dumps(checkpoint.state, ensure_ascii=False),
                checkpoint.status,
                checkpoint.created_at,
                checkpoint.updated_at,
                checkpoint.error_message,
            ),
        )
        conn.commit()
        conn.close()

    def load(self, goal_id: str) -> Optional[GoalCheckpoint]:
        """加载 checkpoint"""
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM goal_checkpoints WHERE goal_id = ?",
            (goal_id,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        return GoalCheckpoint.from_dict(dict(row))

    def list_all(self) -> list[GoalCheckpoint]:
        """列出所有 checkpoint"""
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM goal_checkpoints ORDER BY updated_at DESC"
        ).fetchall()
        conn.close()
        return [GoalCheckpoint.from_dict(dict(row)) for row in rows]

    def delete(self, goal_id: str) -> bool:
        """删除 checkpoint"""
        conn = self._conn()
        cursor = conn.execute(
            "DELETE FROM goal_checkpoints WHERE goal_id = ?",
            (goal_id,),
        )
        conn.commit()
        conn.close()
        return cursor.rowcount > 0


# ── 子目标 ────────────────────────────────────────

@dataclass
class SubGoal:
    """子目标定义"""
    index: int
    description: str
    verify: Optional[Callable[[], bool]] = None
    verify_description: str = ""


# ── 重试策略 ──────────────────────────────────────

class RetryPolicy:
    """重试 + 退避 + 熔断"""

    def __init__(self, config: RetryConfig = None) -> None:
        self._config = config or RetryConfig()
        self._total_failures = 0
        self._method_retries: dict[str, int] = {}
        self._circuit_open = False
        self._circuit_opened_at: float = 0.0

    def can_retry(self, method: str = "default") -> bool:
        """检查是否可以重试"""
        # 检查总失败次数
        if self._total_failures >= self._config.max_total_failures:
            return False
        # 检查熔断器
        if self._circuit_open:
            if time.time() - self._circuit_opened_at < self._config.circuit_breaker_timeout:
                return False
            else:
                # 熔断恢复
                self._circuit_open = False
                self._total_failures = 0  # 重置失败计数
        # 检查单方法重试次数
        method_retries = self._method_retries.get(method, 0)
        if method_retries > self._config.max_retries_per_method:
            return False
        return True

    def record_failure(self, method: str = "default") -> None:
        """记录失败"""
        self._total_failures += 1
        self._method_retries[method] = self._method_retries.get(method, 0) + 1
        # 检查是否触发熔断
        if self._total_failures >= self._config.circuit_breaker_threshold:
            self._circuit_open = True
            self._circuit_opened_at = time.time()

    def record_success(self, method: str = "default") -> None:
        """记录成功（重置方法重试计数）"""
        self._method_retries.pop(method, None)

    def get_backoff_time(self, attempt: int) -> float:
        """获取退避等待时间"""
        return self._config.backoff_base * (self._config.backoff_multiplier ** attempt)

    @property
    def total_failures(self) -> int:
        return self._total_failures

    @property
    def is_circuit_open(self) -> bool:
        return self._circuit_open


# ── Goal 模式 ─────────────────────────────────────

class GoalMode:
    """目标模式执行引擎"""

    def __init__(
        self,
        db_path: str,
        retry_config: RetryConfig = None,
        alert_notifier: Any = None,
        broadcaster: Any = None,
    ) -> None:
        self._checkpoint_mgr = CheckpointManager(db_path)
        self._retry_config = retry_config or RetryConfig()
        self._alert_notifier = alert_notifier
        self._broadcaster = broadcaster

    @staticmethod
    def _gen_id() -> str:
        return f"goal_{uuid.uuid4().hex[:12]}"

    async def execute(
        self,
        goal_description: str,
        sub_goals: list[SubGoal],
        execute_fn: Callable[[SubGoal], bool],
        goal_id: str = None,
        resume: bool = False,
    ) -> GoalCheckpoint:
        """执行目标

        Args:
            goal_description: 目标描述
            sub_goals: 子目标列表
            execute_fn: 执行函数，接收 SubGoal 返回是否成功
            goal_id: 目标 ID（resume 时使用）
            resume: 是否从断点恢复

        Returns:
            GoalCheckpoint: 最终状态
        """
        now = time.time()

        # 恢复或创建 checkpoint
        if resume and goal_id:
            checkpoint = self._checkpoint_mgr.load(goal_id)
            if not checkpoint:
                raise ValueError(f"Checkpoint not found: {goal_id}")
            checkpoint.status = "running"
        else:
            checkpoint = GoalCheckpoint(
                goal_id=self._gen_id(),
                goal_description=goal_description,
                total_steps=len(sub_goals),
                status="running",
                created_at=now,
                updated_at=now,
            )

        retry_policy = RetryPolicy(self._retry_config)

        # 执行子目标
        for i, sub_goal in enumerate(sub_goals):
            # 跳过已完成的
            if i in checkpoint.completed_steps:
                continue

            # 防模式锁定：每 10 步换一种序列化格式
            sub_goal = self._rotate_step_format(sub_goal)

            checkpoint.current_step = i
            checkpoint.updated_at = time.time()

            # 检查熔断器
            if retry_policy.is_circuit_open:
                self._fire_alert("circuit_open", {"goal_id": checkpoint.goal_id})
                checkpoint.status = "failed"
                checkpoint.error_message = "Circuit breaker is open"
                checkpoint.updated_at = time.time()
                self._checkpoint_mgr.save(checkpoint)
                return checkpoint

            step_start = time.time()

            # 执行子目标
            success = await self._execute_sub_goal(
                sub_goal, execute_fn, retry_policy
            )

            step_duration = time.time() - step_start

            # 超时告警
            if step_duration > self._retry_config.step_timeout:
                self._fire_alert("step_timeout", {
                    "step_index": i,
                    "duration_ms": int(step_duration * 1000),
                })

            if success:
                checkpoint.completed_steps.append(i)
                checkpoint.failed_steps = [
                    f for f in checkpoint.failed_steps if f != i
                ]
                self._push_step_event(checkpoint, i, "success", step_duration)
            else:
                checkpoint.failed_steps.append(i)
                checkpoint.status = "failed"
                checkpoint.error_message = f"Step {i} failed after retries"
                checkpoint.updated_at = time.time()
                self._checkpoint_mgr.save(checkpoint)
                self._push_step_event(checkpoint, i, "fail", step_duration, retry_policy)
                if retry_policy.is_circuit_open:
                    self._fire_alert("circuit_open", {"goal_id": checkpoint.goal_id})
                self._fire_alert("goal_failed", {
                    "goal_id": checkpoint.goal_id,
                    "completed": len(checkpoint.completed_steps),
                    "total": checkpoint.total_steps,
                })
                return checkpoint

            # 保存 checkpoint
            checkpoint.updated_at = time.time()
            self._checkpoint_mgr.save(checkpoint)

        # 全部完成
        checkpoint.status = "completed"
        checkpoint.updated_at = time.time()
        self._checkpoint_mgr.save(checkpoint)
        return checkpoint

    def _fire_alert(self, rule_name: str, context: dict = None) -> None:
        if self._alert_notifier:
            self._alert_notifier.check_and_fire(rule_name, context)

    def _push_log_event(self, event: Any) -> None:
        if self._broadcaster is None:
            return
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self._broadcaster.broadcast_log_event(event))
        except Exception:
            pass

    def _push_step_event(
        self,
        checkpoint: Any,
        step_index: int,
        status: str,
        duration: float,
        retry_policy: Any = None,
    ) -> None:
        from core.memory.monitoring import LogEvent
        event = LogEvent(
            task_id=checkpoint.goal_id,
            round_num=step_index,
            sender="System",
            avatar="✅" if status == "success" else "❌",
            action=f"Step {step_index}",
            status=status,
            duration_ms=int(duration * 1000),
            timestamp=time.time(),
            retry_count=retry_policy.total_failures if retry_policy else 0,
            circuit_open=retry_policy.is_circuit_open if retry_policy else False,
        )
        self._push_log_event(event)

    @staticmethod
    def _rotate_step_format(sub_goal: SubGoal) -> SubGoal:
        if not sub_goal.description:
            return sub_goal
        from agents.anti_pattern import serialize_step
        new_desc = serialize_step(sub_goal.index, sub_goal.description)
        return SubGoal(
            index=sub_goal.index,
            description=new_desc,
            verify=sub_goal.verify,
            verify_description=sub_goal.verify_description,
        )

    async def _execute_sub_goal(
        self,
        sub_goal: SubGoal,
        execute_fn: Callable[[SubGoal], Any],
        retry_policy: RetryPolicy,
    ) -> bool:
        """执行单个子目标（含重试）"""
        method = f"step_{sub_goal.index}"
        attempt = 0

        while retry_policy.can_retry(method):
            try:
                # 执行（支持 sync 和 async）
                result = execute_fn(sub_goal)
                if hasattr(result, "__await__"):
                    result = await result
                success = bool(result)

                if success:
                    # 验证
                    if sub_goal.verify:
                        verify_result = sub_goal.verify()
                        if hasattr(verify_result, "__await__"):
                            verify_result = await verify_result
                        if verify_result:
                            retry_policy.record_success(method)
                            return True
                        else:
                            logger.warning(
                                "Step %d verification failed", sub_goal.index
                            )
                    else:
                        retry_policy.record_success(method)
                        return True
                else:
                    logger.warning("Step %d execution failed", sub_goal.index)

            except Exception as e:
                logger.error("Step %d exception: %s", sub_goal.index, e)

            # 记录失败
            retry_policy.record_failure(method)
            attempt += 1

            # 退避等待
            if retry_policy.can_retry(method):
                wait_time = retry_policy.get_backoff_time(attempt)
                logger.info("Retrying step %d in %.1fs...", sub_goal.index, wait_time)
                await asyncio.sleep(wait_time)

        return False

    def get_checkpoint(self, goal_id: str) -> Optional[GoalCheckpoint]:
        """获取 checkpoint"""
        return self._checkpoint_mgr.load(goal_id)

    def list_checkpoints(self) -> list[GoalCheckpoint]:
        """列出所有 checkpoint"""
        return self._checkpoint_mgr.list_all()

    def pause(self, goal_id: str) -> bool:
        """暂停目标执行"""
        checkpoint = self._checkpoint_mgr.load(goal_id)
        if checkpoint:
            checkpoint.status = "paused"
            checkpoint.updated_at = time.time()
            self._checkpoint_mgr.save(checkpoint)
            return True
        return False

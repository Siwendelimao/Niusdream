from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AuditLog:
    audit_id: str
    partner_name: str
    action: str
    input_summary: str
    output_summary: str
    success: bool
    duration_ms: int
    error_message: str = ""
    goal_id: str = ""
    step_index: int = -1
    token_input: int = 0
    token_output: int = 0
    created_at: float = 0.0
    memory_hits: int = 0
    drift_score: float = 0.0
    drift_detail: str = ""
    critic_verdict: str = ""
    critic_issues: list = None
    critic_hint: str = ""
    retry_count: int = 0
    background: bool = False

    def __post_init__(self):
        if self.critic_issues is None:
            self.critic_issues = []


@dataclass
class PartnerStats:
    partner_name: str
    total: int = 0
    success: int = 0
    success_rate: float = 0.0
    avg_duration_ms: float = 0.0


@dataclass
class OverallStats:
    total_calls: int = 0
    success_rate: float = 0.0
    avg_duration_ms: float = 0.0
    by_partner: dict = field(default_factory=dict)


_AUDIT_SQL = """
CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id        TEXT PRIMARY KEY,
    partner_name    TEXT NOT NULL,
    action          TEXT NOT NULL,
    input_summary   TEXT DEFAULT '',
    output_summary  TEXT DEFAULT '',
    success         INTEGER NOT NULL DEFAULT 1,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT DEFAULT '',
    goal_id         TEXT DEFAULT '',
    step_index      INTEGER DEFAULT -1,
    token_input     INTEGER DEFAULT 0,
    token_output    INTEGER DEFAULT 0,
    created_at      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_partner ON audit_logs(partner_name);
CREATE INDEX IF NOT EXISTS idx_audit_goal ON audit_logs(goal_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_success ON audit_logs(success);
"""


class AuditLogger:
    def __init__(self, db_path: str, broadcaster: Any = None) -> None:
        self._db_path = db_path
        self._broadcaster = broadcaster
        self._init_table()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_table(self) -> None:
        conn = self._conn()
        conn.executescript(_AUDIT_SQL)
        self._migrate_columns(conn)
        conn.commit()
        conn.close()

    def _migrate_columns(self, conn: sqlite3.Connection) -> None:
        """迁移存量表结构，新增缺失列"""
        existing = conn.execute("PRAGMA table_info(audit_logs)").fetchall()
        col_names = {row["name"] for row in existing}
        if "token_input" not in col_names:
            conn.execute("ALTER TABLE audit_logs ADD COLUMN token_input INTEGER DEFAULT 0")
        if "token_output" not in col_names:
            conn.execute("ALTER TABLE audit_logs ADD COLUMN token_output INTEGER DEFAULT 0")

    @staticmethod
    def _gen_id() -> str:
        return f"audit_{uuid.uuid4().hex[:12]}"

    def log(
        self,
        partner_name: str,
        action: str,
        input_summary: str = "",
        output_summary: str = "",
        success: bool = True,
        duration_ms: int = 0,
        error_message: str = "",
        goal_id: str = "",
        step_index: int = -1,
        token_input: int = 0,
        token_output: int = 0,
        memory_hits: int = 0,
        drift_score: float = 0.0,
        drift_detail: str = "",
        critic_verdict: str = "",
        critic_issues: list = None,
        critic_hint: str = "",
        retry_count: int = 0,
        background: bool = False,
    ) -> AuditLog:
        entry = AuditLog(
            audit_id=self._gen_id(),
            partner_name=partner_name,
            action=action,
            input_summary=input_summary[:1000],
            output_summary=output_summary[:1000],
            success=success,
            duration_ms=duration_ms,
            error_message=error_message[:500],
            goal_id=goal_id,
            step_index=step_index,
            token_input=token_input,
            token_output=token_output,
            created_at=time.time(),
            memory_hits=memory_hits,
            drift_score=drift_score,
            drift_detail=drift_detail,
            critic_verdict=critic_verdict,
            critic_issues=critic_issues or [],
            critic_hint=critic_hint,
            retry_count=retry_count,
            background=background,
        )
        conn = self._conn()
        conn.execute(
            """INSERT INTO audit_logs (
                audit_id, partner_name, action, input_summary, output_summary,
                success, duration_ms, error_message, goal_id, step_index,
                token_input, token_output, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry.audit_id, entry.partner_name, entry.action,
                entry.input_summary, entry.output_summary,
                int(entry.success), entry.duration_ms, entry.error_message,
                entry.goal_id, entry.step_index,
                entry.token_input, entry.token_output, entry.created_at,
            ),
        )
        conn.commit()
        conn.close()
        self._push_log_event(entry)
        return entry

    def _push_log_event(self, entry: AuditLog) -> None:
        if self._broadcaster is None:
            return
        from core.memory.monitoring import LogEvent
        event = LogEvent(
            task_id=entry.goal_id,
            round_num=max(entry.step_index, 0),
            sender=entry.partner_name,
            avatar=self._get_avatar(entry.partner_name),
            action=entry.action,
            status="success" if entry.success else "fail",
            duration_ms=entry.duration_ms,
            token_input=entry.token_input,
            token_output=entry.token_output,
            timestamp=entry.created_at,
            error_message=entry.error_message,
            memory_hits=entry.memory_hits,
            drift_score=entry.drift_score,
            drift_detail=entry.drift_detail,
            critic_verdict=entry.critic_verdict,
            critic_issues=entry.critic_issues,
            critic_hint=entry.critic_hint,
            retry_count=entry.retry_count,
            background=entry.background,
        )
        self._broadcaster.send_log_event(event)

    @staticmethod
    def _get_avatar(partner_name: str) -> str:
        avatars = {
            "Luna": "🌙",
            "WebSurfer": "🔍",
            "MCP Expert": "🔌",
            "DocAuthor": "📝",
            "TestPilot": "🧪",
            "VisualPainter": "🎨",
            "SysDoctor": "🩺",
            "SecurityGuard": "🛡️",
            "GitKeeper": "🔀",
            "AutoBrowser": "🌐",
            "MediaWizard": "🎬",
            "RequirementAuditor": "📋",
            "OpenSourceHunter": "🔎",
            "Auditor": "🔍",
            "Frontend Expert": "🖥️",
        }
        return avatars.get(partner_name, "🤖")

    def get_partner_stats(self, partner_name: str) -> PartnerStats:
        conn = self._conn()
        row = conn.execute(
            """SELECT
                COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                AVG(duration_ms) as avg_duration
               FROM audit_logs WHERE partner_name = ?""",
            (partner_name,),
        ).fetchone()
        conn.close()

        total = row["total"] or 0
        success_count = row["success_count"] or 0
        avg_dur = row["avg_duration"] or 0.0

        return PartnerStats(
            partner_name=partner_name,
            total=total,
            success=success_count,
            success_rate=success_count / total if total > 0 else 0.0,
            avg_duration_ms=round(avg_dur, 2),
        )

    def get_goal_audit(self, goal_id: str) -> list[AuditLog]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM audit_logs WHERE goal_id = ? ORDER BY step_index, created_at",
            (goal_id,),
        ).fetchall()
        conn.close()
        return [self._row_to_log(row) for row in rows]

    def get_overall_stats(self) -> OverallStats:
        conn = self._conn()
        total_row = conn.execute(
            """SELECT
                COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                AVG(duration_ms) as avg_duration
               FROM audit_logs"""
        ).fetchone()
        conn.close()

        total = total_row["total"] or 0
        success_count = total_row["success_count"] or 0
        avg_dur = total_row["avg_duration"] or 0.0

        by_partner: dict[str, dict] = {}
        conn = self._conn()
        partner_rows = conn.execute(
            """SELECT
                partner_name,
                COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                AVG(duration_ms) as avg_duration
               FROM audit_logs GROUP BY partner_name"""
        ).fetchall()
        conn.close()

        for pr in partner_rows:
            pt = pr["total"] or 0
            sc = pr["success_count"] or 0
            ad = pr["avg_duration"] or 0.0
            by_partner[pr["partner_name"]] = {
                "total": pt,
                "success": sc,
                "success_rate": sc / pt if pt > 0 else 0.0,
                "avg_duration_ms": round(ad, 2),
            }

        return OverallStats(
            total_calls=total,
            success_rate=success_count / total if total > 0 else 0.0,
            avg_duration_ms=round(avg_dur, 2),
            by_partner=by_partner,
        )

    def get_token_stats(self, goal_id: str = None) -> dict:
        """查询 Token 消耗统计"""
        conn = self._conn()
        if goal_id:
            row = conn.execute(
                """SELECT
                    COALESCE(SUM(token_input), 0) as total_input,
                    COALESCE(SUM(token_output), 0) as total_output,
                    COALESCE(SUM(token_input + token_output), 0) as total,
                    COUNT(*) as call_count
                   FROM audit_logs WHERE goal_id = ?""",
                (goal_id,),
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT
                    COALESCE(SUM(token_input), 0) as total_input,
                    COALESCE(SUM(token_output), 0) as total_output,
                    COALESCE(SUM(token_input + token_output), 0) as total,
                    COUNT(*) as call_count
                   FROM audit_logs"""
            ).fetchone()
        conn.close()
        return {
            "total_input": row["total_input"] or 0,
            "total_output": row["total_output"] or 0,
            "total": row["total"] or 0,
            "call_count": row["call_count"] or 0,
        }

    def list_recent(self, limit: int = 50) -> list[AuditLog]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        return [self._row_to_log(row) for row in rows]

    @staticmethod
    def _row_to_log(row: sqlite3.Row) -> AuditLog:
        return AuditLog(
            audit_id=row["audit_id"],
            partner_name=row["partner_name"],
            action=row["action"],
            input_summary=row["input_summary"],
            output_summary=row["output_summary"],
            success=bool(row["success"]),
            duration_ms=row["duration_ms"],
            error_message=row["error_message"],
            goal_id=row["goal_id"],
            step_index=row["step_index"],
            token_input=row["token_input"],
            token_output=row["token_output"],
            created_at=row["created_at"],
        )

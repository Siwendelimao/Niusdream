from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ToolRiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class ToolRiskRule:
    tool_name: str
    risk_level: ToolRiskLevel
    description: str = ""
    require_confirmation: bool = False


@dataclass
class RiskCheckResult:
    tool_name: str
    risk_level: ToolRiskLevel
    allowed: bool
    require_confirmation: bool
    message: str = ""


class ToolRiskManager:
    def __init__(self) -> None:
        self._rules: dict[str, ToolRiskRule] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        defaults = [
            ToolRiskRule("code_search", ToolRiskLevel.LOW, "只读搜索"),
            ToolRiskRule("screenshot", ToolRiskLevel.LOW, "只读截图"),
            ToolRiskRule("clipboard_read", ToolRiskLevel.LOW, "读取剪贴板"),
            ToolRiskRule("git_status", ToolRiskLevel.LOW, "只读 Git 状态"),
            ToolRiskRule("git_log", ToolRiskLevel.LOW, "只读 Git 日志"),
            ToolRiskRule("git_diff", ToolRiskLevel.LOW, "只读 Git 差异"),
            ToolRiskRule("shell_exec", ToolRiskLevel.HIGH, "执行 Shell 命令", True),
            ToolRiskRule("diff_edit", ToolRiskLevel.MEDIUM, "修改文件"),
            ToolRiskRule("fs_write", ToolRiskLevel.MEDIUM, "写入文件"),
            ToolRiskRule("git_commit", ToolRiskLevel.MEDIUM, "提交代码"),
            ToolRiskRule("git_auto_commit", ToolRiskLevel.MEDIUM, "自动提交代码"),
            ToolRiskRule("clipboard_write", ToolRiskLevel.MEDIUM, "写入剪贴板"),
            ToolRiskRule("fs_delete", ToolRiskLevel.HIGH, "删除文件", True),
            ToolRiskRule("window_control", ToolRiskLevel.MEDIUM, "控制窗口"),
            ToolRiskRule("notify", ToolRiskLevel.LOW, "发送通知"),
            ToolRiskRule("skill_execute", ToolRiskLevel.HIGH, "执行技能", True),
        ]
        for rule in defaults:
            self._rules[rule.tool_name] = rule

    def register_rule(self, tool_name: str, risk_level: ToolRiskLevel,
                      description: str = "", require_confirmation: bool = False) -> None:
        self._rules[tool_name] = ToolRiskRule(
            tool_name=tool_name,
            risk_level=risk_level,
            description=description,
            require_confirmation=require_confirmation,
        )

    def check_tool(self, tool_name: str) -> RiskCheckResult:
        rule = self._rules.get(tool_name)
        if not rule:
            return RiskCheckResult(
                tool_name=tool_name,
                risk_level=ToolRiskLevel.MEDIUM,
                allowed=True,
                require_confirmation=False,
                message=f"工具 {tool_name} 未注册风险等级，默认中风险",
            )

        allowed = rule.risk_level not in (ToolRiskLevel.CRITICAL,)
        return RiskCheckResult(
            tool_name=tool_name,
            risk_level=rule.risk_level,
            allowed=allowed,
            require_confirmation=rule.require_confirmation,
            message=f"{rule.description}（{rule.risk_level.value}）",
        )

    def get_rule(self, tool_name: str) -> Optional[ToolRiskRule]:
        return self._rules.get(tool_name)

    def list_rules(self) -> list[ToolRiskRule]:
        return list(self._rules.values())

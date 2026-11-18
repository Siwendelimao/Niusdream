"""NIS Memory System — MCP Expert Partner

专门在流程模式中执行 MCP 操作的伙伴。
NIS 在流程中间需要操作电脑时，调度 MCP Expert 来执行。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class McpTask:
    """MCP 任务定义"""
    plugin: str          # 插件名称（如 "browser", "system"）
    tool: str            # 工具名称（如 "navigate", "screenshot"）
    arguments: dict = field(default_factory=dict)
    description: str = ""  # 人类可读描述


@dataclass
class McpResult:
    """MCP 执行结果"""
    success: bool
    plugin: str
    tool: str
    result: Any = None
    error: str = ""


class McpExpert:
    """MCP Expert Partner

    在流程模式中替代 NIS 执行 MCP 操作。
    能力与 NIS 直接调用 MCP 完全一致，只是运行在 Partner 上下文中。
    """

    name = "MCP Expert"
    skill = "computer_control"
    avatar = "🖥️"

    def __init__(self, plugin_manager: Any) -> None:
        self._plugin_manager = plugin_manager

    async def execute_task(self, task: McpTask) -> McpResult:
        """执行单个 MCP 任务"""
        try:
            result = await self._plugin_manager.call_tool(
                task.plugin, task.tool, task.arguments
            )
            logger.info("MCP Expert: %s.%s → success", task.plugin, task.tool)
            return McpResult(
                success=True,
                plugin=task.plugin,
                tool=task.tool,
                result=result,
            )
        except Exception as e:
            logger.error("MCP Expert: %s.%s → error: %s",
                         task.plugin, task.tool, e)
            return McpResult(
                success=False,
                plugin=task.plugin,
                tool=task.tool,
                error=str(e),
            )

    async def execute_batch(self, tasks: list[McpTask]) -> list[McpResult]:
        """顺序执行多个 MCP 任务"""
        results = []
        for task in tasks:
            result = await self.execute_task(task)
            results.append(result)
            if not result.success:
                break  # 失败停止
        return results

    async def execute_plan(self, plan: list[dict]) -> list[McpResult]:
        """执行计划（从 JSON 格式的任务列表）"""
        tasks = [
            McpTask(
                plugin=p["plugin"],
                tool=p["tool"],
                arguments=p.get("arguments", {}),
                description=p.get("description", ""),
            )
            for p in plan
        ]
        return await self.execute_batch(tasks)

    def get_available_tools(self) -> list[dict]:
        """获取所有可用工具"""
        return self._plugin_manager.get_all_tools()

    async def on_feedback(self, feedback: str) -> None:
        """处理反馈（PartnerPlugin 接口要求）"""
        logger.info("MCP Expert received feedback: %s", feedback[:200])

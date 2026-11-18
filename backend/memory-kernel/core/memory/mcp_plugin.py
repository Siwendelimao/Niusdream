"""NIS Memory System — MCP 插件包装器

将外部 MCP Server 包装为 NIS 插件。
每个插件 = 一个 MCP Server 实例 + PluginInfo。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from core.memory.external_mcp import ExternalMcpServer, McpServerConfig
from core.memory.plugin_manager import PluginManager, PluginInfo, PluginType, PluginStatus

logger = logging.getLogger(__name__)


class McpPlugin:
    """MCP 插件包装器

    将外部 MCP Server 包装为 NIS 插件。
    提供启动/停止/工具调用接口。
    """

    def __init__(self, config: McpServerConfig) -> None:
        self._config = config
        self._server = ExternalMcpServer(config)
        self._info = PluginInfo(
            name=config.name,
            plugin_type=PluginType.MCP,
            status=PluginStatus.DISABLED,
            icon=config.icon,
            description=config.description,
            tools=config.tools,
        )

    @property
    def info(self) -> PluginInfo:
        return self._info

    @property
    def server(self) -> ExternalMcpServer:
        return self._server

    @property
    def is_running(self) -> bool:
        return self._server.is_running

    async def start(self) -> None:
        """启动插件"""
        try:
            await self._server.start()
            self._info.status = PluginStatus.ENABLED
            self._info.error_message = ""
            # 重新获取工具列表
            tools = await self._server.list_tools()
            if tools:
                self._info.tools = [
                    {
                        "name": t.get("name", ""),
                        "description": t.get("description", ""),
                        "input_schema": t.get("inputSchema", {}),
                    }
                    for t in tools
                ]
            logger.info("MCP 插件 '%s' 已启动，%d 个工具",
                         self._config.name, len(self._info.tools))
        except Exception as e:
            self._info.status = PluginStatus.ERROR
            self._info.error_message = str(e)
            logger.error("MCP 插件 '%s' 启动失败: %s",
                         self._config.name, e)
            raise

    async def stop(self) -> None:
        """停止插件"""
        await self._server.stop()
        self._info.status = PluginStatus.DISABLED

    async def call_tool(self, tool_name: str, arguments: dict = None) -> dict:
        """调用工具"""
        if not self.is_running:
            raise RuntimeError(f"插件未运行: {self._config.name}")
        return await self._server.call_tool(tool_name, arguments)


class PluginRegistry:
    """MCP 插件注册表

    管理所有外部 MCP 插件。
    负责启动/停止/注册到 PluginManager。
    """

    def __init__(self, plugin_manager: PluginManager) -> None:
        self._pm = plugin_manager
        self._plugins: dict[str, McpPlugin] = {}

    def register(self, config: McpServerConfig) -> McpPlugin:
        """注册 MCP 插件"""
        plugin = McpPlugin(config)
        self._plugins[config.name] = plugin
        # 注册到 PluginManager
        self._pm.register_mcp_server(
            name=config.name,
            client=plugin.server,
            tools=config.tools,
            icon=config.icon,
            description=config.description,
        )
        return plugin

    async def start_plugin(self, name: str) -> None:
        """启动指定插件"""
        plugin = self._plugins.get(name)
        if plugin:
            await plugin.start()
            self._pm.enable(name)

    async def stop_plugin(self, name: str) -> None:
        """停止指定插件"""
        plugin = self._plugins.get(name)
        if plugin:
            await plugin.stop()
            self._pm.disable(name)

    async def start_all(self) -> None:
        """启动所有插件"""
        for name, plugin in self._plugins.items():
            try:
                await self.start_plugin(name)
            except Exception as e:
                logger.warning("插件 '%s' 启动失败: %s", name, e)

    async def stop_all(self) -> None:
        """停止所有插件"""
        for name in list(self._plugins.keys()):
            await self.stop_plugin(name)

    def get_plugin(self, name: str) -> Optional[McpPlugin]:
        """获取插件"""
        return self._plugins.get(name)

    def list_plugins(self) -> list[McpPlugin]:
        """列出所有插件"""
        return list(self._plugins.values())

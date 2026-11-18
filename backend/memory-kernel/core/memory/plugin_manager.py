"""NIS Memory System — 统一插件管理器"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class PluginType(str, Enum):
    MCP = "mcp"
    SYSTEM = "system"


class PluginStatus(str, Enum):
    ENABLED = "enabled"
    DISABLED = "disabled"
    ERROR = "error"


@dataclass
class PluginInfo:
    """插件信息"""
    name: str
    plugin_type: PluginType
    status: PluginStatus
    icon: str
    description: str
    tools: list[dict] = field(default_factory=list)
    config: dict = field(default_factory=dict)
    error_message: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.plugin_type.value,
            "status": self.status.value,
            "icon": self.icon,
            "description": self.description,
            "tools": self.tools,
            "config": self.config,
            "error_message": self.error_message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class PluginManager:
    """统一插件管理入口

    管理所有插件的注册、启停、查询。
    NIS 和 MCP Expert 通过此管理器访问插件能力。
    """

    def __init__(self) -> None:
        self._plugins: dict[str, PluginInfo] = {}
        self._mcp_clients: dict[str, Any] = {}  # name -> MCPClient

    # ── 注册 ──

    def register_mcp_server(
        self,
        name: str,
        client: Any,
        tools: list[dict] = None,
        icon: str = "🔌",
        description: str = "",
        config: dict = None,
    ) -> PluginInfo:
        """注册 MCP Server 为插件"""
        now = time.time()
        info = PluginInfo(
            name=name,
            plugin_type=PluginType.MCP,
            status=PluginStatus.ENABLED,
            icon=icon,
            description=description or f"MCP Server: {name}",
            tools=tools or [],
            config=config or {},
            created_at=now,
            updated_at=now,
        )
        self._plugins[name] = info
        self._mcp_clients[name] = client
        return info

    def register_system_plugin(
        self,
        name: str,
        tools: list[dict],
        icon: str = "⚙️",
        description: str = "",
    ) -> PluginInfo:
        """注册系统内置插件"""
        now = time.time()
        info = PluginInfo(
            name=name,
            plugin_type=PluginType.SYSTEM,
            status=PluginStatus.ENABLED,
            icon=icon,
            description=description,
            tools=tools,
            created_at=now,
            updated_at=now,
        )
        self._plugins[name] = info
        return info

    # ── 查询 ──

    def list_all(self) -> list[PluginInfo]:
        """返回所有插件"""
        return list(self._plugins.values())

    def list_enabled(self) -> list[PluginInfo]:
        """返回已启用插件"""
        return [p for p in self._plugins.values()
                if p.status == PluginStatus.ENABLED]

    def get_plugin(self, name: str) -> Optional[PluginInfo]:
        """获取插件信息"""
        return self._plugins.get(name)

    def get_mcp_client(self, name: str) -> Optional[Any]:
        """获取 MCP 客户端"""
        return self._mcp_clients.get(name)

    def get_all_mcp_clients(self) -> dict[str, Any]:
        """获取所有已启用的 MCP 客户端"""
        return {
            name: client
            for name, client in self._mcp_clients.items()
            if self._plugins.get(name, PluginInfo("", PluginType.MCP,
                                                  PluginStatus.DISABLED, "", "")
                               ).status == PluginStatus.ENABLED
        }

    # ── 启停 ──

    def enable(self, name: str) -> bool:
        """启用插件"""
        if name in self._plugins:
            self._plugins[name].status = PluginStatus.ENABLED
            self._plugins[name].updated_at = time.time()
            return True
        return False

    def disable(self, name: str) -> bool:
        """停用插件"""
        if name in self._plugins:
            self._plugins[name].status = PluginStatus.DISABLED
            self._plugins[name].updated_at = time.time()
            return True
        return False

    def toggle(self, name: str) -> bool:
        """切换插件状态，返回当前是否启用"""
        plugin = self._plugins.get(name)
        if not plugin:
            return False
        if plugin.status == PluginStatus.ENABLED:
            self.disable(name)
            return False
        else:
            self.enable(name)
            return True

    # ── 元信息更新（备注/图标） ──

    def update_meta(self, name: str, description: str = None,
                    icon: str = None) -> bool:
        """更新插件备注/图标（持久化展示信息，方便识别）"""
        plugin = self._plugins.get(name)
        if not plugin:
            return False
        if description is not None:
            plugin.description = description
        if icon is not None:
            plugin.icon = icon
        plugin.updated_at = time.time()
        return True

    # ── 持久化（备注/启停状态 + MCP 启动配置） ──

    def to_state(self) -> dict:
        """导出可持久化状态（不含运行时 client）：
        {
          "plugins": {
            name: {
              "type": "mcp"|"system",
              "description": 用户备注,
              "icon": ...,
              "status": "enabled"|"disabled",
              "config": PluginInfo.config  // MCP 启动配置（command/args/env）
            }
          }
        }
        """
        plugins = {}
        for name, info in self._plugins.items():
            plugins[name] = {
                "type": info.plugin_type.value,
                "description": info.description,
                "icon": info.icon,
                "status": info.status.value,
                "config": info.config,
            }
        return {"plugins": plugins}

    def apply_state(self, state: dict) -> None:
        """把持久化状态合并进现有插件（重启恢复备注/启停）。

        只对已注册的插件生效；MCP 插件本体由调用方在注册后按 config 恢复。
        """
        if not isinstance(state, dict):
            return
        plugins = state.get("plugins")
        if not isinstance(plugins, dict):
            return
        for name, data in plugins.items():
            info = self._plugins.get(name)
            if info is None or not isinstance(data, dict):
                continue
            if isinstance(data.get("description"), str) and data["description"]:
                info.description = data["description"]
            if isinstance(data.get("icon"), str) and data["icon"]:
                info.icon = data["icon"]
            status = data.get("status")
            if status == PluginStatus.DISABLED.value:
                info.status = PluginStatus.DISABLED
            elif status == PluginStatus.ENABLED.value:
                info.status = PluginStatus.ENABLED
            if isinstance(data.get("config"), dict) and data["config"]:
                info.config = data["config"]

    # ── 工具调用 ──

    async def call_tool(self, plugin_name: str, tool_name: str,
                        arguments: dict = None) -> dict:
        """调用指定插件的工具"""
        plugin = self._plugins.get(plugin_name)
        if not plugin:
            raise ValueError(f"Plugin not found: {plugin_name}")
        if plugin.status != PluginStatus.ENABLED:
            raise ValueError(f"Plugin disabled: {plugin_name}")

        if plugin.plugin_type == PluginType.MCP:
            client = self._mcp_clients.get(plugin_name)
            if not client:
                raise ValueError(f"MCP client not found: {plugin_name}")
            return await client.call_tool(tool_name, arguments)

        raise ValueError(f"Unsupported plugin type: {plugin.plugin_type}")

    def get_all_tools(self) -> list[dict]:
        """获取所有已启用插件的工具列表"""
        tools = []
        for plugin in self.list_enabled():
            for tool in plugin.tools:
                tools.append({
                    "plugin": plugin.name,
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema", {}),
                })
        return tools

    # ── 序列化（供前端 API） ──

    def to_dict(self) -> dict:
        """导出所有插件信息（供前端）"""
        return {
            "plugins": [p.to_dict() for p in self._plugins.values()],
            "total": len(self._plugins),
            "enabled": len(self.list_enabled()),
        }

"""NIS Memory System — 外部 MCP Server 连接器

连接社区 MCP Server（Playwright / GitHub / Database 等）。
统一接口，即插即用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from subprocess import PIPE
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class McpServerConfig:
    """外部 MCP Server 配置"""
    name: str
    description: str
    icon: str
    command: str                    # 启动命令（npx / pip / 直接路径）
    args: list[str] = field(default_factory=list)
    env: dict = field(default_factory=dict)
    tools: list[dict] = field(default_factory=list)  # 预声明工具列表


class ExternalMcpServer:
    """外部 MCP Server 连接器

    通过 stdio JSON-RPC 与外部 MCP Server 通信。
    支持 npx / pip / 直接二进制启动。
    """

    def __init__(self, config: McpServerConfig) -> None:
        self._config = config
        self.proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._request_id = 0
        self._tools: list[dict] = []

    # ── 生命周期 ─────────────────────────────────

    async def start(self) -> None:
        """启动外部 MCP Server"""
        if self.proc is not None:
            return

        cmd = [self._config.command] + self._config.args
        env = os.environ.copy()
        env.update(self._config.env)

        # 检查命令是否存在
        cmd_path = shutil.which(self._config.command)
        if cmd_path is None:
            raise RuntimeError(
                f"命令未找到: {self._config.command}\n"
                f"请先安装：{self._config.command}"
            )

        self.proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=PIPE,
            stdout=PIPE,
            stderr=PIPE,
            env=env,
        )
        logger.info("MCP Server '%s' started (PID %d)",
                     self._config.name, self.proc.pid)

        # 初始化握手
        await self._initialize()

        # 获取工具列表
        await self._fetch_tools()

    async def stop(self) -> None:
        """停止外部 MCP Server"""
        if self.proc is None:
            return
        try:
            self.proc.terminate()
            await asyncio.wait_for(self.proc.wait(), timeout=5.0)
        except (ProcessLookupError, asyncio.TimeoutError):
            self.proc.kill()
        self.proc = None
        logger.info("MCP Server '%s' stopped", self._config.name)

    @property
    def is_running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    # ── 工具 ──────────────────────────────────────

    async def list_tools(self) -> list[dict]:
        """获取工具列表"""
        if not self._tools:
            await self._fetch_tools()
        return self._tools

    async def call_tool(self, name: str,
                        arguments: dict | None = None) -> dict:
        """调用工具"""
        params = {"name": name, "arguments": arguments or {}}
        resp = await self._send_request("tools/call", params=params)
        if "error" in resp and resp["error"] is not None:
            raise RuntimeError(
                f"MCP 工具调用失败 [{name}]: {resp['error']['message']}"
            )
        return resp.get("result", {})

    # ── 内部实现 ─────────────────────────────────

    async def _initialize(self) -> None:
        """MCP 初始化握手"""
        resp = await self._send_request("initialize", params={
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "nis", "version": "1.0.0"},
        })
        if resp.get("error"):
            raise RuntimeError(
                f"MCP 握手失败: {resp['error']['message']}"
            )

    async def _fetch_tools(self) -> None:
        """获取工具列表"""
        resp = await self._send_request("tools/list")
        self._tools = resp.get("result", {}).get("tools", [])

    async def _send_request(self, method: str,
                            params: dict | None = None) -> dict:
        """发送 JSON-RPC 请求"""
        async with self._lock:
            self._request_id += 1
            req = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
            }
            if params is not None:
                req["params"] = params

            if self.proc is None or self.proc.stdin is None:
                raise RuntimeError(
                    f"MCP Server '{self._config.name}' 未启动"
                )

            payload = json.dumps(req, ensure_ascii=False) + "\n"
            self.proc.stdin.write(payload.encode("utf-8"))
            await self.proc.stdin.drain()

            assert self.proc.stdout is not None
            line = await asyncio.wait_for(
                self.proc.stdout.readline(), timeout=30.0
            )
            try:
                return json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as e:
                raise RuntimeError(
                    f"MCP 响应解析失败: {e} (raw: {line!r})"
                )


# ── 预配置：社区热门 MCP Server ──────────────────

PLAYWRIGHT_MCP = McpServerConfig(
    name="playwright",
    description="浏览器自动化：打开网页、点击、填写表单、截图",
    icon="🌐",
    command="npx",
    args=["@playwright/mcp@latest"],
    tools=[
        {"name": "browser_navigate", "description": "打开 URL"},
        {"name": "browser_click", "description": "点击元素"},
        {"name": "browser_fill", "description": "填写输入框"},
        {"name": "browser_screenshot", "description": "截图"},
        {"name": "browser_snapshot", "description": "获取页面结构"},
        {"name": "browser_press_key", "description": "按键"},
        {"name": "browser_select_option", "description": "选择下拉选项"},
        {"name": "browser_wait_for", "description": "等待元素/时间"},
        {"name": "browser_close", "description": "关闭浏览器"},
    ],
)

GITHUB_MCP = McpServerConfig(
    name="github",
    description="GitHub 操作：PR、Issue、代码审查、搜索仓库",
    icon="🐙",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-github"],
    env={"GITHUB_PERSONAL_ACCESS_TOKEN": ""},
    tools=[
        {"name": "create_issue", "description": "创建 Issue"},
        {"name": "list_issues", "description": "列出 Issue"},
        {"name": "create_pull_request", "description": "创建 PR"},
        {"name": "list_pull_requests", "description": "列出 PR"},
        {"name": "search_repositories", "description": "搜索仓库"},
        {"name": "get_file_contents", "description": "获取文件内容"},
        {"name": "create_or_update_file", "description": "创建/更新文件"},
        {"name": "push_files", "description": "推送文件"},
    ],
)

DATABASE_MCP = McpServerConfig(
    name="database",
    description="数据库操作：MySQL、PostgreSQL、SQLite 查询",
    icon="🗄️",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-postgres"],
    tools=[
        {"name": "query", "description": "执行 SQL 查询"},
        {"name": "list_tables", "description": "列出表"},
        {"name": "describe_table", "description": "表结构"},
    ],
)


def get_builtin_mcp_servers() -> list[McpServerConfig]:
    """获取预配置的社区 MCP Server"""
    return [PLAYWRIGHT_MCP, GITHUB_MCP, DATABASE_MCP]

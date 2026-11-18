from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TaskTemplate:
    name: str
    description: str
    steps: list[str] = field(default_factory=list)
    required_tools: list[str] = field(default_factory=list)
    risk_level: str = "medium"
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "steps": self.steps,
            "required_tools": self.required_tools,
            "risk_level": self.risk_level,
            "tags": self.tags,
        }


class TaskTemplateManager:
    def __init__(self) -> None:
        self._templates: dict[str, TaskTemplate] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        defaults = [
            TaskTemplate(
                name="上架商品",
                description="在电商平台上架新商品",
                steps=[
                    "准备商品信息（标题、描述、价格、图片）",
                    "登录电商后台",
                    "填写商品表单",
                    "上传商品图片",
                    "提交审核",
                ],
                required_tools=["screenshot", "clipboard_write", "notify"],
                risk_level="medium",
                tags=["电商", "商品管理"],
            ),
            TaskTemplate(
                name="部署网站",
                description="将网站部署到生产环境",
                steps=[
                    "运行测试确认通过",
                    "构建生产版本",
                    "备份当前生产环境",
                    "部署新版本",
                    "验证部署结果",
                ],
                required_tools=["shell_exec", "git_commit", "code_search"],
                risk_level="high",
                tags=["部署", "运维"],
            ),
            TaskTemplate(
                name="代码重构",
                description="重构指定模块代码",
                steps=[
                    "分析现有代码结构",
                    "识别重构目标",
                    "编写测试保护",
                    "执行重构",
                    "运行测试验证",
                    "提交变更",
                ],
                required_tools=["code_search", "diff_edit", "shell_exec", "git_commit"],
                risk_level="medium",
                tags=["开发", "重构"],
            ),
        ]
        for t in defaults:
            self._templates[t.name] = t

    def register(self, template: TaskTemplate) -> None:
        self._templates[template.name] = template

    def get(self, name: str) -> Optional[TaskTemplate]:
        return self._templates.get(name)

    def list_all(self) -> list[TaskTemplate]:
        return list(self._templates.values())

    def search_by_tag(self, tag: str) -> list[TaskTemplate]:
        return [t for t in self._templates.values() if tag in t.tags]

    def search_by_tool(self, tool_name: str) -> list[TaskTemplate]:
        return [t for t in self._templates.values() if tool_name in t.required_tools]

"""NIS Memory System — 项目级 .md 记忆管理"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Optional


class ProjectMemoryManager:
    """项目级 .nis/ 目录管理"""

    SUMMARY_FILES = ["README.md", "progress.md", "pitfalls.md", "patterns.md", "decisions.md"]

    def __init__(self, project_root: str) -> None:
        self.root = Path(project_root) / ".nis"
        self.sessions_dir = self.root / "sessions"

    def ensure_exists(self, name: str, goal: str = "", tech_stack: list = None) -> None:
        """创建 .nis/ 目录 + 初始摘要文件"""
        self.root.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

        # README.md
        readme = self.root / "README.md"
        if not readme.exists():
            readme.write_text(
                f"# {name}\n\n"
                f"## 背景\n{goal or '（待填写）'}\n\n"
                f"## 技术栈\n{', '.join(tech_stack or []) or '（待填写）'}\n\n",
                encoding="utf-8",
            )

        # progress.md
        progress = self.root / "progress.md"
        if not progress.exists():
            progress.write_text("# 进度\n\n（暂无记录）\n", encoding="utf-8")

        # pitfalls.md
        pitfalls = self.root / "pitfalls.md"
        if not pitfalls.exists():
            pitfalls.write_text("# 踩坑记录\n\n（暂无记录）\n", encoding="utf-8")

        # patterns.md
        patterns = self.root / "patterns.md"
        if not patterns.exists():
            patterns.write_text("# 优秀步骤\n\n（暂无记录）\n", encoding="utf-8")

        # decisions.md
        decisions = self.root / "decisions.md"
        if not decisions.exists():
            decisions.write_text("# 关键决策\n\n（暂无记录）\n", encoding="utf-8")

    def load_summary(self) -> str:
        """加载所有摘要文件，拼接到一个字符串"""
        parts = []
        for filename in self.SUMMARY_FILES:
            filepath = self.root / filename
            if filepath.exists():
                content = filepath.read_text(encoding="utf-8").strip()
                if content and content != "（暂无记录）":
                    parts.append(f"--- {filename} ---\n{content}")
        return "\n\n".join(parts) if parts else ""

    def business_card(self, max_chars: int = 200) -> str:
        """项目名片：只读 README.md 的项目名/背景/技术栈（稳定，不随进度增长）。

        注入用：md 文件已降级为磁盘备份，聊天只带名片，进度/踩坑交给检索。
        """
        readme = self.root / "README.md"
        if not readme.exists():
            return ""
        text = readme.read_text(encoding="utf-8")
        lines = []
        m = re.search(r"^#\s+(.+?)\s*$", text, re.M)
        if m:
            lines.append(f"项目：{m.group(1).strip()}")
        for section, label in (("背景", "目标"), ("技术栈", "技术栈")):
            m = re.search(rf"^##\s*{section}\s*$([\s\S]*?)(?=^##|\Z)", text, re.M)
            if not m:
                continue
            content = " ".join(m.group(1).strip().split())
            if content and "待填写" not in content:
                lines.append(f"{label}：{content[:120]}")
        card = "\n".join(lines)
        if len(card) > max_chars:
            card = card[: max_chars - 1] + "…"
        return card

    def load_recent_sessions(self, n: int = 2) -> str:
        """加载最近 n 天的 sessions 文件"""
        if not self.sessions_dir.exists():
            return []

        files = sorted(self.sessions_dir.glob("*.md"), reverse=True)[:n]
        parts = []
        for f in files:
            content = f.read_text(encoding="utf-8").strip()
            if content:
                parts.append(f"--- {f.name} ---\n{content}")
        return "\n\n".join(parts) if parts else ""

    def search_sessions(self, query: str) -> list[str]:
        """在 sessions/ 搜索关键词，返回匹配的文件路径列表"""
        if not self.sessions_dir.exists():
            return []

        results = []
        for f in sorted(self.sessions_dir.glob("*.md"), reverse=True):
            content = f.read_text(encoding="utf-8")
            if query.lower() in content.lower():
                results.append(str(f))
        return results

    def load_specific_sessions(self, file_paths: list[str]) -> str:
        """加载指定的 session 文件"""
        parts = []
        for path in file_paths:
            p = Path(path)
            if p.exists():
                content = p.read_text(encoding="utf-8").strip()
                if content:
                    parts.append(f"--- {p.name} ---\n{content}")
        return "\n\n".join(parts) if parts else ""

    def append_section(self, filename: str, title: str, content: str) -> None:
        """追加一条记录到指定的摘要文件。

        写前查重：已存在相似条目 → 不重复追加；
        与旧条目矛盾（改口）→ 用新条目顶替旧条目。
        """
        filepath = self.root / filename
        if not filepath.exists():
            filepath.write_text(f"# {filename.replace('.md', '')}\n\n", encoding="utf-8")

        # 写前查重 / 矛盾顶替
        from core.memory.text_utils import detect_contradiction, is_duplicate
        existing_text = filepath.read_text(encoding="utf-8")
        candidate = f"[{title}] {content}"

        sections = existing_text.split("\n## ")
        replaced = False
        for i, section in enumerate(sections):
            section = section.strip()
            if not section:
                continue
            # 矛盾（用户改口）优先于查重判定：先顶替旧条目
            if detect_contradiction(candidate, section):
                timestamp = time.strftime("%Y-%m-%d %H:%M")
                sections[i] = f"[{timestamp}] {title}\n\n{content}"
                replaced = True
                break
            if is_duplicate(candidate, section):
                return

        if replaced:
            new_text = "\n## ".join(sections).rstrip("\n") + "\n"
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_text)
            return

        timestamp = time.strftime("%Y-%m-%d %H:%M")
        entry = f"## [{timestamp}] {title}\n\n{content}\n\n"

        with open(filepath, "a", encoding="utf-8") as f:
            f.write(entry)

    def get_all_entries(self) -> list[dict]:
        """返回所有摘要条目（供 memory_graph 索引）"""
        entries = []
        for filename in self.SUMMARY_FILES:
            filepath = self.root / filename
            if not filepath.exists():
                continue
            content = filepath.read_text(encoding="utf-8")
            title = filename.replace(".md", "")
            for section in content.split("\n## "):
                section = section.strip()
                if section and not section.startswith("# "):
                    entries.append({
                        "title": title,
                        "content": section,
                        "md_file": str(filepath),
                        "md_section": section.split("\n")[0] if section else "",
                    })
        return entries

    def exists(self) -> bool:
        """检查 .nis/ 目录是否存在"""
        return self.root.exists()

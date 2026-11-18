"""NIS Memory System — 全局 ~/.nis/ 记忆管理"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional


class GlobalMemoryManager:
    """全局 ~/.nis/ 目录管理"""

    SUMMARY_FILES = ["preferences.md", "decisions.md", "lessons.md"]

    def __init__(self, home_dir: str = "") -> None:
        if not home_dir:
            home_dir = os.path.join(os.path.expanduser("~"), ".nis")
        self.root = Path(home_dir)
        self.sessions_dir = self.root / "sessions"

    def ensure_exists(self) -> None:
        """创建 ~/.nis/ 目录 + 初始摘要文件"""
        self.root.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

        preferences = self.root / "preferences.md"
        if not preferences.exists():
            preferences.write_text("# 用户偏好\n\n（暂无记录）\n", encoding="utf-8")

        decisions = self.root / "decisions.md"
        if not decisions.exists():
            decisions.write_text("# 决策记录\n\n（暂无记录）\n", encoding="utf-8")

        lessons = self.root / "lessons.md"
        if not lessons.exists():
            lessons.write_text("# 经验教训\n\n（暂无记录）\n", encoding="utf-8")

    def load_summary(self) -> str:
        """加载全局摘要"""
        parts = []
        for filename in self.SUMMARY_FILES:
            filepath = self.root / filename
            if filepath.exists():
                content = filepath.read_text(encoding="utf-8").strip()
                if content and content != "（暂无记录）":
                    parts.append(f"--- {filename} ---\n{content}")
        return "\n\n".join(parts) if parts else ""

    def append_entry(self, node_type: str, title: str, content: str) -> None:
        """追加一条记录到对应类型的文件。

        写前查重：已存在相似条目 → 不重复追加；
        与旧条目矛盾（用户改口）→ 用新条目顶替旧条目（不保留矛盾记忆，避免注入系统提示词时自相矛盾）。
        """
        type_to_file = {
            "preference": "preferences.md",
            "decision": "decisions.md",
            "pitfall": "lessons.md",
            "lesson": "lessons.md",
        }
        filename = type_to_file.get(node_type, "decisions.md")
        filepath = self.root / filename

        if not filepath.exists():
            filepath.write_text(f"# {filename.replace('.md', '')}\n\n", encoding="utf-8")

        # 写前查重：文件里已有相同/相似条目 → 跳过（避免重复堆积）；
        # 与旧条目矛盾（如"不喜欢 emoji"→"改用 emoji"）→ 顶替旧条目
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

    def search(self, query: str) -> list[dict]:
        """搜索全局记忆"""
        results = []
        for filename in self.SUMMARY_FILES:
            filepath = self.root / filename
            if not filepath.exists():
                continue
            content = filepath.read_text(encoding="utf-8")
            if query.lower() in content.lower():
                results.append({
                    "file": str(filepath),
                    "type": filename.replace(".md", ""),
                    "content": content,
                })
        return results

    def get_all_entries(self) -> list[dict]:
        """返回所有全局条目（供 memory_graph 索引）"""
        entries = []
        for filename in self.SUMMARY_FILES:
            filepath = self.root / filename
            if not filepath.exists():
                continue
            content = filepath.read_text(encoding="utf-8")
            for section in content.split("\n## "):
                section = section.strip()
                if section and not section.startswith("# "):
                    entries.append({
                        "title": filename.replace(".md", ""),
                        "content": section,
                        "md_file": str(filepath),
                        "md_section": section.split("\n")[0] if section else "",
                    })
        return entries

    def exists(self) -> bool:
        """检查 ~/.nis/ 目录是否存在"""
        return self.root.exists()

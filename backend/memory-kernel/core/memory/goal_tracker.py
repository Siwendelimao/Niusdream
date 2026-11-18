from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class DriftResult:
    drift_score: float = 0.0
    is_drifted: bool = False
    keywords_matched: int = 0
    keywords_total: int = 0
    detail: str = ""


@dataclass
class GoalTracker:
    goal_description: str = ""
    drift_threshold: float = 0.7
    _actions: list[str] = field(default_factory=list)

    def record_action(self, action: str) -> None:
        self._actions.append(action)

    def check_drift(self, current_action: str) -> DriftResult:
        """检测当前动作是否偏离目标

        返回漂移分数 0-1，越高越偏离。
        基于关键词重叠度计算：目标关键词在动作中出现的比例越低，漂移越高。
        """
        if not self.goal_description:
            return DriftResult(drift_score=0.0, detail="无目标描述，跳过检测")

        goal_keywords = self._extract_keywords(self.goal_description)
        if not goal_keywords:
            return DriftResult(drift_score=0.0, detail="目标无有效关键词，跳过检测")

        action_keywords = self._extract_keywords(current_action)
        action_text = current_action.lower()

        matched = 0
        for kw in goal_keywords:
            if kw in action_keywords:
                matched += 1
            elif len(kw) >= 3 and kw in action_text:
                matched += 1

        total = len(goal_keywords)
        if total == 0:
            return DriftResult(drift_score=0.0, detail="无有效关键词")

        match_ratio = matched / total
        drift_score = 1.0 - match_ratio

        is_drifted = drift_score > self.drift_threshold

        return DriftResult(
            drift_score=round(drift_score, 3),
            is_drifted=is_drifted,
            keywords_matched=matched,
            keywords_total=total,
            detail=f"关键词匹配 {matched}/{total}，漂移 {drift_score:.0%}",
        )

    def should_alert(self, drift_score: float) -> bool:
        return drift_score > self.drift_threshold

    def get_action_history(self) -> list[str]:
        return list(self._actions)

    def reset(self) -> None:
        self._actions.clear()

    @staticmethod
    def _extract_keywords(text: str) -> list[str]:
        """提取中文 2-gram 和英文单词"""
        chinese_chars = re.findall(r'[\u4e00-\u9fff]', text)
        chinese_ngrams = set()
        for i in range(len(chinese_chars) - 1):
            chinese_ngrams.add(chinese_chars[i] + chinese_chars[i + 1])

        english_words = re.findall(r'[a-zA-Z]{3,}', text.lower())
        stop_words = {"the", "and", "for", "with", "this", "that", "from", "have", "will",
                      "configure", "pipeline"}
        english_words = [w for w in english_words if w not in stop_words]

        return list(chinese_ngrams) + english_words

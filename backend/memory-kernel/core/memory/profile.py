"""NIS Memory — 用户档案卡（User Profile）

把高频偏好归入结构化 JSON 字段（视频里 ChatGPT 四层之"Profile"），
读取精确（问"预算多少"直接命中字段）、可覆写（新值顶替旧值 = 单一事实来源）。

存储：memory_system.db 的 memory_records（memory_type=user_profile, scope=nis_core），
内容为 JSON 字符串。写入走 upsert_memory（查重/来源优先级一致）。
"""

from __future__ import annotations

import json
import re
from typing import Optional

# 档案卡字段：{字段名: 说明}（高频偏好，结构化后读取精确）
PROFILE_FIELDS = {
    "tech_stack": "技术栈偏好（如 Vue/React/TypeScript）",
    "budget": "预算/费用约束（如 5000 元内）",
    "style": "界面/视觉风格偏好（如简约/深色/紫色）",
    "language": "语言/方言偏好（如中文/英文）",
    "pace": "工作节奏（如快速试错/谨慎规划）",
    "constraints": "通用约束/禁忌（如不用 emoji、不装大依赖）",
}

# 关键词 → 字段 映射（提炼/写入时自动归类）
_FIELD_KEYWORDS = {
    "tech_stack": ["技术栈", "框架", "用 vue", "用 react", "用 typescript", "前端用", "后端用", "语言用", "vue", "react", "typescript", "next", "node", "python"],
    "budget": ["预算", "预算内", "费用", "成本", "不超过", "以内", "价格", "多少钱", "万元", "元"],
    "style": ["风格", "简约", "深色", "浅色", "紫色", "配色", "设计风", "好看", "漂亮", "颜色", "主题"],
    "language": ["中文", "英文", "语言", "用中文", "用英文"],
    "pace": ["快速", "先做", "马上", "不急", "慢慢来", "稳", "谨慎", "测试驱动"],
    "constraints": ["不要", "不用", "避免", "禁止", "讨厌", "不喜欢", "别用", "不考虑"],
}


def classify_field(content: str) -> Optional[str]:
    """把一条偏好内容归类到档案卡字段（关键词命中）。归不上返回 None。"""
    c = str(content or "").lower()
    best = None
    best_hits = 0
    for field, kws in _FIELD_KEYWORDS.items():
        hits = sum(1 for k in kws if k in c)
        if hits > best_hits:
            best_hits = hits
            best = field
    return best if best_hits > 0 else None


def parse_profile(content: str) -> dict:
    """解析档案卡 JSON 内容（容错：损坏返回空 dict）。"""
    try:
        data = json.loads(content or "{}")
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def merge_profile(old: dict, new_fields: dict) -> dict:
    """合并档案字段：新值覆盖旧值（单一事实来源）。"""
    merged = dict(old or {})
    for k, v in (new_fields or {}).items():
        if v is not None and str(v).strip():
            merged[k] = str(v).strip()
    return merged


def to_profile_json(data: dict) -> str:
    """序列化档案卡为 JSON 字符串（确保中文字符不被转义）。"""
    return json.dumps(data or {}, ensure_ascii=False)


def summarize_profile(data: dict) -> str:
    """档案卡 → 注入文本（人可读）。字段数固定（覆写式），单字段值截断 80 字防注入膨胀。"""
    if not data:
        return ""
    lines = []
    for k, v in data.items():
        if v:
            lines.append(f"- {k}: {str(v)[:80]}")
    return "\n".join(lines)

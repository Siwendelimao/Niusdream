"""NIS Memory — 统一记忆写入（upsert）：查重 → 语义判定 → 新增/合并/冲突顶替。

所有记忆写入入口（distill 提炼 / memory_add 工具 / 星系 MEMORY_NODE_ADD）统一走这里，
保证：
  - 同作用域+同类型 相似记忆 → 合并更新，不重复堆积
  - 新旧内容等价 → 不覆盖（already_exists）
  - 新旧内容矛盾 → 按来源可信度 / 类型 / 冲突策略 决定顶替或返回 conflict
返回 UpsertVerdict（含 outcome），调用方可据此告知用户"已存在 / 已更新 / 冲突"。
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from core.memory.models import (
    Memory, MemorySourceType, MemoryStatus, MemoryType, ScopeType,
)
from core.memory.text_utils import (
    _search_hint, is_duplicate, semantic_relation, short_title,
)

VALID_NODE_TYPES = {"preference", "decision", "pitfall", "pattern", "fact"}

NODE_TYPE_TO_MEMORY_TYPE = {
    "preference": MemoryType.PREFERENCE,
    "decision": MemoryType.PROJECT_DECISION,
    "pitfall": MemoryType.PROJECT_LESSON,
    "pattern": MemoryType.PROCEDURE,
    "fact": MemoryType.PROJECT_FACT,
}

# 来源可信度优先级：数值越大越可信（冲突顶替时决定谁赢）
SOURCE_PRIORITY = {
    MemorySourceType.USER_EXPLICIT.value: 5,
    MemorySourceType.USER_IMPLICIT.value: 4,
    MemorySourceType.SYSTEM_OBSERVED.value: 3,
    MemorySourceType.SYSTEM_INFER.value: 2,
    MemorySourceType.IMPORTED.value: 1,
}


@dataclass
class UpsertVerdict:
    """一次 upsert 的结果（结构化，供后端返回/前端展示）。"""
    outcome: str                      # created | already_exists | merged | conflict
    memory_id: str = ""
    node_id: str = ""
    title: str = ""
    node_type: str = ""
    scope: str = "project"
    scope_id: Optional[str] = None
    created_at: float = 0.0
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    reason: Optional[str] = None
    hit_id: Optional[str] = None       # 命中的旧记忆 id
    source_type: str = MemorySourceType.SYSTEM_INFER.value

    def to_dict(self) -> dict:
        return {
            "outcome": self.outcome,
            "memory_id": self.memory_id,
            "node_id": self.node_id,
            "title": self.title,
            "node_type": self.node_type,
            "scope": self.scope,
            "created_at": self.created_at,
            "old_content": self.old_content,
            "new_content": self.new_content,
            "reason": self.reason,
            "hit_id": self.hit_id,
            "source_type": self.source_type,
        }


def _gen_id(prefix: str = "mnode") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# 中文 2-gram 关联信号里的停用词（代词/高频虚词/泛偏好动词，共享不算"相关"）
# 关键："喜欢/偏好/用户"等几乎出现在每条偏好里，若不停用会导致偏好全连通
_CN_STOP_BIGRAMS = {
    "用户", "我们", "你们", "他们", "这个", "那个", "一个", "什么", "怎么", "就是",
    "可以", "已经", "还是", "因为", "所以", "但是", "如果", "然后", "知道", "觉得",
    "应该", "现在", "时候", "进行", "使用", "需要", "不是", "非常", "比较", "这样",
    "那样", "没有", "有关", "以及", "或者", "其中", "这些", "那些", "只是",
    "我不", "我", "你", "他", "她",
    # 泛偏好动词（几乎每条偏好都含，共享不表实义相关）
    "喜欢", "偏好", "习惯", "希望", "想要", "爱吃", "开发",
    "避免", "不要", "不用", "别用", "讨厌",
    # AI 写记忆的模板填充词（"用户明确表达…这是个人偏好…在后续…"），共享不代表实义相关
    "明确", "表达", "选择", "相关", "后续", "内容", "推荐", "这是",
    "个人", "元素", "增加", "适当", "融入", "反映", "适合", "户明",
    "户偏", "人偏", "确表", "达喜", "好习", "惯在", "在后", "续对",
    "不喜", "欢小",
}

# embedding 语义关联阈值（bge-small-zh-v1.5 余弦相似度）：≥ 该值视为语义相关（食物/动物/风格归类）
_EMBED_SIM_THRESHOLD = 0.6


def _cn_bigrams(text: str) -> set:
    """提取中文实义 2-gram（过滤停用词），用于关联判定（如'不喜欢鱼腥草'↔'不喜欢大白菜'共享'不喜/喜欢'）。"""
    out = set()
    for i in range(len(text) - 1):
        two = text[i:i + 2]
        if all("\u4e00" <= ch <= "\u9fff" for ch in two) and two not in _CN_STOP_BIGRAMS:
            out.add(two)
    return out


def _find_candidate(
    store,
    content: str,
    scope_type: ScopeType,
    scope_id: str,
    memory_type: MemoryType,
) -> Optional[Memory]:
    """同作用域+同类型 下找高度相似的旧记忆（LCS 相似度 + 显著英文/数字词强信号）。"""
    if not scope_id:
        return None
    full_content = str(content or "").strip()
    candidates = store.search_memories(
        text=_search_hint(content),
        scope_type=scope_type,
        scope_id=scope_id,
        memory_types=[memory_type],
        top_k=20,
    )
    for m in candidates:
        if m.status != MemoryStatus.ACTIVE:
            continue
        old_content = (m.content or "").strip()
        if old_content == full_content:
            return m
        if is_duplicate(full_content, old_content):
            return m
    return None


def _sync_node(store, verdict: UpsertVerdict, tags: list, memory_id: str, content: str) -> str:
    """把记忆同步到 memory_nodes（星系读这张表）。

    created → 新增节点；merged/already_exists → 按 title+scope 复用旧节点（存在则更新内容，否则补建）。
    返回 node_id。
    """
    graph_conn = None
    try:
        from core.memory.memory_graph import MemoryGraph
        graph = MemoryGraph(store)
        graph_conn = graph._conn()
        title = verdict.title or short_title(content, max_len=20)
        now = time.time()
        existing = graph_conn.execute(
            """SELECT id FROM memory_nodes
               WHERE (md_section = ? OR title = ?) AND scope = ?
               AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
               LIMIT 1""",
            (memory_id, title, verdict.scope, verdict.scope_id, verdict.scope_id),
        ).fetchone()
        if existing:
            graph_conn.execute(
                """UPDATE memory_nodes SET content = ?, summary = ?, source_type = ?, md_section = ?, updated_at = ?
                   WHERE id = ?""",
                (content, content[:200], verdict.source_type, memory_id, now, existing["id"]),
            )
            graph_conn.commit()
            return existing["id"]
        node_id = verdict.node_id or _gen_id()
        graph_conn.execute(
            """INSERT INTO memory_nodes (
                id, title, content, summary, node_type, scope, project_id,
                tags, enabled, md_section, source_type, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                node_id, title, content, content[:200],
                verdict.node_type, verdict.scope, verdict.scope_id,
                json.dumps(tags or [], ensure_ascii=False),
                1, memory_id, verdict.source_type, now, now,
            ),
        )
        graph_conn.commit()
        return node_id
    except Exception as e:  # ★0927 netfix：吞错致 graph 与 memory_nodes 两表分叉，至少要可见
        import sys
        print(f"[upsert] graph 写入失败（两表可能分叉）: {e}", file=sys.stderr)
        return verdict.node_id or ""
    finally:
        if graph_conn is not None:
            try:
                graph_conn.close()
            except Exception:
                pass


def _sync_profile(store, content: str, nis_core_scope_id: str = None) -> None:
    """把用户明确说的高可信偏好同步进档案卡（结构化 JSON 字段）。

    归类：内容命中字段关键词（预算/技术栈/风格...）→ 合并进档案记录（新值覆盖旧值）。
    """
    try:
        from core.memory.profile import (
            classify_field, parse_profile, merge_profile, to_profile_json,
        )
        field = classify_field(content)
        if not field:
            return
        # 找现有档案记录（memory_type=user_profile, scope=nis_core）
        from core.memory.models import MemoryType, MemoryStatus, ScopeType
        existing = None
        if nis_core_scope_id:
            cands = store.search_memories(
                scope_type=ScopeType.NIS_CORE,
                scope_id=nis_core_scope_id,
                memory_types=[MemoryType.USER_PROFILE],
                top_k=5,
            )
            existing = cands[0] if cands and cands[0].status == MemoryStatus.ACTIVE else None
        old_data = parse_profile(existing.content) if existing else {}
        # 从内容里提取该字段的值：取"字段名之后/关键词之后"的简短描述
        value = _extract_profile_value(content, field)
        if not value:
            return
        new_data = merge_profile(old_data, {field: value})
        new_json = to_profile_json(new_data)
        if existing:
            try:
                store.update(existing.id, {"content": new_json}, expected_version=existing.version)
            except Exception as e:  # ★0927 netfix：吞错致 profile 表与 memory_nodes 分叉，至少要可见
                import sys
                print(f"[upsert] profile store.update 失败（两表可能分叉）: {e}", file=sys.stderr)
        else:
            mem = Memory(
                id="",
                scope_type=ScopeType.NIS_CORE,
                scope_id=nis_core_scope_id,
                memory_type=MemoryType.USER_PROFILE,
                content=new_json,
                status=MemoryStatus.ACTIVE,
                confidence=0.95,
                importance=0.9,
                tags=["profile"],
                created_by="profile",
                source_type=MemorySourceType.USER_EXPLICIT.value,
            )
            store.add(mem)
    except Exception:
        pass


def _extract_profile_value(content: str, field: str) -> str:
    """从偏好内容里提取字段值（去掉口语前缀/字段名，截断 60 字）。"""
    c = str(content or "").strip()
    if not c:
        return ""
    # 循环剥离口语前缀（"用户喜欢紫色"→剥"用户"→剥"喜欢"→"紫色"）
    prev = None
    while prev != c:
        prev = c
        for pre in ("用户", "我", "我们", "喜欢", "偏好", "希望", "想要", "希望用", "用户偏好", "用户喜欢"):
            if c.startswith(pre):
                c = c[len(pre):].lstrip(" ，,、")
                break
    # 去掉字段名本身（如"预算 5000"→"5000"）
    for fname in ("预算", "技术栈", "风格", "语言", "节奏", "约束", "禁忌"):
        if c.startswith(fname):
            c = c[len(fname):].lstrip(" ：:，,、")
            break
    # 约束类保留否定原样
    if field == "constraints":
        return c[:60] or ""
    for neg in ("不要", "不用", "避免", "不喜欢", "讨厌"):
        if neg in c:
            c = c.replace(neg, "")
    return c[:60] or ""


def load_profile(store, nis_core_scope_id: str = None) -> dict:
    """读取用户档案卡（dict）。无档案返回 {}。"""
    try:
        from core.memory.profile import parse_profile
        from core.memory.models import MemoryType, ScopeType
        if not nis_core_scope_id:
            return {}
        cands = store.search_memories(
            scope_type=ScopeType.NIS_CORE,
            scope_id=nis_core_scope_id,
            memory_types=[MemoryType.USER_PROFILE],
            top_k=3,
        )
        for m in cands:
            if m.status.value == "active":
                return parse_profile(m.content)
    except Exception:
        pass
    return {}


def _is_related(content: str, tags: list, other_content: str, other_tags_raw: str = None, same_type: bool = False) -> bool:
    """两条记忆是否'相关'（自动建边信号）：共享 tag / 共享显著英文词 / 中文实义 2-gram ≥2。

    注意：不用 LCS 相似度信号——AI 写记忆措辞高度模板化（"用户明确表达/偏好/喜欢…"），
    LCS 对这类中文极不鲁棒，会把"喜欢小狗"和"偏好纯前端技术栈"误连。只保留字面精确信号。
    """
    from core.memory.text_utils import _key_tokens, normalize_text
    _na = normalize_text(str(content))
    _nb = normalize_text(str(other_content))
    new_tags = set(tags or [])
    other_tags = set()
    if other_tags_raw:
        try:
            other_tags = set(json.loads(other_tags_raw or "[]"))
        except Exception:
            other_tags = set(str(other_tags_raw).split(","))
    if new_tags & other_tags:
        return True
    self_tokens = _key_tokens(_na)
    other_tokens = _key_tokens(_nb)
    if (self_tokens & other_tokens) and any(
        len(w) >= 3 and re.fullmatch(r"[a-zA-Z0-9]+", w) for w in (self_tokens & other_tokens)
    ):
        return True
    # 中文实义 2-gram 共享 ≥2 才相关（"喜欢/用户/偏好"等泛词已停用，防偏好全连通）
    if len(_cn_bigrams(_na) & _cn_bigrams(_nb)) >= 2:
        return True
    return False


def _auto_link(store, node_id: str, content: str, tags: list, scope: str, scope_id: str, max_links: int = 5) -> int:
    """新增记忆后自动建立关联边（related）。

    与已有启用节点做相似度匹配（阈值低于查重 0.45，用于"相关"而非"重复"），
    命中则连 `related` 边，让星系图谱自动长成关系网（Obsidian 双链思路）。
    返回新建的边数。
    """
    if not node_id or not content:
        return 0
    try:
        from core.memory.memory_graph import MemoryGraph
        graph = MemoryGraph(store)
        conn = graph._conn()
        # 自身类型（用于同类型偏好宽松关联）
        self_row = conn.execute(
            "SELECT node_type FROM memory_nodes WHERE id = ?", (node_id,)
        ).fetchone()
        self_type = self_row["node_type"] if self_row else ""
        # 候选：同 scope 下的其它启用节点
        rows = conn.execute(
            """SELECT id, title, content, tags, node_type FROM memory_nodes
               WHERE enabled = 1 AND id != ? AND scope = ?
               AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
               LIMIT 300""",
            (node_id, scope, scope_id, scope_id),
        ).fetchall()
        if not rows:
            conn.close()
            return 0

        # 已有边（避免重复连）
        existing_edges = set()
        for r in conn.execute(
            "SELECT source_node, target_node FROM memory_edges WHERE source_node = ? OR target_node = ?",
            (node_id, node_id),
        ).fetchall():
            existing_edges.add((r["source_node"], r["target_node"]))
        conn.close()

        linked = 0
        for row in rows:
            if linked >= max_links:
                break
            rid = row["id"]
            pair_a, pair_b = (node_id, rid), (rid, node_id)
            if pair_a in existing_edges or pair_b in existing_edges:
                continue
            other_content = str(row["content"] or "")
            if _is_related(content, tags, other_content, row["tags"], same_type=(self_type == row["node_type"])):
                graph.add_edge(node_id, rid, "related")
                existing_edges.add(pair_a)
                linked += 1

        # embedding 语义关联：新记忆 encode 一次，查语义相近的已有记忆（>阈值连边），
        # 补上字面匹配做不到的语义归类（"猪肉/大白菜/鱼腥草"都是食物等）
        if linked < max_links and hasattr(store, "search_similar"):
            try:
                sims = store.search_similar(content, scope_id, top_k=20, min_score=_EMBED_SIM_THRESHOLD)
                conn = graph._conn()
                for mid, _score in sims:
                    if linked >= max_links:
                        break
                    row = conn.execute(
                        "SELECT id FROM memory_nodes WHERE md_section = ? AND enabled = 1 AND id != ? LIMIT 1",
                        (mid, node_id),
                    ).fetchone()
                    if not row:
                        continue
                    rid = row["id"]
                    pair_a, pair_b = (node_id, rid), (rid, node_id)
                    if pair_a in existing_edges or pair_b in existing_edges:
                        continue
                    graph.add_edge(node_id, rid, "related")
                    existing_edges.add(pair_a)
                    linked += 1
                conn.close()
            except Exception:
                pass
        return linked
    except Exception:
        return 0


def link_all_pairs(store, scope: str = None, max_links_per_node: int = 5) -> int:
    """一次性补边：对存量启用节点全量跑关联信号，补齐缺失的 related 边（幂等，已有边跳过）。"""
    try:
        from core.memory.memory_graph import MemoryGraph
        g = MemoryGraph(store)
        conn = g._conn()
        if scope:
            rows = conn.execute(
                "SELECT id, content, tags, scope, project_id, node_type FROM memory_nodes WHERE enabled = 1 AND scope = ?",
                (scope,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, content, tags, scope, project_id, node_type FROM memory_nodes WHERE enabled = 1"
            ).fetchall()
        conn.close()
        added = 0
        for i, a in enumerate(rows):
            a_linked = 0
            for j, b in enumerate(rows):
                if i == j or a_linked >= max_links_per_node:
                    continue
                if a["scope"] != b["scope"]:
                    continue
                if (a["project_id"] or None) != (b["project_id"] or None):
                    continue
                # 已有边跳过
                dup = g._conn().execute(
                    "SELECT id FROM memory_edges WHERE (source_node = ? AND target_node = ?) OR (source_node = ? AND target_node = ?)",
                    (a["id"], b["id"], b["id"], a["id"]),
                ).fetchone()
                if dup:
                    continue
                if _is_related(str(a["content"] or ""), [], str(b["content"] or ""), b["tags"],
                               same_type=(a["node_type"] == b["node_type"])):
                    g.add_edge(a["id"], b["id"], "related")
                    added += 1
                    a_linked += 1
            # embedding 语义补边：为当前节点查语义相近的已有记忆（字面匹配做不到的归类）
            if a_linked < max_links_per_node and hasattr(store, "search_similar"):
                try:
                    _sid = (a["project_id"] or "").strip()
                    if not _sid:
                        continue
                    sims = store.search_similar(str(a["content"] or ""), _sid, top_k=20, min_score=_EMBED_SIM_THRESHOLD)
                    for mid, _s in sims:
                        if a_linked >= max_links_per_node:
                            break
                        r = g._conn().execute(
                            "SELECT id FROM memory_nodes WHERE md_section = ? AND enabled = 1 AND id != ? LIMIT 1",
                            (mid, a["id"]),
                        ).fetchone()
                        if not r:
                            continue
                        rid = r["id"]
                        dup = g._conn().execute(
                            "SELECT id FROM memory_edges WHERE (source_node = ? AND target_node = ?) OR (source_node = ? AND target_node = ?)",
                            (a["id"], rid, rid, a["id"]),
                        ).fetchone()
                        if dup:
                            continue
                        g.add_edge(a["id"], rid, "related")
                        added += 1
                        a_linked += 1
                except Exception:
                    pass
        return added
    except Exception:
        return 0


def _apply_replace(store, existing: Memory, verdict: UpsertVerdict, content: str, source_type: str) -> None:
    """顶替旧记忆：更新内容 + 来源类型 + 提升可信度（乐观锁，冲突时跳过）。"""
    try:
        store.update(
            existing.id,
            {
                "content": content,
                "source_type": source_type,
                "confidence": 0.95,
            },
            expected_version=existing.version,
        )
    except Exception:
        pass


def upsert_memory(
    store,
    *,
    title: str,
    content: str,
    node_type: str,
    scope: str = "project",
    scope_id: str = None,
    tags: list = None,
    source_type: str = MemorySourceType.SYSTEM_INFER.value,
    created_by: str = "distill",
    confidence: float = 0.9,
    importance: float = 0.85,
    conflict_mode: str = "auto",     # auto: 按来源优先级顶替; ask: 一律返回 conflict 交给用户
    force_replace: bool = False,     # 冲突时强制顶替旧记忆（用户确认后）
    dry_run: bool = False,           # 只判定 outcome 不落库（提炼预览）
) -> UpsertVerdict:
    """统一记忆 upsert：查重 → 语义判定 → 新增/合并/冲突。

    Args:
        title: 记忆标题
        content: 记忆完整内容
        node_type: preference/decision/pitfall/pattern/fact
        scope: global/project
        scope_id: 作用域 id（global → nis_core scope id；project → project id）
        source_type: MemorySourceType 值（user_explicit / system_infer / ...）
        conflict_mode: "auto" 自动按来源优先级决策顶替；"ask" 一律返回 conflict
        force_replace: 冲突时是否强制顶替（用户显式确认）
    """
    if node_type not in VALID_NODE_TYPES:
        raise ValueError(f"Invalid node_type: {node_type}. Must be one of {VALID_NODE_TYPES}")

    now = time.time()
    full_content = str(content or "").strip()
    short = short_title(title or content, max_len=20)
    memory_type = NODE_TYPE_TO_MEMORY_TYPE.get(node_type, MemoryType.SEMANTIC)
    scope_type = ScopeType.NIS_CORE if scope == "global" else ScopeType.PROJECT
    new_priority = SOURCE_PRIORITY.get(source_type, 0)

    verdict = UpsertVerdict(
        outcome="created",
        title=short,
        node_type=node_type,
        scope=scope,
        scope_id=scope_id,
        created_at=now,
        new_content=full_content,
        source_type=source_type,
    )

    existing = _find_candidate(store, full_content, scope_type, scope_id, memory_type)
    if existing is not None:
        old_content = (existing.content or "").strip()
        old_source = existing.source_type or MemorySourceType.SYSTEM_INFER.value
        old_priority = SOURCE_PRIORITY.get(old_source, 0)
        relation = semantic_relation(old_content, full_content)
        verdict.hit_id = existing.id
        verdict.memory_id = existing.id
        verdict.old_content = old_content

        if relation == "equivalent":
            # 内容等价：不覆盖旧措辞，但新来源更可信（如用户明确表达）→ 升级转正
            #（例：自动提炼先落了 pending_review，用户随后明确说同样的话 → 直接转正，无需再进审核区）
            upgrade = (
                new_priority > old_priority
                and (
                    existing.source_type != source_type
                    or "pending_review" in (existing.tags or [])
                )
            )
            verdict.outcome = "merged" if upgrade else "already_exists"
            verdict.reason = "来源更可信（用户明确表达），旧记忆转正升级" if upgrade else "与已有记忆内容等价"
            if not dry_run:
                if upgrade:
                    try:
                        store.update(
                            existing.id,
                            {
                                "source_type": source_type,
                                "importance": max(existing.importance or 0.0, importance),
                                "confidence": max(existing.confidence or 0.0, confidence),
                                "tags": tags or [],
                            },
                            expected_version=existing.version,
                        )
                    except Exception:
                        pass
                verdict.node_id = _sync_node(store, verdict, tags or [], existing.id, old_content)
                if upgrade and verdict.node_id:
                    # 星系节点：来源转正 + 清掉 pending_review 标记（保留其它 tag）
                    try:
                        from core.memory.memory_graph import MemoryGraph
                        g = MemoryGraph(store)
                        conn = g._conn()
                        row = conn.execute(
                            "SELECT tags FROM memory_nodes WHERE id = ?", (verdict.node_id,)
                        ).fetchone()
                        conn.close()
                        old_node_tags = []
                        try:
                            old_node_tags = json.loads(row["tags"] or "[]") if row and row["tags"] else []
                        except Exception:
                            pass
                        merged_tags = [t for t in old_node_tags if t != "pending_review"]
                        for t in (tags or []):
                            if t not in merged_tags:
                                merged_tags.append(t)
                        g.update_node(verdict.node_id, source_type=source_type, tags=merged_tags)
                    except Exception:
                        pass
                # P1-1：用户明确说的高可信偏好 → 同步档案卡
                if upgrade and source_type == MemorySourceType.USER_EXPLICIT.value and scope == "global" and node_type == "preference":
                    _sync_profile(store, full_content, nis_core_scope_id=scope_id)
            return verdict

        if relation == "contradicts":
            # 冲突：按来源优先级 / 强制顶替 决策
            if force_replace or (conflict_mode == "auto" and new_priority > old_priority):
                verdict.outcome = "merged"
                verdict.reason = f"新旧内容矛盾，来源优先级更高（{source_type}）顶替旧记忆"
                if not dry_run:
                    _apply_replace(store, existing, verdict, full_content, source_type)
                    verdict.node_id = _sync_node(store, verdict, tags or [], existing.id, full_content)
                    _auto_link(store, verdict.node_id, full_content, tags or [], scope, scope_id)
                    # P1-1：用户明确改口 → 同步档案卡（顶替旧字段值）
                    if source_type == MemorySourceType.USER_EXPLICIT.value and scope == "global" and node_type == "preference":
                        _sync_profile(store, full_content, nis_core_scope_id=scope_id)
            else:
                verdict.outcome = "conflict"
                verdict.reason = "新旧内容矛盾，需用户确认是否顶替"
                verdict.node_id = ""
            return verdict

        if relation == "extends":
            # 同主题补充/更完整 → 合并更新（新内容更完整则覆盖，否则保留旧）
            verdict.outcome = "merged"
            if len(full_content) > len(old_content):
                verdict.reason = "同主题内容更完整，合并更新"
                if not dry_run:
                    _apply_replace(store, existing, verdict, full_content, source_type)
            else:
                verdict.reason = "已有记忆更完整，保留旧内容"
            if not dry_run:
                verdict.node_id = _sync_node(store, verdict, tags or [], existing.id, full_content)
                _auto_link(store, verdict.node_id, full_content, tags or [], scope, scope_id)
            return verdict

    # created：新增
    if dry_run:
        verdict.outcome = "created"
        return verdict
    mem = Memory(
        id="",
        scope_type=scope_type,
        scope_id=scope_id,
        memory_type=memory_type,
        content=full_content,
        status=MemoryStatus.ACTIVE,
        confidence=confidence,
        importance=importance,
        tags=tags or [],
        created_by=created_by,
        source_type=source_type,
    )
    store.add(mem)
    verdict.memory_id = mem.id
    verdict.node_id = _sync_node(store, verdict, tags or [], mem.id, full_content)
    _auto_link(store, verdict.node_id, full_content, tags or [], scope, scope_id)
    # P1-1：用户明确说的高可信偏好 → 同步档案卡（结构化字段，读取精确）
    if (
        not dry_run
        and source_type == MemorySourceType.USER_EXPLICIT.value
        and scope == "global"
        and node_type == "preference"
    ):
        _sync_profile(store, full_content, nis_core_scope_id=scope_id)
    return verdict

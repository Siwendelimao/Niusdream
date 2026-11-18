"""NIS Memory System — Database Schema"""

from __future__ import annotations

import os
import sqlite3


SCHEMA_SQL = """
-- 作用域表
CREATE TABLE IF NOT EXISTS scopes (
    id              TEXT PRIMARY KEY,
    scope_type      TEXT NOT NULL,
    owner_id        TEXT,
    parent_scope_id TEXT REFERENCES scopes(id),
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scopes_type ON scopes(scope_type);
CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes(parent_scope_id);
CREATE INDEX IF NOT EXISTS idx_scopes_status ON scopes(status);

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    scope_id        TEXT NOT NULL REFERENCES scopes(id),
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    goal            TEXT,
    tech_stack      TEXT,
    current_phase   TEXT,
    progress        REAL DEFAULT 0,
    root_path       TEXT,
    created_at      REAL NOT NULL,
    archived_at     REAL,
    knowledge_enabled INTEGER NOT NULL DEFAULT 0,
    knowledge_top_k INTEGER NOT NULL DEFAULT 3,
    knowledge_max_chars INTEGER NOT NULL DEFAULT 500
);

CREATE INDEX IF NOT EXISTS idx_projects_scope ON projects(scope_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- 窗口表
CREATE TABLE IF NOT EXISTS windows (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id),
    scope_id        TEXT REFERENCES scopes(id),
    title           TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    state_json      TEXT,
    created_at      REAL NOT NULL,
    closed_at       REAL
);

CREATE INDEX IF NOT EXISTS idx_windows_project ON windows(project_id);
CREATE INDEX IF NOT EXISTS idx_windows_scope ON windows(scope_id);
CREATE INDEX IF NOT EXISTS idx_windows_status ON windows(status);

-- 项目伙伴成员表（分身项目成员名单：启用的进任务流程，停用的不进入）
CREATE TABLE IF NOT EXISTS project_partners (
    project_id      TEXT NOT NULL REFERENCES projects(id),
    partner_id      TEXT NOT NULL,          -- 与 partner_registry 的英文名对齐（Luna / WebSurfer ...）
    enabled         INTEGER NOT NULL DEFAULT 1,   -- 1=启用 0=停用
    added_by        TEXT NOT NULL DEFAULT 'user', -- nis / user / auto
    reason          TEXT,
    created_at      REAL NOT NULL,
    PRIMARY KEY (project_id, partner_id)
);

CREATE INDEX IF NOT EXISTS idx_projpart_project ON project_partners(project_id);
CREATE INDEX IF NOT EXISTS idx_projpart_enabled ON project_partners(enabled);

-- 项目状态摘要表（Redis 缓存的 SQL 替代）
CREATE TABLE IF NOT EXISTS project_state_snapshots (
    project_id      TEXT PRIMARY KEY REFERENCES projects(id),
    summary_json    TEXT NOT NULL,
    updated_at      REAL NOT NULL
);

-- 主记忆表
CREATE TABLE IF NOT EXISTS memory_records (
    id                  TEXT PRIMARY KEY,
    scope_type          TEXT NOT NULL,
    scope_id            TEXT NOT NULL REFERENCES scopes(id),
    memory_type         TEXT NOT NULL,
    subtype             TEXT,
    content             TEXT NOT NULL,
    structured_value    TEXT,
    status              TEXT NOT NULL DEFAULT 'candidate',
    confidence          REAL NOT NULL DEFAULT 0.8,
    importance          REAL NOT NULL DEFAULT 0.5,
    source_reliability  REAL NOT NULL DEFAULT 0.8,
    valid_from          REAL,
    valid_until         REAL,
    observed_at         REAL,
    recorded_at         REAL NOT NULL,
    last_confirmed_at   REAL,
    timezone            TEXT DEFAULT 'Asia/Shanghai',
    time_precision      TEXT DEFAULT 'exact',
    temporal_source     TEXT DEFAULT 'system_recorded',
    version             INTEGER NOT NULL DEFAULT 1,
    supersedes          TEXT REFERENCES memory_records(id),
    superseded_by       TEXT REFERENCES memory_records(id),
    source_type         TEXT,
    source_event_ids    TEXT,
    source_window_id    TEXT,
    source_agent_id     TEXT,
    created_by          TEXT NOT NULL,
    approved_by         TEXT,
    user_override       INTEGER DEFAULT 0,
    policy_lock         INTEGER DEFAULT 0,
    tags                TEXT,
    search_keywords     TEXT,
    embedding_provider  TEXT,
    embedding_model     TEXT,
    embedding_dimensions INTEGER,
    embedding_version   TEXT,
    vector_id           TEXT,
    indexed_at          REAL,
    reindex_status      TEXT DEFAULT 'pending',
    retention_policy    TEXT DEFAULT 'default',
    closed_at           REAL,
    archived_at         REAL,
    searchable_after_close INTEGER DEFAULT 0,
    consolidation_eligible INTEGER DEFAULT 1,
    auto_purge_at       REAL,
     created_at          REAL NOT NULL,
     updated_at          REAL NOT NULL,
     deleted_at          REAL,
     hard_deleted_at     REAL
);

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_records(status);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_records(memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_valid ON memory_records(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_memory_vector ON memory_records(vector_id);
CREATE INDEX IF NOT EXISTS idx_memory_reindex ON memory_records(reindex_status);
CREATE INDEX IF NOT EXISTS idx_memory_confidence ON memory_records(confidence);
CREATE INDEX IF NOT EXISTS idx_memory_retention ON memory_records(auto_purge_at);

-- FTS5 全文检索（使用 trigram 分词器支持中文）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    search_keywords,
    content='memory_records',
    content_rowid='rowid',
    tokenize='trigram'
);

-- FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_records BEGIN
    INSERT INTO memory_fts(rowid, content, search_keywords)
    VALUES (new.rowid, new.content, COALESCE(new.search_keywords, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_records BEGIN
    -- 外部内容表正确做法：先删后插，避免 trigram 分词器直接 UPDATE 内容导致索引损坏
    INSERT INTO memory_fts(memory_fts, rowid, content, search_keywords)
    VALUES ('delete', old.rowid, old.content, COALESCE(old.search_keywords, ''));
    INSERT INTO memory_fts(rowid, content, search_keywords)
    VALUES (new.rowid, new.content, COALESCE(new.search_keywords, ''));
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_records BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, search_keywords)
    VALUES ('delete', old.rowid, old.content, COALESCE(old.search_keywords, ''));
END;

-- 事件日志表（不可变）
CREATE TABLE IF NOT EXISTS memory_events (
    event_id            TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    memory_id           TEXT NOT NULL,
    aggregate_id        TEXT NOT NULL,
    aggregate_version   INTEGER NOT NULL,
    idempotency_key     TEXT UNIQUE,
    causation_id        TEXT,
    correlation_id      TEXT,
    actor_type          TEXT NOT NULL,
    actor_id            TEXT NOT NULL,
    previous_status     TEXT,
    new_status          TEXT,
    previous_value      TEXT,
    new_value           TEXT,
    reason              TEXT,
    source_message_id   TEXT,
    occurred_at         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_memory ON memory_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_event_type ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_event_time ON memory_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_idempotent ON memory_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_event_aggregate ON memory_events(aggregate_id, aggregate_version);

-- 候选提案表
CREATE TABLE IF NOT EXISTS memory_proposals (
    id                          TEXT PRIMARY KEY,
    source_scope_type           TEXT NOT NULL,
    source_scope_id             TEXT NOT NULL,
    target_scope_type           TEXT NOT NULL,
    target_scope_id             TEXT,
    memory_type                 TEXT NOT NULL,
    content                     TEXT NOT NULL,
    structured_value            TEXT,
    evidence                    TEXT,
    confidence                  REAL,
    importance                  REAL,
    proposed_by                 TEXT NOT NULL,
    promotion_reason            TEXT,
    requires_user_confirmation   INTEGER DEFAULT 1,
    status                      TEXT NOT NULL DEFAULT 'pending',
    reviewed_by                 TEXT,
    reviewed_at                 REAL,
    created_at                  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_status ON memory_proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposal_target ON memory_proposals(target_scope_type, target_scope_id);

-- 用户控制规则表
CREATE TABLE IF NOT EXISTS memory_control_rules (
    id                  TEXT PRIMARY KEY,
    rule_type           TEXT NOT NULL,
    target_memory_type  TEXT,
    target_subtype      TEXT,
    target_key          TEXT,
    pattern             TEXT,
    semantic_condition  TEXT,
    scope_type          TEXT,
    priority            INTEGER DEFAULT 0,
    is_active           INTEGER DEFAULT 1,
    expires_at          REAL,
    created_at          REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_type ON memory_control_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_rule_active ON memory_control_rules(is_active);

-- 去重配置表
CREATE TABLE IF NOT EXISTS dedup_config (
    id                  TEXT PRIMARY KEY,
    embedding_model     TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    memory_type         TEXT,
    threshold           REAL NOT NULL,
    calibrated_at       REAL,
    calibration_samples INTEGER,
    is_active           INTEGER DEFAULT 1
);

-- 索引元数据表
CREATE TABLE IF NOT EXISTS index_metadata (
    key                 TEXT PRIMARY KEY,
    value               TEXT NOT NULL,
    updated_at          REAL NOT NULL
);

-- ── Phase 5.5: 记忆网图（.md 索引） ──────────────────────

-- 记忆节点表（提炼的记忆索引，供搜索/网图使用）
CREATE TABLE IF NOT EXISTS memory_nodes (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    content             TEXT NOT NULL,
    summary             TEXT NOT NULL,
    node_type           TEXT NOT NULL,          -- preference/decision/pitfall/pattern/fact
    scope               TEXT NOT NULL,          -- global/project
    project_id          TEXT,
    tags                TEXT,                   -- JSON 数组
    enabled             INTEGER DEFAULT 1,      -- 0=停用 1=启用
    md_file             TEXT,                   -- 关联的 .md 文件路径
    md_section          TEXT,                   -- .md 文件中的标题锚点
    source_window       TEXT,                   -- 来源窗口
    source_conversation TEXT,                   -- 来源对话文件
    source_type         TEXT,                   -- 来源类型（user_explicit/system_infer/...）
    created_at          REAL NOT NULL,
    updated_at          REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mnode_scope ON memory_nodes(scope);
CREATE INDEX IF NOT EXISTS idx_mnode_type ON memory_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_mnode_enabled ON memory_nodes(enabled);
CREATE INDEX IF NOT EXISTS idx_mnode_project ON memory_nodes(project_id);

-- 记忆关系表
CREATE TABLE IF NOT EXISTS memory_edges (
    id                  TEXT PRIMARY KEY,
    source_node         TEXT NOT NULL REFERENCES memory_nodes(id),
    target_node         TEXT NOT NULL REFERENCES memory_nodes(id),
    relation            TEXT NOT NULL,          -- uses/has_pitfall/validated_by/related
    created_at          REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_medge_source ON memory_edges(source_node);
CREATE INDEX IF NOT EXISTS idx_medge_target ON memory_edges(target_node);

-- FTS5 全文索引（标题 + 摘要 + tags）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
    title, summary, tags,
    content='memory_nodes',
    content_rowid='rowid',
    tokenize='trigram'
);

-- FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS mnode_fts_insert AFTER INSERT ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(rowid, title, summary, tags)
    VALUES (new.rowid, new.title, new.summary, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS mnode_fts_update AFTER UPDATE ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, title, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, COALESCE(old.tags, ''));
    INSERT INTO memory_nodes_fts(rowid, title, summary, tags)
    VALUES (new.rowid, new.title, new.summary, COALESCE(new.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS mnode_fts_delete AFTER DELETE ON memory_nodes BEGIN
    INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, title, summary, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, COALESCE(old.tags, ''));
END;

-- ── v2.0: 画板标注标签 ──────────────────────────────

CREATE TABLE IF NOT EXISTS annotation_tags (
    tag_id          TEXT PRIMARY KEY,
    tag_type        TEXT NOT NULL DEFAULT 'element',
    label           TEXT NOT NULL DEFAULT '',
    element_id      TEXT,
    region          TEXT,
    points          TEXT,
    image_src       TEXT,
    image_region    TEXT,
    position        TEXT,
    color           TEXT DEFAULT '#1890ff',
    created_at      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_tag_type ON annotation_tags(tag_type);
"""


def init_db(db_path: str) -> None:
    """初始化数据库 schema"""
    parent = os.path.dirname(db_path)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    _migrate_projects_table(conn)
    _migrate_annotation_tags_table(conn)
    _migrate_memory_nodes_table(conn)
    _rebuild_fts_triggers(conn)
    conn.commit()
    conn.close()


def _rebuild_fts_triggers(conn: sqlite3.Connection) -> None:
    """重建 FTS 同步触发器为'先删后插'版本（trigram 分词器直接 UPDATE 内容会损坏索引）。
    旧库可能残留旧版触发器，先 DROP 再按新 SCHEMA 重建。"""
    for name in ("memory_fts_insert", "memory_fts_update", "memory_fts_delete",
                 "mnode_fts_insert", "mnode_fts_update", "mnode_fts_delete"):
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")
    # 从 SCHEMA_SQL 里重新创建这几个触发器（executescript 含 IF NOT EXISTS，故先 drop 后再跑全量即可）
    conn.executescript(SCHEMA_SQL)

def _migrate_projects_table(conn: sqlite3.Connection) -> None:
    """迁移 projects 表，新增知识库配置列"""
    existing = conn.execute("PRAGMA table_info(projects)").fetchall()
    col_names = {row[1] for row in existing}
    # #13 旧库缺 root_path 列（项目创建直接报错；WORKSPACE_LIST/get_project 读不到根路径
    # → 流程模式被静默跳过 → AI 不澄清不列伙伴直接单干。必须补列）
    if "root_path" not in col_names:
        conn.execute("ALTER TABLE projects ADD COLUMN root_path TEXT")
    if "knowledge_enabled" not in col_names:
        conn.execute("ALTER TABLE projects ADD COLUMN knowledge_enabled INTEGER NOT NULL DEFAULT 0")
    if "knowledge_top_k" not in col_names:
        conn.execute("ALTER TABLE projects ADD COLUMN knowledge_top_k INTEGER NOT NULL DEFAULT 3")
    if "knowledge_max_chars" not in col_names:
        conn.execute("ALTER TABLE projects ADD COLUMN knowledge_max_chars INTEGER NOT NULL DEFAULT 500")


def _migrate_memory_nodes_table(conn: sqlite3.Connection) -> None:
    """迁移 memory_nodes 表，新增来源类型列（来源影响可信度展示）。"""
    existing = conn.execute("PRAGMA table_info(memory_nodes)").fetchall()
    col_names = {row[1] for row in existing}
    if "source_type" not in col_names:
        conn.execute("ALTER TABLE memory_nodes ADD COLUMN source_type TEXT")


def _migrate_annotation_tags_table(conn: sqlite3.Connection) -> None:
    """迁移 annotation_tags 表（v2.0 新增）"""
    existing = conn.execute("PRAGMA table_info(annotation_tags)").fetchall()
    if not existing:
        conn.execute("""
            CREATE TABLE annotation_tags (
                tag_id          TEXT PRIMARY KEY,
                tag_type        TEXT NOT NULL DEFAULT 'element',
                label           TEXT NOT NULL DEFAULT '',
                element_id      TEXT,
                region          TEXT,
                points          TEXT,
                image_src       TEXT,
                image_region    TEXT,
                position        TEXT,
                color           TEXT DEFAULT '#1890ff',
                created_at      REAL NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ann_tag_type ON annotation_tags(tag_type)")

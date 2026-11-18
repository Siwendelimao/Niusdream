/**
 * sessionIndex.ts —— L2 派生全文索引（node:sqlite / WAL / 普通表 LIKE，**无 FTS5**）。
 *
 * 分层：正文（JSONL / 老 .json）是唯一真源；index.db 是可随时完整重建的派生数据。
 * 为什么不用 FTS5：施工单 §0.3 实测 unicode61/trigram 对 2 字中文 0 命中，
 * 自建 2-gram 能搜但索引膨胀到 455MB；38MB 可索引文本下 LIKE ≈455ms 已够用。
 *
 * 铁律：
 *  · 只索引 user/text + assistant/text（提取逻辑只在 sessionIndexCore.mjs 一处）。
 *  · 索引缺失/未完成/损坏 ⇒ **抛明确错误**，绝不静默回退"全量扫 854MB"。
 *  · 索引写失败 ⇒ 不阻塞主流程，但必须 ERROR 留痕（由 server.ts 的回调统一节流）。
 */
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
// @ts-ignore 纯 JS 共享核心，没有 .d.ts（_tscheck 的致命类门禁不受影响）
import { SCHEMA_VERSION, buildIndexRows, extractIndexText, pickMessages } from './sessionIndexCore.mjs'

let db: DatabaseSync | null = null
let dbPath = ''
let unusableReason = ''

/** 初始化（server.ts 在 DATA_ROOT 确定后调用一次；重复调用以最后一次为准）。不建库、不补库。 */
export function configureSessionIndex(p: string): void {
  closeSessionIndex()
  dbPath = p
  unusableReason = ''
}

export function closeSessionIndex(): void {
  if (db) {
    try { db.close() } catch (e) { console.error('[session-index] 关闭失败：', String((e as any)?.message || e)) }
    db = null
  }
}

function indexFile(): string {
  if (!dbPath) throw new Error('[session-index] 未配置索引路径（configureSessionIndex 未调用）')
  return dbPath
}

/** 打开**已建好**的索引库。缺库/半成品/坏库一律抛错 —— 不是兜底，是拒绝静默降级。 */
function requireDb(): DatabaseSync {
  const f = indexFile()
  /* 每次都核对磁盘事实：索引文件被删/被换掉后，不能拿已缓存的 db 句柄继续查
     （那是把"内存里还开着"当成"索引还可用"，等于静默降级）。 */
  if (!fs.existsSync(f)) {
    if (db) { try { db.close() } catch { /* 文件已不存在，关闭失败不改变结论 */ } db = null }
    unusableReason = `索引未建立（${path.basename(f)} 不存在）`
    throw new Error(`[session-index] ${unusableReason}。请运行 node backend/_reindex.mjs 或调用 session.reindex；不会回退全量扫描。`)
  }
  if (db) return db
  let d: DatabaseSync
  try { d = new DatabaseSync(f) } catch (e) {
    unusableReason = `索引打不开：${String((e as any)?.message || e)}`
    throw new Error(`[session-index] ${unusableReason}；请删库重建（session.reindex），不会回退全量扫描。`)
  }
  try {
    const complete = d.prepare("SELECT v FROM meta WHERE k='complete'").get() as any
    const version = d.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as any
    if (!complete || String(complete.v) !== '1') {
      throw new Error(`索引未完成（complete=${complete ? complete.v : '缺失'}），可能是上次重建中断的半成品`)
    }
    if (!version || String(version.v) !== SCHEMA_VERSION) {
      throw new Error(`索引 schema 版本不符（${version ? version.v : '缺失'} != ${SCHEMA_VERSION}）`)
    }
    d.exec('PRAGMA journal_mode = WAL')
    d.exec('PRAGMA synchronous = NORMAL')
  } catch (e) {
    try { d.close() } catch { /* 关闭失败不改变"索引不可用"的事实 */ }
    unusableReason = String((e as any)?.message || e)
    throw new Error(`[session-index] ${unusableReason}；请调用 session.reindex 重建，不会回退全量扫描。`)
  }
  db = d
  unusableReason = ''
  return db
}

/** LIKE 通配转义，防止 query 里的 %/_ 变成通配（ESCAPE '\' 与之配套）。 */
function likePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, (c) => '\\' + c)
  return '%' + esc + '%'
}

function snippetOf(text: any, q: string, titleHit: boolean): string {
  if (titleHit || typeof text !== 'string' || !text) return ''
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return ''
  const from = Math.max(0, i - 24)
  return text.slice(from, i + q.length + 60).replace(/\s+/g, ' ').trim()
}

export interface SearchHit {
  sessionId: string
  title: string
  snippet: string
  updatedAt: number
}

/** ★1130：**一条命中**（消息级）—— 老板实测"能搜到对话、但定位不到具体某一条"的直接修复。
 *  `turnNo` 是定位用的（前端 `scrollToTurn(turnNo)` 已有完整实现：补齐历史 + 闪烁高亮）；
 *  `eventId/seq` 留给将来做"同一条消息内多处高亮"用（本次没做，B 方案）。 */
export interface SearchEventHit {
  sessionId: string
  title: string
  updatedAt: number
  /** 第几轮（1 基；0 = 该消息在第一个 user 之前，正常不会有） */
  turnNo: number
  seq: number
  eventId: string
  role: string
  ts: number
  snippet: string
}

export interface SearchResult {
  hits: SearchEventHit[]
  /** 还有更多（同窗口内被 limit 截断，或窗口之外还有数据） */
  hasMore: boolean
  /** 本次实际搜了多大窗口（天）；0 = 不限（全部） */
  windowDays: number
}

/**
 * ★1130 **消息级检索**（取代原来的"每会话一条"）：标题 + 只含 text 块的 events，普通表 LIKE。
 *
 * 为什么要改（实测）：原来 SQL 用 `(SELECT … LIMIT 1)` 每会话只取**一条**命中事件，返回
 * `{sessionId,title,snippet,updatedAt}` —— 搜"规则"全库命中 **1456 条消息 / 211 个会话**，
 * 接口只回 12 条会话级结果，**1444 条命中细节全丢掉**，前端拿不到 `turn_no`/`event_id`
 * ⇒ 只能"打开会话"，没法定位到具体某一条。
 *
 * 口径（三条）：
 *   · **先搜近期**（老板拍板）：默认只搜 `windowDays` 天内的会话；`windowDays=0` = 全部。
 *     实测分布：≤7 天 27 个会话 / ≤30 天 428 个（61%）/ ≤90 天 701 个（全部），
 *     所以默认窗口取 30 天，既覆盖大头又让 LIKE 快得多。
 *   · **每会话最多 `perSession` 条**命中：一轮对话里同一个词出现几十次时，没必要把几十行都列出来
 *     （用户要的是"哪几条消息提到"，不是把整段话打出来）。
 *   · **`hasMore` 说实话**：不是"猜还有没有"，而是 `总数 > 已返回` 这个事实。
 */
export function sessionIndexSearchEvents(
  q: string,
  opts: { windowDays?: number; limit?: number; perSession?: number } = {},
): SearchResult {
  const query = String(q || '').trim()
  const windowDays = Math.max(0, Math.floor(Number(opts.windowDays) || 0))
  const limit = Math.max(1, Math.min(Number(opts.limit) || 60, 300))
  const perSession = Math.max(1, Math.min(Number(opts.perSession) || 5, 20))
  if (!query) return { hits: [], hasMore: false, windowDays }
  const d = requireDb()
  const like = likePattern(query)
  const since = windowDays > 0 ? Date.now() - windowDays * 86400000 : 0

  /* 窗口条件对 events 只需要"它所属会话的 updated_at"；用 IN 子查询走 idx_sessions_updated。
     每会话条数用 `ROW_NUMBER()` 窗口函数（SQLite 3.25+，node:sqlite 自带的新版本支持）。 */
  const rows = d.prepare(`
    WITH matched AS (
      SELECT e.session_id, e.turn_no, e.seq, e.event_id, e.role, e.ts, e.text,
             ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.seq) AS rn
      FROM events e
      WHERE e.text LIKE ? ESCAPE '\\'
        AND e.session_id IN (SELECT id FROM sessions WHERE updated_at >= ?)
    ),
    picked AS (
      SELECT m.* FROM matched m WHERE m.rn <= ?
    ),
    total AS (
      SELECT COUNT(*) AS n FROM matched
    )
    SELECT p.*, s.title AS title, s.updated_at AS updatedAt, (SELECT n FROM total) AS totalMatched
    FROM picked p JOIN sessions s ON s.id = p.session_id
    ORDER BY s.updated_at DESC, p.seq
    LIMIT ?
  `).all(like, since, perSession, limit) as any[]

  const totalMatched = rows.length ? Number(rows[0].totalMatched) || 0 : 0
  const hits: SearchEventHit[] = rows.map((r) => ({
    sessionId: String(r.session_id),
    title: String(r.title || ''),
    updatedAt: Number(r.updatedAt) || 0,
    turnNo: Number(r.turn_no) || 0,
    seq: Number(r.seq) || 0,
    eventId: String(r.event_id || ''),
    role: String(r.role || ''),
    ts: Number(r.ts) || 0,
    snippet: snippetOf(String(r.text || ''), query, false),
  }))

  /* hasMore 判据（两个来源，都说实话）：
     ① 同窗口内被 limit / perSession 截断（totalMatched 是**未截断**的真实命中数）；
     ② 窗口之外可能还有（windowDays>0 时无法廉价知道，保守给 true —— 但只在"本窗口已有点"时给，
        避免"啥都没有却显示可展开"）。 */
  const truncated = totalMatched > hits.length
  return { hits, hasMore: truncated || (windowDays > 0 && hits.length > 0), windowDays }
}

/** 全文检索（**旧口径，保留兼容**）：每会话一条，不带定位信息。
 *  ⚠️ 新代码请用 `sessionIndexSearchEvents` —— 这个函数只留给还没迁移的调用方。 */
export function sessionIndexSearch(q: string, limit: number): SearchHit[] {
  const query = String(q || '').trim()
  if (!query) return []
  const d = requireDb()
  const like = likePattern(query)
  const rows = d.prepare(`
    SELECT s.id AS id, s.title AS title, s.updated_at AS updatedAt,
           (SELECT e.text FROM events e WHERE e.session_id = s.id AND e.text LIKE ? ESCAPE '\\' LIMIT 1) AS hitText
    FROM sessions s
    WHERE s.title LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.text LIKE ? ESCAPE '\\')
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(like, like, like, Math.max(1, Math.min(limit, 30))) as any[]
  return rows.map((r) => {
    const title = String(r.title || '')
    return {
      sessionId: String(r.id),
      title,
      // 标题命中也给出正文片段（旧实现标题命中时 snippet 为空，这里保留可用的上下文）
      snippet: snippetOf(r.hitText, query, false),
      updatedAt: Number(r.updatedAt) || 0,
    }
  })
}

/** 索引状态（查询用，不抛错）：缺库/坏库都如实返回，供 session.indexStatus 展示。 */
export function sessionIndexStatus(): Record<string, any> {
  const f = indexFile()
  const out: Record<string, any> = {
    dbPath: f, exists: fs.existsSync(f), complete: false,
    schemaVersion: null, builtAt: null, sourceSessions: null,
    sessions: null, events: null, turns: null, dbBytes: 0, error: null,
  }
  if (!out.exists) { out.error = unusableReason || '索引未建立（index.db 不存在）'; return out }
  try { out.dbBytes = fs.statSync(f).size } catch (e) { out.error = String((e as any)?.message || e) }
  try {
    const d = requireDb()
    const meta = (k: string) => { const r = d.prepare('SELECT v FROM meta WHERE k=?').get(k) as any; return r ? String(r.v) : null }
    out.complete = meta('complete') === '1'
    out.schemaVersion = meta('schema_version')
    out.builtAt = meta('built_at')
    out.sourceSessions = Number(meta('source_sessions')) || 0
    out.sessions = (d.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n
    out.events = (d.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n
    out.turns = (d.prepare('SELECT COUNT(*) AS n FROM turns').get() as any).n
    out.error = unusableReason || null
  } catch (e) { out.error = String((e as any)?.message || e) }
  return out
}

const UPSERT_SESSION_SQL = `
  INSERT INTO sessions (id,parent_id,member_id,member_seq,title,created_at,updated_at,archived,in_main_list,workdir,preset_id,model,msg_count,bytes,compact_count,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, updated_at=excluded.updated_at, archived=excluded.archived,
    in_main_list=excluded.in_main_list, workdir=excluded.workdir, preset_id=excluded.preset_id,
    model=excluded.model, msg_count=excluded.msg_count, source=excluded.source
`
const UPSERT_EVENT_SQL = `
  INSERT OR REPLACE INTO events (session_id,turn_no,seq,event_id,role,ts,text) VALUES (?,?,?,?,?,?,?)
`

/** ★1130 **取索引源的唯一入口** —— 优先 transcript（多 90,435 条消息，见 `pickMessages` 注释），
 *  但 transcript 现在住在独立文件 `<id>/transcript.json`、**不再进 payload**
 *  （`buildSessionPayload` 已不返回它，因为它是同一段对话的第二份副本、占了 meta.json 568MB）。
 *  所以这里补一手：payload 没带 transcript 时，从 **session 对象**取（它的 accessor 会读独立文件/重建）。
 *
 *  ⚠️ 漏了这一步的后果是**实测过的**：全量重建后索引 assistant 从 31501 掉到 13462（少 18039 条），
 *    因为 messages 是"一跳一条"、纯工具轮没有 text 块 ⇒ 一半会话的大部分内容搜不到
 *    —— 正是 `pickMessages` 注释里警告的"功能倒退"。
 *  ⚠️ 不在这里做"读不到就算了"：返回原 payload 让 `pickMessages` 自行回落 messages 是既有行为，
 *    但调用方（reindex）必须自己把独立文件补上（它没有 session 对象）。 */
function indexSourceOf(payload: Record<string, any> | null | undefined, s?: any): Record<string, any> {
  if (Array.isArray(payload?.transcript) && payload.transcript.length) return payload as Record<string, any>
  const tr = Array.isArray(s?.transcript) ? s.transcript : null
  if (tr && tr.length) return { ...(payload || {}), transcript: tr }
  return (payload || {}) as Record<string, any>
}

/**
 * 增量：正文落盘成功后按 changedIds 更新 sessions + events。
 * changedIds 由 sessionStore 的 buildPlan 给出（含**早期消息**被 verifyInPlace 补写 r 行的 id），
 * 所以"只处理尾部 N 条"会漏的早期修改，这里不会漏 —— 这是采用 changedIds 而非尾部窗口的原因。
 * turns 表由全量建索引生成（本单不做 L8 轮次大纲的增量维护），reindex 会刷新。
 *
 * ★L2-members：`fullSync` 模式给**拿不到精准 changedIds** 的写入方用（当前只有 memberStore）。
 * 做法是「先清后写」：删掉该会话全部 events，再按 buildIndexRows 的结果整份写回 ——
 * 与全量建库同一条数据通路，不会出现两套口径，也不会漏（旧 event 被清掉）或重复（先删了）。
 * 代价：每个成员会话只有 60 条左右可索引文本，63 删 + 63 插 ≈ 1~3ms，可接受。
 * 等 L5 成员改走 sessionStore 后应换回精准 changedIds。
 */
export function sessionIndexOnWritten(
  s: any,
  payload: Record<string, any>,
  info: { changedIds?: string[]; fullSync?: boolean },
): void {
  const d = requireDb()
  const sessionId = String(s?.id || '')
  if (!sessionId) return
  // ★1130：与全量建库同一条数据通路（优先 transcript；payload 没带就从 session 对象补）
  const src = indexSourceOf(payload, s)
  const rows = buildIndexRows(sessionId, src)
  const sr = rows.session
  d.prepare(UPSERT_SESSION_SQL).run(
    sr.id, sr.parent_id, sr.member_id, sr.member_seq, sr.title, sr.created_at, sr.updated_at,
    sr.archived, sr.in_main_list, sr.workdir, sr.preset_id, sr.model, sr.msg_count, sr.bytes, sr.compact_count, sr.source,
  )
  if (info?.fullSync) {
    /* 先清后写：一个事务内完成，避免中途失败留下"删了没写"的空档。 */
    const upStmt = d.prepare(UPSERT_EVENT_SQL)
    d.exec('BEGIN')
    try {
      d.prepare('DELETE FROM events WHERE session_id=?').run(sessionId)
      for (const e of rows.events) {
        upStmt.run(e.session_id, e.turn_no, e.seq, e.event_id, e.role, e.ts, e.text)
      }
      d.exec('COMMIT')
    } catch (e) {
      try { d.exec('ROLLBACK') } catch { /* 回滚失败由下面的 throw 留痕，不掩盖原始错误 */ }
      throw e
    }
    return
  }
  const changed = Array.isArray(info?.changedIds) ? info.changedIds : []
  const byId = new Map<string, { m: any; seq: number; turnNo: number }>()
  // turn_no 与全量建库同口径：一条 user 消息开启一轮（1 基）
  const srcMsgs: any[] = pickMessages(src)   // ★1130：与上面 buildIndexRows 用**同一份源**
  let turnNo = 0
  for (let seq = 0; seq < srcMsgs.length; seq++) {
    const m = srcMsgs[seq] || {}
    if (m.role === 'user') turnNo++
    const key = String(m.id || `anon:${seq}`)
    if (changed.includes(key)) byId.set(key, { m, seq, turnNo })
  }
  const delStmt = d.prepare('DELETE FROM events WHERE session_id=? AND event_id=?')
  const upStmt = d.prepare(UPSERT_EVENT_SQL)
  for (const id of changed) {
    const hit = byId.get(id)
    const text = hit ? extractIndexText(hit.m) : ''
    if (!hit || !text) { delStmt.run(sessionId, id); continue }
    upStmt.run(sessionId, hit.turnNo || 0, hit.seq, id, String(hit.m.role), Number(hit.m.timestamp) || 0, text)
  }
}

/** 删除会话时同步删三张表（漏删会让搜索结果指向 404）。 */
export function sessionIndexDelete(sessionId: string): void {
  const d = requireDb()
  const id = String(sessionId || '')
  if (!id) return
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM events WHERE session_id=?').run(id)
    d.prepare('DELETE FROM turns WHERE session_id=?').run(id)
    d.prepare('DELETE FROM sessions WHERE id=?').run(id)
    d.exec('COMMIT')
  } catch (e) {
    try { d.exec('ROLLBACK') } catch { /* 回滚失败已由下面的 throw 留痕 */ }
    throw e
  }
}

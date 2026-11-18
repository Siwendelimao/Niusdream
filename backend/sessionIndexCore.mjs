/**
 * L2 全文索引的**共享核心**（纯 JS，零依赖）。
 * 运行时 `sessionIndex.ts` 与离线 `_reindex.mjs` 都只用这里的一套口径，
 * 避免"在线增量"和"离线全量"两套提取逻辑漂移（一件事只许一条数据通路）。
 *
 * 铁律：只索引 role=user/assistant 且 content 块 type==='text' 的文本。
 * tool_use / tool_result / reasoning / 图片 / 其它块一律不进索引 —— 依据施工单 §0.2
 * 实测：主会话 8.58MB 消息里 tool_result 47.9% + tool_use 11.8% + reasoning 11.2%，
 * 真正该搜的 user/text + assistant/text 只有 0.38MB = 4.5%。
 * 单条 text 上限 20000 字符（超出保留头尾各一半 + 中间省略号），防止索引体积失控。
 */
/* ★1130：注入消息的判据**只许有一份** —— 与 server.ts 的轮次投影共用 `injectMarkers.mjs`。
   两边判据一不同，索引的 `turn_no` 就与界面的 `[data-turn-user]` 对不上，点搜索结果跳错轮。 */
import { isInjectedUserMsg } from './injectMarkers.mjs'

export const SCHEMA_VERSION = '1'
// ★L2-trunc：2000 → 20000。实测全库 text 块原始总量仅 14.25MB，
// 截到 2000 只省 1.6MB(11%) 却让 1477 个长消息的尾部搜不到；20000 只截 11 个块、文本量 98.6%。
export const MAX_TEXT = 20000

export const SCHEMA_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT, member_id TEXT, member_seq INTEGER,
  title TEXT, created_at INTEGER, updated_at INTEGER,
  archived INTEGER, in_main_list INTEGER,
  workdir TEXT, preset_id TEXT, model TEXT,
  msg_count INTEGER, bytes INTEGER, compact_count INTEGER,
  source TEXT
);
CREATE INDEX idx_sessions_parent ON sessions(parent_id, member_id, member_seq);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE TABLE events (
  rowid INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_no INTEGER,
  seq INTEGER NOT NULL,
  event_id TEXT,
  role TEXT,
  ts INTEGER,
  text TEXT
);
CREATE UNIQUE INDEX idx_events_uniq ON events(session_id, event_id);
CREATE INDEX idx_events_session ON events(session_id, seq);
CREATE TABLE turns (
  session_id TEXT NOT NULL, turn_no INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER,
  prompt_preview TEXT, reply_preview TEXT,
  first_seq INTEGER, last_seq INTEGER,
  PRIMARY KEY(session_id, turn_no)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
`

export function truncateText(s) {
  if (typeof s !== 'string') return ''
  if (s.length <= MAX_TEXT) return s
  // ★L2-trunc：超长时**保留头尾**——头部是 FIFO/背景信息，尾部是结论/报错，
  // 实测丢词的主要原因是关键词落在尾部（2000 那段只保头，把结尾整段扔了）。
  // 总长 = half + 1(省略号) + half ≤ MAX_TEXT，严格不超。
  const half = Math.floor((MAX_TEXT - 1) / 2)
  return s.slice(0, half) + '…' + s.slice(s.length - half)
}

/** ★1130 **索引噪音过滤**（与上面的"轮次判据"是**两件不同的事**，别混在一起）：
 *   · **轮次判据** `isInjectedUserMsg`（来自 injectMarkers.mjs）：决定"这条算不算一轮"，
 *     **必须与前端 `userAt` 完全一致**，否则 `turn_no` 与 `[data-turn-user]` 对不上、点搜索跳错轮；
 *   · **本函数**：决定"这条要不要进搜索索引" —— 可以**更宽**，因为用户不想搜到系统噪音。
 * 为什么必须解耦（实测）：`[记忆召回]（自动检索的一行线索…` 这类消息，`stripInjectedLines` 会把
 * `[记忆召回]` 那一行剥掉，剥完不匹配任何【…】前缀 ⇒ `isInjectedUserMsg` 返回 **false** ⇒
 * 前端把它**算作真实轮**。所以轮号必须照算（否则错位），但内容绝不该进搜索（2855 条纯噪音）。
 * ⇒ 轮号照算（对齐），内容不入索引（干净）。
 * ⚠️ 只能用**原文开头**判（不能用 strip 后的文本 —— 那样恰好就找不到这些前缀了）。 */
const INDEX_NOISE_PREFIXES = [
  '[记忆召回]', '[上下文]', '[系统提示', '[定时任务「',
  '[模式:', '[技能指令]', '[项目档案卡]', '[常驻记忆]', '[强化记忆]', '[强化知识]',
  '[目标锚点]', '[验收结果]',
  '【群聊插嘴', '【补充（主 agent）】', '【成员回归】',
  '# 你的身份（本次派活）',
]

function isIndexNoise(m) {
  if (m.role !== 'user') return false
  if (isInjectedUserMsg(m)) return true          // 轮次判据挡住的，索引当然也不收
  const raw = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('') : ''
  const t = String(raw || '').trimStart()
  if (!t) return false
  return INDEX_NOISE_PREFIXES.some((p) => t.startsWith(p))
}

/** 提取一条消息里**唯一允许进索引**的文本（user/assistant 的 text 块）。工具/思考一律返回 ''。 */
export function extractIndexText(m) {
  // 铁律①：role 必须是 user / assistant。transcript 里的 system / toolResult 天然排除。
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return ''
  /* ★1130：噪音不进索引。只挡 role=user —— assistant 正文里出现「【记忆召回】」是 AI 在讨论这件事。 */
  if (isIndexNoise(m)) return ''
  const c = m.content
  // 两套数据的 user/assistant 正文都是 content 数组；string 形态全库 296 条全是 system（user/assistant 占 0），不收。
  if (!Array.isArray(c)) return ''
  let text = ''
  for (const b of c) {
    if (!b || typeof b !== 'object') continue
    // 两套块类型对照（只收 type==='text'，其余一律跳过，不按字段名猜）：
    //   messages  : text(收) / reasoning / tool_use / tool_result      → 不收
    //   transcript: text(收) / thinking / toolCall / 其余               → 不收
    // transcript 的 thinking 用 `thinking` 字段、toolCall 是另一套结构，靠 type 判定即可全部挡住。
    if (b.type !== 'text') continue
    if (typeof b.text !== 'string') continue
    text += (text ? '\n' : '') + b.text
  }
  return truncateText(text)
}

/**
 * ★L2-fix：数据源与旧 session.search **完全同序** —— 优先 transcript，没有才用 messages。
 * 实测 890 个会话里 445 个 transcript 更长（合计多 90,435 条消息）；只读 messages 会让
 * 一半会话的大部分内容搜不到（功能倒退）。全量建索引与运行时增量共用这一处，杜绝两套口径。
 */
export function pickMessages(payload) {
  if (Array.isArray(payload?.transcript)) return payload.transcript
  if (Array.isArray(payload?.messages)) return payload.messages
  return []
}

/**
 * 从一个会话 payload 生成要写进索引的三类行（全量建库与增量共用）。
 * turn_no 口径：一条 user 消息开启一轮（1 基，与 session.deleteTurn 的 turnIndex 一致）。
 * payload 字段名与 buildSessionPayload 的显式白名单一一对应。
 */
export function buildIndexRows(sessionId, payload, bytes = 0) {
  const messages = pickMessages(payload)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const session = {
    id: sessionId,
    parent_id: payload?.parentSessionId ?? null,
    member_id: payload?.memberId ?? null,
    member_seq: num(payload?.memberSessionSeq),
    title: String(payload?.title || ''),
    created_at: num(payload?.createdAt),
    updated_at: num(payload?.updatedAt),
    archived: payload?.archived ? 1 : 0,
    in_main_list: payload?.inMainList === false ? 0 : 1,
    workdir: payload?.workDir ?? null,
    preset_id: payload?.presetId ?? null,
    model: payload?.model ?? null,
    msg_count: messages.length,
    bytes: num(bytes),
    compact_count: 0,
    source: payload?.parentSessionId ? 'member' : 'user',
  }

  const events = []
  const turns = []
  const seenEventIds = new Set()
  let turnNo = 0
  let curTurn = null
  for (let seq = 0; seq < messages.length; seq++) {
    const m = messages[seq] || {}
    /* ★1130（**跳错轮的根因**）：`turn_no` 只给**真实 user 消息**编号，注入消息并入当前轮（不 ++）。
       口径与前端的 `[data-turn-user]` 必须一致 —— 那边是 `userAt`（`!isInjectedUser(m)`）的序号、
       注入段 `turnIndex: 0`。索引这里原来"每条 user 都 ++"，实测同一会话
       API turnIndex `20/21/22/23/24` vs 索引 turn_no `25/26/31/38/43`（差值递增）⇒ 点搜索结果跳错轮。
       ⚠️ 注入消息本身**本来就不进 events**（`extractIndexText` 返回 ''），这里只影响编号。 */
    if (m.role === 'user' && !isInjectedUserMsg(m)) {
      turnNo++
      curTurn = {
        session_id: sessionId, turn_no: turnNo,
        started_at: num(m.timestamp), ended_at: num(m.timestamp),
        prompt_preview: truncateText(extractIndexText(m)).slice(0, 120),
        reply_preview: '', first_seq: seq, last_seq: seq,
      }
      turns.push(curTurn)
    }
    if (curTurn) {
      curTurn.last_seq = seq
      if (num(m.timestamp)) curTurn.ended_at = num(m.timestamp)
      if (!curTurn.reply_preview && m.role === 'assistant') {
        curTurn.reply_preview = truncateText(extractIndexText(m)).slice(0, 120)
      }
    }
    const text = extractIndexText(m)
    if (!text) continue                       // 工具/思考/图片：不进索引
    /* 历史数据里同一会话存在重复消息 id（实测 481 条）。唯一键是 (session_id,event_id)，
       直接 INSERT OR REPLACE 会把先出现的那条**静默覆盖掉** ⇒ 派生索引少内容。
       给第 2 次及之后的重复 id 加 #seq 后缀，保证全量索引一条不少。 */
    let eventId = String(m.id || `anon:${seq}`)
    if (seenEventIds.has(eventId)) eventId = `${eventId}#${seq}`
    seenEventIds.add(eventId)
    events.push({
      session_id: sessionId,
      turn_no: turnNo || 0,
      seq,
      event_id: eventId,
      role: String(m.role),
      ts: num(m.timestamp),
      text,
    })
  }
  return { session, events, turns }
}

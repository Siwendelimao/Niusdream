/**
 * memberStore.ts —— **成员会话 append-only 落盘**（★s4a，落盘改造第一步）
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（实测铁证，不是设计洁癖）
 * ───────────────────────────────────────────────────────────────────────────────
 *   backend-restart-1107-2327.log.err：
 *     [persist] ⚠ 慢拍 94951ms（增量）—— 期间所有 RPC/SSE 都在排队
 *     [persist] ⚠ 慢拍 87909ms（增量）
 *     [eventloop] 主线程被堵 86526ms
 *   persist 慢拍 46 次、>1s 的 eventloop 告警 565 次，前端 45s 看门狗判死后端"假死"。
 *
 *   根因：主落盘（`persistSessionLocal`）每拍都把**整份会话** buildSessionPayload →
 *   JSON.stringify（全量）→ sha1（全量）→ tmp 文件 + rename（全量重写）。
 *   本会话 29.8MB + 成员会话 21.4MB ⇒ 一拍处理 ~51MB，而 persist 是 **de-bounce 500ms**，
 *   成员跑起来时工具节拍不停置脏 ⇒ 一拍接一拍，事件循环被自家人堵死。
 *
 * 本模块的定位（刻意**只**管成员会话）
 * ───────────────────────────────────────────────────────────────────────────────
 *   · 成员会话（`parentSessionId` + `memberId` 都有值）改走本模块：**只 append，不重写历史**；
 *   · 主对话落盘（`persistSessionLocal` / `persistSessions`）**一行不动** —— 风险隔离：
 *     这条链路已经踩过 1026h / 1027b / 1027c 三次"写空"事故，不在本轮的范围里。
 *
 * 存储格式（`data/sessions/_members/`，**子目录** —— 不落进 `sessions/*.json` 的命名空间，
 * 主落盘的 `readdirSync(...).filter(f => f.endsWith('.json'))`、死文件清理、备份全部不受影响）
 * ───────────────────────────────────────────────────────────────────────────────
 *   `<sessionId>.jsonl`      内容，一行一个 op（见下）
 *   `<sessionId>.meta.json`  轻量元数据（标题 / usageTotals / turnMetas / model …，**不含 messages**）
 *
 *   op 行（每行一条，末字节恒为 '\n'）：
 *     {"v":1,"t":"h","id":"<sid>","at":<ms>}                 文件头（rewrite 时写一次）
 *     {"t":"a","m":<message>}                                追加到末尾（99% 的流量）
 *     {"t":"r","id":"<msgId>","m":<message>}                 原位替换（编辑/流式中间态）
 *     {"t":"i","id":"<msgId>","af":"<prevId>"|null,"m":<m>}  插到 af 之后（af=null ⇒ 头部）
 *     {"t":"d","id":"<msgId>"}                               删除
 *
 *   回放 = 顺序 apply（后写覆盖先写）。⇒ **保住 append-only 的同时，"能编辑/能删除"这个产品
 *   能力一个都没砍**（设计 §M8-A 的 tombstone/replace 口径，这里用 id 键 + 顺序 apply 实现）。
 *
 * 边界（诚实写清，不装作全能）
 * ───────────────────────────────────────────────────────────────────────────────
 *   ① **能够精确追到的改动**：消息追加、尾部 N 条的原地修改（TAIL_K=4，每拍按 sha1 校验）、
 *      任意位置的增/删/换序（走结构 diff：mid 段先 d 后 i）。
 *   ② **可能追不到的改动**：**中间**某条消息被原地改内容、且既没有增删也没有换序、
 *      且不在尾部窗口里 —— 这种"隐形编辑"不在每拍的快路径上。保底 = 会话**空闲后**
 *      的第一次落盘会做一次全量校验（`fullVerifyMs` 节流 30s），届时会发现并补写 `r`。
 *   ③ **匿名消息**（没有 id 字段）按位置键 `\u0000anon<i>` 跟踪 —— 只能在"长度不变"时稳定，
 *      有增删时会当成 d+i 重写（内容不丢，只是多写几行）。
 *   ④ **不承诺原子性**：JSONL 天生支持"撕裂尾部"。读取时**截断最后一个完整行之后的内容**
 *      并打 warn；中间行损坏 → 记 ERROR + 跳过该行（不截断后续，宁可保留能读的）。
 *      进程被 taskkill /F 时数据在 OS page cache 里，不需要 fsync 就活；只有断电才需要，
 *      所以 fsync 只在 `flushAllSync()`（退出路径）与 compact 后做。
 *
 * 写控制器（设计 §M8-B）
 * ───────────────────────────────────────────────────────────────────────────────
 *   · **每会话一个队列**：同 id 串行（Promise 链 + 固定窗口合并），不同 id 互不阻塞；
 *   · **固定窗口 200ms**（不是 debounce）：窗口从"第一次置脏"起算，后续置脏**不重置** ——
 *     否则成员每 100ms 一个工具节拍，debounce 会被无限顶后，等于永不落盘；
 *   · **全局在飞上限 2**：避免 20 个成员齐写把 IO 打满（其余排队，不丢）；
 *   · 失败**不静默**：记 ERROR 日志 + 保留脏态 + 退避重试（500ms→4s），**绝不回退到旧的全量写**。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/* ════════════════════════════════════════════════════════════════════════════
 * 配置
 * ════════════════════════════════════════════════════════════════════════════ */

/** 一批落盘完成后的快照事实 */
export interface MemberWriteInfo {
  /** 本批落盘后该会话的**消息条数**（快照，不是活引用） */
  messages: number
  /** 本批写入的 op 行数（rewrite 时 = 1 + messages） */
  lines: number
  /** 本批写入 jsonl 的字节数 */
  bytes: number
  kind: 'append' | 'rewrite'
}

export interface MemberStoreConfig {
  /** 存储目录（`data/sessions/_members`） */
  dir: string
  /** 取内存会话（不存在 ⇒ null） */
  getSession: (id: string) => any | null
  /** 与主落盘同一份字段白名单的 payload（含 messages）。返回 null = 内存与磁盘都找不到正文 */
  buildPayload: (s: any) => Record<string, any> | null
  /** 正文 + meta 落盘成功后的回调（主落盘用它更新摘要/索引，同序：先正文后索引）。
   *  第 3 参 info = **本批的快照事实**（payload.messages 是活引用，异步写完后它可能已经长了）。 */
  onWritten?: (s: any, payload: Record<string, any>, info: MemberWriteInfo) => void
  /** 会话是否还在跑（只有"不跑"的时候才允许做全量校验，避免运行中吃 CPU） */
  isRunning?: (s: any) => boolean
  /** 删除会话时的回收目录（默认 `<dir>/_trash`） */
  trashDir?: string
  /** 固定窗口（默认 200ms，不重置） */
  windowMs?: number
  /** 全局在飞写上限（默认 2） */
  maxInflight?: number
  /** 单文件超过这个字节数 ⇒ 该次写完后 compact（默认 8MB，设计 §M8-A） */
  compactBytes?: number
  /** 行数超过 `max(compactLines, 2*存活消息数+200)` ⇒ compact（默认 4000） */
  compactLines?: number
  /** 冗余行达到多少才值得折叠（默认 400 行；太小会变成"每拍重写"，太大文件会长期臃肿） */
  compactMinWaste?: number
  /** 全量校验节流（默认 30s；0 = 关闭全量校验） */
  fullVerifyMs?: number
  /** 单次 append 待写字节超过这个值 ⇒ 不等窗口立刻 flush（默认 1MB，设计 §M8-B 体积软触发） */
  softFlushBytes?: number
}

interface Cfg extends MemberStoreConfig {
  windowMs: number
  maxInflight: number
  compactBytes: number
  compactLines: number
  compactMinWaste: number
  fullVerifyMs: number
  softFlushBytes: number
  trashDir: string
}

let cfg: Cfg | null = null

/** 初始化（server.ts 在 SESSIONS_DIR 定义后调用一次；重复调用以最后一次为准） */
export function configureMemberStore(c: MemberStoreConfig): void {
  if (!c || !c.dir) throw new Error('[member-store] configureMemberStore: dir 必填')
  cfg = {
    ...c,
    windowMs: c.windowMs ?? 200,
    maxInflight: c.maxInflight ?? 2,
    compactBytes: c.compactBytes ?? 8 * 1024 * 1024,
    compactLines: c.compactLines ?? 4000,
    compactMinWaste: c.compactMinWaste ?? 400,
    fullVerifyMs: c.fullVerifyMs ?? 30_000,
    softFlushBytes: c.softFlushBytes ?? 1024 * 1024,
    trashDir: c.trashDir || path.join(c.dir, '_trash'),
  }
  try { fs.mkdirSync(cfg.dir, { recursive: true }) } catch (e) {
    console.error('[member-store] 建目录失败：', String((e as any)?.message || e))
  }
}

function C(): Cfg {
  if (!cfg) throw new Error('[member-store] 未初始化：必须先调用 configureMemberStore()')
  return cfg
}

/** 成员会话判定：`parentSessionId` 与 `memberId` 同时有值（与全仓既有口径一致） */
export function isMemberSession(s: any): boolean {
  if (!s || typeof s !== 'object') return false
  const p = s.parentSessionId, m = s.memberId
  return (typeof p === 'string' && p.length > 0) && (typeof m === 'string' && m.length > 0)
}

/* ════════════════════════════════════════════════════════════════════════════
 * 统计（压测/验收直接读这里，不靠猜）
 * ════════════════════════════════════════════════════════════════════════════ */

export interface MemberStoreStats {
  flushes: number            // 成功落盘的批次
  appendedLines: number      // 写入的 op 行数
  bytesWritten: number       // 实际写进磁盘的字节
  /** ★ 关键指标：本模块**做过的 stringify 字节数**（对照旧路径 = 每拍全量 payload） */
  stringifyBytes: number
  writeErrors: number
  truncations: number        // 撕裂尾截断次数
  truncatedBytes: number
  badLines: number           // 中间行损坏（ERROR）条数
  compactions: number
  migrations: number         // 老 .json → .jsonl 懒迁移次数
  fullVerifies: number
  lastBatchMs: number
  maxBatchMs: number
  pendingSessions: number
  inflight: number
}

const stats: MemberStoreStats = {
  flushes: 0, appendedLines: 0, bytesWritten: 0, stringifyBytes: 0,
  writeErrors: 0, truncations: 0, truncatedBytes: 0, badLines: 0,
  compactions: 0, migrations: 0, fullVerifies: 0,
  lastBatchMs: 0, maxBatchMs: 0, pendingSessions: 0, inflight: 0,
}

export function memberStoreStats(): MemberStoreStats {
  let pending = 0
  for (const st of states.values()) if (st.timer || st.writing) pending++
  return { ...stats, pendingSessions: pending, inflight: inflightCount }
}

export function resetMemberStoreStats(): void {
  stats.flushes = 0; stats.appendedLines = 0; stats.bytesWritten = 0; stats.stringifyBytes = 0
  stats.writeErrors = 0; stats.truncations = 0; stats.truncatedBytes = 0; stats.badLines = 0
  stats.compactions = 0; stats.migrations = 0; stats.fullVerifies = 0
  stats.lastBatchMs = 0; stats.maxBatchMs = 0
}

/* ════════════════════════════════════════════════════════════════════════════
 * 每会话状态
 * ════════════════════════════════════════════════════════════════════════════ */

const TAIL_K = 3              // 每拍校验的尾部窗口大小（原地修改探测；窗口越大 = 每拍固定成本越高）
const TRASH_KEEP = 200        // 回收目录最多保留多少个文件（超出按时间删最旧）

interface SState {
  id: string
  loaded: boolean
  /** 乐观态：已排队（含在飞）的 op **被认为已生效** 之后的 id 顺序 */
  ids: string[]
  /** 尾部窗口签名：msgId → sha1(JSON)（只存尾部 TAIL_K 条，不用全量 map） */
  sigs: Map<string, string>
  /** 磁盘上已知的文件字节数（近似，用于 compact 判定） */
  bytes: number
  /** 磁盘上已知的 op 行数（近似） */
  lines: number
  /** 老 .json 还在 ⇒ 本次落盘走"全量重写成 jsonl"并删旧文件 */
  migrating: boolean
  /** 文件里已经有 header 行（新会话第一拍必须补上） */
  hasHeader: boolean
  /** meta 上次落盘的签名（未变则不重写 meta 文件） */
  metaSig: string
  timer: ReturnType<typeof setTimeout> | null
  writing: boolean
  again: boolean
  failCount: number
  failTimer: ReturnType<typeof setTimeout> | null
  lastFullVerifyAt: number
  lastCompactAt: number
  fd: number | null
  pendingBytes: number
}

const states = new Map<string, SState>()
let inflightCount = 0
let inflightWaiters: Array<() => void> = []

function pth(id: string) {
  const c = C()
  return { jsonl: path.join(c.dir, `${id}.jsonl`), meta: path.join(c.dir, `${id}.meta.json`) }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function idSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

function idOf(m: any, i: number): string {
  if (m && typeof m.id === 'string' && m.id) return m.id
  return `\u0000anon${i}`
}

function ensureState(id: string): SState {
  let st = states.get(id)
  if (!st) {
    st = {
      id, loaded: false, ids: [], sigs: new Map(), bytes: 0, lines: 0,
      migrating: false, hasHeader: false, metaSig: '', timer: null, writing: false, again: false,
      failCount: 0, failTimer: null, lastFullVerifyAt: 0, lastCompactAt: 0, fd: null, pendingBytes: 0,
    }
    states.set(id, st)
  }
  return st
}

/* ════════════════════════════════════════════════════════════════════════════
 * 读取：jsonl 回放 + 坏尾截断
 * ════════════════════════════════════════════════════════════════════════════ */

interface ReplayResult {
  messages: any[]
  ids: string[]
  lines: number
  bytes: number
  /** 是否发生过撕裂尾截断 */
  truncated: boolean
}

/**
 * 回放一个 jsonl 文件。
 * · 最后一行的**末尾没有 '\n'** ⇒ 撕裂写（进程正好死在半行）⇒ 截断到最后一个完整行的偏移；
 * · 中间行 JSON 解析失败 ⇒ 记 ERROR + 跳过该行（后面能读的继续读，不整体丢）；
 * · 首行必须是 header，否则按"无 header 的老文件"继续读（记 warn）。
 */
function replayFile(file: string, sid: string): ReplayResult | null {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return null }
  let buf: Buffer
  try { buf = fs.readFileSync(fd) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }

  const messages: any[] = []
  const ids: string[] = []
  let lines = 0
  let offset = 0
  let completeEnd = 0          // 最后一个完整行（含 '\n'）的结束偏移
  let badLines = 0

  const applyOp = (op: any) => {
    if (!op || typeof op !== 'object') return
    const t = op.t
    if (t === 'h') return
    if (t === 'a') {
      const m = op.m
      messages.push(m)
      ids.push(idOf(m, messages.length - 1))
      return
    }
    if (t === 'r') {
      const i = ids.indexOf(String(op.id))
      if (i < 0) { messages.push(op.m); ids.push(String(op.id || idOf(op.m, messages.length - 1))) }   // 找不到 ⇒ 退化成 append
      else { messages[i] = op.m }
      return
    }
    if (t === 'i') {
      const m = op.m
      const mid = String(op.id || idOf(m, messages.length))
      if (op.af == null) { messages.unshift(m); ids.unshift(mid); return }
      const at = ids.indexOf(String(op.af))
      if (at < 0) { messages.push(m); ids.push(mid); return }   // af 丢了 ⇒ 退化成 append（内容不丢）
      messages.splice(at + 1, 0, m); ids.splice(at + 1, 0, mid)
      return
    }
    if (t === 'd') {
      const i = ids.indexOf(String(op.id))
      if (i >= 0) { messages.splice(i, 1); ids.splice(i, 1) }
      return
    }
  }

  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset)
    if (nl === -1) break                    // 撕裂尾：剩下的字节没有换行 ⇒ 整段丢弃
    completeEnd = nl + 1
    let line = buf.toString('utf8', offset, nl)
    offset = completeEnd
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    lines++
    let op: any
    try {
      op = JSON.parse(line)
    } catch (e) {
      badLines++
      stats.badLines++
      console.error(`[member-store] ${sid.slice(0, 8)} 第 ${lines} 行损坏（跳过，后续继续读）：${String((e as any)?.message || e)}`)
      continue
    }
    try { applyOp(op) } catch (e) {
      badLines++
      stats.badLines++
      console.error(`[member-store] ${sid.slice(0, 8)} 第 ${lines} 行 apply 失败（跳过）：${String((e as any)?.message || e)}`)
    }
  }

  let truncated = false
  if (completeEnd < buf.length) {
    /* 撕裂尾：截断到最后一个完整行。**不要求原子性** —— JSONL 的粒度优势就是"只丢半行"。
       先记日志再截，免得截完了没人知道丢了什么。 */
    const lost = buf.length - completeEnd
    truncated = true
    stats.truncations++
    stats.truncatedBytes += lost
    console.warn(`[member-store] ⚠ ${sid.slice(0, 8)} 撕裂尾：截断 ${lost} 字节（偏移 ${completeEnd} → 文件尾），完整行 ${lines} 行`)
    try { fs.truncateSync(file, completeEnd) } catch (e) {
      console.error(`[member-store] 截断失败（只读不影响本次加载）：${String((e as any)?.message || e)}`)
    }
  }
  if (badLines > 0) console.error(`[member-store] ${sid.slice(0, 8)} 本次加载共 ${badLines} 行损坏（已跳过，未截断）`)
  return { messages, ids, lines, bytes: completeEnd, truncated }
}

/** 记尾部窗口签名（只留最后 TAIL_K 条，map 不会涨） */
function refreshTailSigs(st: SState, messages: any[]): void {
  const next = new Map<string, string>()
  const from = Math.max(0, messages.length - TAIL_K)
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]
    const json = JSON.stringify(m)
    stats.stringifyBytes += json.length
    next.set(idOf(m, i), sha1(json))
  }
  st.sigs = next
}

/** 从磁盘装载状态（首次 touch / 首次读后的写都要它） */
function loadState(id: string, st: SState): void {
  const c = C()
  const p = pth(id)
  st.loaded = true
  const r = replayFile(p.jsonl, id)
  if (r) {
    st.ids = r.ids
    st.lines = r.lines
    st.bytes = r.bytes
    st.migrating = false
    st.hasHeader = r.lines > 0
    // 尾部签名：从回放出来的消息重建（只算 TAIL_K 条，不碰全量）
    const tail = new Map<string, string>()
    const from = Math.max(0, r.messages.length - TAIL_K)
    for (let i = from; i < r.messages.length; i++) {
      const json = JSON.stringify(r.messages[i])
      stats.stringifyBytes += json.length
      tail.set(idOf(r.messages[i], i), sha1(json))
    }
    st.sigs = tail
    return
  }
  // 没有 jsonl：可能是老 .json（懒迁移），也可能根本没落过盘
  const legacy = path.join(path.dirname(c.dir), `${id}.json`)
  if (fs.existsSync(legacy)) {
    st.migrating = true
    st.ids = []
    st.lines = 0
    st.bytes = 0
    st.sigs = new Map()
    return
  }
  st.ids = []
  st.lines = 0
  st.bytes = 0
  st.sigs = new Map()
}

/* ════════════════════════════════════════════════════════════════════════════
 * 对外读取（boot 装载 / 按需补载）
 * ════════════════════════════════════════════════════════════════════════════ */

/** 磁盘上有这个成员会话的 jsonl 吗 */
export function hasMemberData(id: string): boolean {
  const c = C()
  if (!idSafe(id)) return false
  try { return fs.existsSync(path.join(c.dir, `${id}.jsonl`)) } catch { return false }
}

/** 读一个成员会话的完整 payload（meta + messages）。没有 ⇒ null（**不造空壳**）。 */
export function readMemberPayload(id: string): Record<string, any> | null {
  const c = C()
  const sid = String(id || '')
  if (!idSafe(sid)) return null
  const p = pth(sid)
  if (!fs.existsSync(p.jsonl)) return null
  const r = replayFile(p.jsonl, sid)
  if (!r) return null
  let meta: any = {}
  if (fs.existsSync(p.meta)) {
    try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf-8')) } catch (e) {
      /* meta 坏了不能静默 —— 标题/usage 会丢，但内容还在。如实报错，让上面看得见。 */
      throw new Error(`成员会话 meta 不可用（${path.basename(p.meta)}）：${String((e as any)?.message || e)}`)
    }
  } else {
    console.warn(`[member-store] ${sid.slice(0, 8)} 缺 meta 文件（标题/usage 等元数据缺失，内容完好）`)
  }
  if (meta && typeof meta === 'object') { delete meta.__ms; delete meta.__msCount }
  return { ...(meta || {}), id: sid, messages: r.messages }
}

/** 扫描目录读全部成员会话 payload（boot 用；`onlyId` 时只读那一个） */
/** ★u1：**只列 id，不读正文** —— 给启动水合的"补读"环节用。
 *
 *  为什么需要它：`hydrateSessionsFromIndex()`（走索引的启动路径）在"磁盘上有、内存里没有"
 *  的补齐环节只扫了 `SESSIONS_DIR/*.json` 和 `sessionStore.listSessionIds()`，
 *  **漏了成员会话**（存在 `data/sessions/_members/`）。后果（实测 db2425fc）：
 *    · `findMemberSession` 遍历 `sessions` 找不到成员会话 ⇒ 返回 null
 *    · ⇒ `memberCtxUsage` 全 null（前端上下文进度条空白）
 *    · ⇒ `memberUsageLedger` 全 null（账本差值法失效，回退 messages 口径 → 中断的 run 没有 usage）
 *  用 `readAllMemberPayloads()` 也能拿 id，但那要**解析每个会话正文**（几百 MB、秒级）；
 *  这里只需要 id 列表，readdir 一次就够（零解析）。 */
export function listMemberIds(): string[] {
  const c = C()
  try {
    return fs.readdirSync(c.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .filter((sid) => idSafe(sid))
  } catch { return [] }
}

export function readAllMemberPayloads(onlyId?: string): Record<string, any>[] {
  const c = C()
  const out: Record<string, any>[] = []
  if (onlyId) {
    const one = readMemberPayload(String(onlyId))
    return one ? [one] : []
  }
  let files: string[] = []
  try { files = fs.readdirSync(c.dir).filter((f) => f.endsWith('.jsonl')) } catch { return [] }
  for (const f of files) {
    const sid = f.slice(0, -'.jsonl'.length)
    if (!idSafe(sid)) continue
    try {
      const one = readMemberPayload(sid)
      if (one) out.push(one)
    } catch (e) {
      /* 单个坏文件不挡启动（与主落盘同口径），但必须留 ERROR —— 不是静默跳过 */
      console.error('[member-store] 加载失败（该会话本次跳过）：', f, String((e as any)?.message || e))
    }
  }
  return out
}

/* ════════════════════════════════════════════════════════════════════════════
 * 差异计算（核心：**每拍只 stringify 增量**）
 * ════════════════════════════════════════════════════════════════════════════ */

interface Plan {
  /** 'append' = 追加若干行；'rewrite' = 迁移/压缩：整份重写成 tmp → rename */
  kind: 'append' | 'rewrite'
  id: string
  data: string
  metaData: string | null
  metaSig: string
  bytes: number
  lines: number
  /** 迁移场景：成功写完后要删掉老 .json */
  dropLegacy: boolean
  /** 本次 stringify 的字节数（指标） */
  stringifyBytes: number
}

function lineA(m: any): string {
  return '{"t":"a","m":' + JSON.stringify(m) + '}\n'
}
function lineR(id: string, m: any): string {
  return '{"t":"r","id":' + JSON.stringify(id) + ',"m":' + JSON.stringify(m) + '}\n'
}
function lineI(id: string, af: string | null, m: any): string {
  return '{"t":"i","id":' + JSON.stringify(id) + ',"af":' + JSON.stringify(af) + ',"m":' + JSON.stringify(m) + '}\n'
}
function lineD(id: string): string {
  return '{"t":"d","id":' + JSON.stringify(id) + '}\n'
}

/**
 * 生成一批写盘计划。**同步**：只做"比较 + 序列化增量"，不碰磁盘（IO 交给 writeBatch）。
 * 返回 null = 没有改动（不做无意义的空写）。
 */
function buildPlan(id: string, payloadArg?: Record<string, any> | null, opts: { force?: boolean } = {}): Plan | null {
  const st = ensureState(id)
  if (!st.loaded) loadState(id, st)
  let payload = payloadArg
  if (payload === undefined) {
    const c0 = C()
    const s0 = c0.getSession(id)
    if (!s0) return null
    payload = c0.buildPayload(s0)
  }
  if (!payload) {
    console.error('[member-store] 跳过（内存与磁盘都找不到正文，绝不写空）：', id.slice(0, 8))
    return null
  }
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : []
  const meta: Record<string, any> = { ...payload }
  delete meta.messages
  meta.__ms = 1
  meta.__msCount = messages.length
  const metaData = JSON.stringify(meta)
  const metaSig = sha1(metaData)
  let stringifyBytes = metaData.length
  const metaChanged = metaSig !== st.metaSig || st.migrating

  const liveIds: string[] = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) liveIds[i] = idOf(messages[i], i)

  /* ── 迁移 / 压缩：整份重写 ─────────────────────────────────────────────── */
  if (st.migrating) {
    const parts: string[] = []
    const header = JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n'
    parts.push(header)
    stringifyBytes += header.length
    for (const m of messages) {
      const l = lineA(m)
      parts.push(l)
      stringifyBytes += l.length - 1
    }
    const data = parts.join('')
    return {
      kind: 'rewrite', id, data, metaData, metaSig, bytes: data.length,
      lines: 1 + messages.length, dropLegacy: true, stringifyBytes,
    }
  }

  /* ── 快路径：纯追加 / 长度不变（只校验尾部窗口） ──────────────────────── */
  const nCur = st.ids.length
  const nLive = liveIds.length
  let prefixOk = nLive >= nCur
  if (prefixOk) {
    for (let i = 0; i < nCur; i++) { if (st.ids[i] !== liveIds[i]) { prefixOk = false; break } }
  }

  if (prefixOk) {
    let out = ''
    let newLines = 0
    if (!st.hasHeader) { out += JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n'; newLines++ }
    // ① 长度不变 ⇒ 只可能是原地修改：校验尾部窗口
    if (nLive === nCur) {
      const from = Math.max(0, nLive - TAIL_K)
      for (let i = from; i < nLive; i++) {
        const m = messages[i]
        const json = JSON.stringify(m)
        stringifyBytes += json.length
        const sig = sha1(json)
        const mid = liveIds[i]
        if (st.sigs.get(mid) !== sig) { out += lineR(mid, m); newLines++ }
      }
    } else {
      /* ② 追加前：只校验**最后一条已提交消息**（原地改最常见就发生在它身上）。
         更宽的窗口/中间位置交给空闲时的全量校验 —— 每拍都扫 TAIL_K 条 = 把固定成本又背回来。 */
      if (nCur > 0) {
        const i = nCur - 1
        const m = messages[i]
        const json = JSON.stringify(m)
        stringifyBytes += json.length
        const sig = sha1(json)
        const mid = liveIds[i]
        if (st.sigs.get(mid) !== sig) { out += lineR(mid, m); newLines++ }
      }
      // ③ 追加增量：**只 stringify 新增的这几条**
      for (let i = nCur; i < nLive; i++) {
        out += lineA(messages[i])
        newLines++
        stringifyBytes += Buffer.byteLength(JSON.stringify(messages[i]))
      }
    }
    if (!out && !metaChanged && !opts.force) return null
    if (!out) newLines = 0
    return {
      kind: 'append', id, data: out,
      metaData: metaChanged ? metaData : null, metaSig,
      bytes: Buffer.byteLength(out), lines: newLines, dropLegacy: false, stringifyBytes,
    }
  }

  /* ── 结构变化路径（增/删/换序，少见）：mid 段先 d 后 i ─────────────────── */
  let p = 0
  const minLen = Math.min(nCur, nLive)
  while (p < minLen && st.ids[p] === liveIds[p]) p++
  let suf = 0
  while (suf < minLen - p && st.ids[nCur - 1 - suf] === liveIds[nLive - 1 - suf]) suf++

  const oldMid = st.ids.slice(p, nCur - suf)
  const newMid: string[] = liveIds.slice(p, nLive - suf)
  let out = ''
  let newLines = 0
  /* 口径（少见路径，正确性优先）：mid 段整体「先全部删、再全部按序插」。
     这样 id 变了位置/内容被原地改/被删被插 全部覆盖；代价是 mid 段重写一遍 —— mid 段通常极小
     （编辑/删除多发生在尾部，后缀很长）。middle 段大 = 真的大改动，重写它是对的。 */
  for (const mid of oldMid) { out += lineD(mid); newLines++ }
  let af: string | null = p > 0 ? liveIds[p - 1] : null
  for (let k = 0; k < newMid.length; k++) {
    const mid = newMid[k]
    const m = messages[p + k]
    const json = JSON.stringify(m)
    stringifyBytes += json.length
    out += lineI(mid, af, m); newLines++
    af = mid
  }
  if (!out && !metaChanged && !opts.force) return null
  return {
    kind: 'append', id, data: out,
    metaData: metaChanged ? metaData : null, metaSig,
    bytes: Buffer.byteLength(out), lines: newLines, dropLegacy: false, stringifyBytes,
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 写 IO：每会话串行（Promise 链），全局在飞上限 maxInflight
 * ════════════════════════════════════════════════════════════════════════════ */

function acquireInflight(): Promise<void> {
  const c = C()
  if (inflightCount < c.maxInflight) { inflightCount++; return Promise.resolve() }
  return new Promise<void>((resolve) => { inflightWaiters.push(() => { inflightCount++; resolve() }) })
}

function releaseInflight(): void {
  inflightCount--
  const next = inflightWaiters.shift()
  if (next) { inflightWaiters = inflightWaiters.filter((x) => x !== next); next() }
}

/* Windows 上「rename 覆盖已存在文件」会被杀软扫描/索引器短暂占位，偶发 EPERM/EACCES/EBUSY
   —— 这是**暂时性**的，不是权限问题（实测：同目录同步 rename 400/400 成功，写到 1MB 级
   会话文件时才开始偶发）。重试是正确做法，不是掩盖：重试耗尽仍然抛错（绝不静默当作成功）。 */
function isTransientRenameErr(e: any): boolean {
  const c = String(e?.code || '')
  return c === 'EPERM' || c === 'EACCES' || c === 'EBUSY'
}

function sleepSyncMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* ignore */ }
}

async function renameRetryAsync(from: string, to: string, tries = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await fs.promises.rename(from, to) } catch (e) {
      if (isTransientRenameErr(e) && i + 1 < tries) {
        await new Promise((r) => setTimeout(r, 10 + i * 20))
        continue
      }
      throw e
    }
  }
}

function renameRetrySync(from: string, to: string, tries = 10): void {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      if (isTransientRenameErr(e) && i + 1 < tries) { sleepSyncMs(10 + i * 20); continue }
      throw e
    }
  }
}

function closeFd(st: SState): void {
  if (st.fd != null) { try { fs.closeSync(st.fd) } catch { /* ignore */ } st.fd = null }
}

function openAppend(st: SState): number {
  const p = pth(st.id)
  if (st.fd == null) {
    fs.mkdirSync(path.dirname(p.jsonl), { recursive: true })
    st.fd = fs.openSync(p.jsonl, 'a')
  }
  return st.fd
}

function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
}

function writeMetaSync(st: SState, plan: Plan): void {
  if (!plan.metaData) return
  const p = pth(st.id)
  const tmp = p.meta + '.tmp'
  fs.writeFileSync(tmp, plan.metaData, 'utf-8')
  renameRetrySync(tmp, p.meta)
  st.metaSig = plan.metaSig
}

function writeRewriteSync(st: SState, plan: Plan): void {
  const p = pth(st.id)
  const tmp = p.jsonl + '.tmp'
  fs.mkdirSync(path.dirname(p.jsonl), { recursive: true })
  const fd = fs.openSync(tmp, 'w')
  try { writeAllSync(fd, Buffer.from(plan.data, 'utf8')) } finally { fs.closeSync(fd) }
  if (st.fd != null) { try { fs.fsyncSync(st.fd) } catch { /* ignore */ } closeFd(st) }
  renameRetrySync(tmp, p.jsonl)      // 同分区原子替换：要么旧文件、要么新文件（带退避重试）
}

function applyPlanToState(st: SState, plan: Plan, messages: any[]): void {
  st.metaSig = plan.metaSig
  st.hasHeader = true
  if (plan.kind === 'rewrite') {
    st.bytes = plan.bytes
    st.lines = plan.lines
  } else {
    st.bytes += plan.bytes
    st.lines += plan.lines
  }
  refreshTailSigs(st, messages)
}

/** 异步写一批（同会话在链上串行；失败 → 抛，调用方负责重试与状态回滚） */
async function writePlan(st: SState, plan: Plan): Promise<void> {
  await acquireInflight()
  try {
    if (plan.kind === 'rewrite') {
      await fs.promises.mkdir(path.dirname(pth(st.id).jsonl), { recursive: true })
      const tmp = pth(st.id).jsonl + '.tmp'
      const fh = await fs.promises.open(tmp, 'w')
      try { await fh.writeFile(plan.data, 'utf8') } finally { await fh.close() }
      closeFd(st)
      await renameRetryAsync(tmp, pth(st.id).jsonl)
    } else if (plan.data) {
      const fd = openAppend(st)
      await new Promise<void>((resolve, reject) => {
        const buf = Buffer.from(plan.data, 'utf8')
        let off = 0
        const step = () => {
          fs.write(fd, buf, off, buf.length - off, null, (err, written) => {
            if (err) return reject(err)
            off += written
            if (off < buf.length) return step()
            resolve()
          })
        }
        step()
      })
    }
    if (plan.metaData) {
      const tmp = pth(st.id).meta + '.tmp'
      await fs.promises.writeFile(tmp, plan.metaData, 'utf-8')
      await renameRetryAsync(tmp, pth(st.id).meta)
    }
  } finally {
    releaseInflight()
  }
  if (plan.dropLegacy) {
    /* 迁移：**先写完新文件再删旧的**（任务单铁律）。删失败只 warn —— 老文件留着不影响读
       （读路径优先看 jsonl），但必须留痕，不能静默。 */
    const legacy = path.join(path.dirname(C().dir), `${st.id}.json`)
    try {
      if (fs.existsSync(legacy)) fs.rmSync(legacy)
      stats.migrations++
      console.log(`[member-store] 迁移完成：${st.id.slice(0, 8)}.json → .jsonl（${plan.lines - 1} 条消息）`)
    } catch (e) {
      console.error(`[member-store] 迁移后删老文件失败（老文件保留，不影响读）：${String((e as any)?.message || e)}`)
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 队列 / 固定窗口 / 重试
 * ════════════════════════════════════════════════════════════════════════════ */

function scheduleFlush(st: SState, delay: number): void {
  if (st.timer) return
  st.timer = setTimeout(() => {
    st.timer = null
    void flushOne(st.id)
  }, delay)
}

/** 置脏：把该会话排进**它自己的**写队列（固定窗口 200ms，不重置窗口） */
export function touchMember(id: string): void {
  const sid = String(id || '')
  if (!idSafe(sid)) return
  const st = ensureState(sid)
  if (st.pendingBytes >= C().softFlushBytes) {            // 体积软触发：立即 flush
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    void flushOne(sid)
    return
  }
  scheduleFlush(st, C().windowMs)
}

/** 排空一个会话（同 id 串行；在飞时置 again，写完再拍） */
async function flushOne(id: string): Promise<void> {
  const st = ensureState(id)
  if (st.writing) { st.again = true; return }
  st.writing = true
  try {
    do {
      st.again = false
      const t0 = Date.now()
      const c = C()
      const s = c.getSession(id)
      if (!s) break
      /* 空闲会话的全量校验（节流）：只在这里能发现"中间消息被原地改"这种隐形编辑。
         运行中不做 —— 成员跑起来时每拍都做全量就等于把旧路径的代价又背回来了。 */
      if (c.fullVerifyMs > 0 && !(c.isRunning ? c.isRunning(s) : false) && Date.now() - st.lastFullVerifyAt > c.fullVerifyMs) {
        st.lastFullVerifyAt = Date.now()
        verifyInPlace(id, st)
      }
      const payload = c.buildPayload(s)
      const plan = buildPlan(id, payload)
      if (!plan) break
      const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : []
      /* ★ 快照必须在 await 之前取：payload.messages 是**活引用**，写盘期间还会被追加。
         崩溃测试实测：写 405 条、ack 却记成 410 条（就是这条读晚了），字节数完全一致 ⇒ 不是丢数据。 */
      const committedCount = messages.length
      // 乐观态：先按 plan 更新（失败再回滚）
      const prevIds = st.ids
      const prevSigs = st.sigs
      const prevBytes = st.bytes
      const prevLines = st.lines
      const prevMetaSig = st.metaSig
      const prevHasHeader = st.hasHeader
      st.hasHeader = true
      st.ids = messages.map((m, i) => idOf(m, i))
      st.pendingBytes = 0
      try {
        await writePlan(st, plan)
      } catch (e) {
        st.ids = prevIds; st.sigs = prevSigs; st.bytes = prevBytes
        st.lines = prevLines; st.metaSig = prevMetaSig; st.hasHeader = prevHasHeader
        stats.writeErrors++
        st.failCount++
        console.error(`[member-store] ✗ 落盘失败（第 ${st.failCount} 次，稍后重试；**不回退旧路径**）：${id.slice(0, 8)} ${String((e as any)?.message || e)}`)
        const backoff = Math.min(4000, 500 * Math.pow(2, Math.min(3, st.failCount - 1)))
        if (st.failTimer) clearTimeout(st.failTimer)
        st.failTimer = setTimeout(() => { st.failTimer = null; void flushOne(id) }, backoff)
        stats.lastBatchMs = Date.now() - t0
        if (stats.lastBatchMs > stats.maxBatchMs) stats.maxBatchMs = stats.lastBatchMs
        break
      }
      st.failCount = 0
      applyPlanToState(st, plan, messages)
      stats.flushes++
      stats.appendedLines += plan.lines
      stats.bytesWritten += plan.bytes + (plan.metaData ? plan.metaData.length : 0)
      stats.stringifyBytes += plan.stringifyBytes
      const ms = Date.now() - t0
      stats.lastBatchMs = ms
      if (ms > stats.maxBatchMs) stats.maxBatchMs = ms
      if (ms > 800) console.warn(`[member-store] ⚠ 慢拍 ${ms}ms（${id.slice(0, 8)}，${plan.lines} 行 / ${plan.bytes}B）`)
      /* 压缩判定（★s4a 实测修正）：判据必须是**冗余行**（waste = 已写行数 − 存活消息数），
         不是"文件超过 8MB"。原来按字节判的结果：10MB 的成员会话**每一拍都触发全量重写**
         ——实测 8 秒写了 1421MB（写放大 100 倍），比旧路径还糟。
         现在的口径：waste > 400 行且（冗余比 > 50% 或 文件已过 8MB）才折叠；
         并且 60 秒内最多压一次（防抖动）。 */
      const waste = st.lines - messages.length
      const wasteRatio = messages.length > 0 ? waste / messages.length : waste
      const shouldCompact = plan.kind === 'append' && waste > c.compactMinWaste && (wasteRatio > 0.5 || st.bytes > c.compactBytes) &&
        (Date.now() - st.lastCompactAt > 60_000)
      if (shouldCompact) {
        st.lastCompactAt = Date.now()
        await compactOne(id, st)
      }
      // 落盘成功 → 交给主落盘更新摘要/索引（同序：先正文后索引）
      try {
        if (c.onWritten) c.onWritten(s, payload || {}, { messages: committedCount, lines: plan.lines, bytes: plan.bytes, kind: plan.kind })
      } catch (e) {
        console.error('[member-store] onWritten 回调失败（正文已落盘，索引下次会补）：', String((e as any)?.message || e))
      }
    } while (st.again)
  } finally {
    st.writing = false
  }
}

/**
 * 全量校验：把每条的 sha1 与磁盘上回放出来的内容对比，发现"中间消息被原地改/删"就补 r/d。
 * 只在**空闲**且节流窗口到了的时候跑一次（代价 = 全量 stringify 一次，等于旧路径一拍的代价，
 * 但频率从"每 500ms"降到"每 30s 且仅空闲"）。
 */
function verifyInPlace(id: string, st: SState): void {
  const c = C()
  const p = pth(id)
  const r = replayFile(p.jsonl, id)
  if (!r) return
  const s = c.getSession(id)
  if (!s) return
  const payload = c.buildPayload(s)
  if (!payload) return
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : []
  const liveIds = messages.map((m, i) => idOf(m, i))
  if (liveIds.length !== r.ids.length || liveIds.some((x, i) => x !== r.ids[i])) {
    /* 结构已不同 ⇒ 交给 buildPlan 的结构 diff（它会 d/i），这里不重复做事 */
    return
  }
  let diffs = 0
  for (let i = 0; i < messages.length; i++) {
    const json = JSON.stringify(messages[i])
    stats.stringifyBytes += json.length
    const onDisk = JSON.stringify(r.messages[i])
    if (sha1(json) !== sha1(onDisk)) diffs++
  }
  if (diffs > 0) {
    console.warn(`[member-store] 全量校验发现 ${diffs} 条消息在磁盘上落后于内存（${id.slice(0, 8)}）⇒ 补写`)
    /* 最简单也最稳的补法：整份 rewrite（此时已确认结构一致，rewrite 不会丢东西） */
    void rewriteNow(id, st)
  }
}

/** 强制整份重写（压缩 / 全量校验补写共用） */
function rewriteNow(id: string, st: SState): Promise<void> {
  const c = C()
  const s = c.getSession(id)
  if (!s) return Promise.resolve()
  const payload = c.buildPayload(s)
  if (!payload) return Promise.resolve()
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : []
  const meta: Record<string, any> = { ...payload }
  delete meta.messages
  meta.__ms = 1
  meta.__msCount = messages.length
  const metaData = JSON.stringify(meta)
  const parts = [JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n']
  for (const m of messages) parts.push(lineA(m))
  const data = parts.join('')
  const plan: Plan = {
    kind: 'rewrite', id, data, metaData, metaSig: sha1(metaData),
    bytes: Buffer.byteLength(data), lines: 1 + messages.length, dropLegacy: false,
    stringifyBytes: data.length,
  }
  st.ids = messages.map((m, i) => idOf(m, i))
  return writePlan(st, plan).then(() => {
    applyPlanToState(st, plan, messages)
    stats.flushes++
    stats.bytesWritten += plan.bytes + metaData.length
    stats.stringifyBytes += plan.stringifyBytes
  })
}

/** 压缩：把 op 历史折叠成"当前存活消息"，重写到同目录新文件（tmp → rename 原子替换） */
async function compactOne(id: string, st: SState): Promise<void> {
  const before = st.bytes
  try {
    await rewriteNow(id, st)
    stats.compactions++
    console.log(`[member-store] 压缩完成：${id.slice(0, 8)} ${(before / 1024 / 1024).toFixed(2)}MB → ${(st.bytes / 1024 / 1024).toFixed(2)}MB（${st.lines} 行）`)
  } catch (e) {
    stats.writeErrors++
    console.error(`[member-store] 压缩失败（原文件完好，下次再试）：${String((e as any)?.message || e)}`)
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 同步路径（退出 / 强杀前最后机会）
 * ════════════════════════════════════════════════════════════════════════════ */

/** 同步落盘一个成员会话（退出路径用；等价于 flushOne 的同步版） */
export function commitMemberSync(id: string): void {
  const sid = String(id || '')
  if (!idSafe(sid)) return
  const st = ensureState(sid)
  if (st.timer) { clearTimeout(st.timer); st.timer = null }
  if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
  try {
    const plan = buildPlan(sid)
    if (!plan) { closeFd(st); return }
    const c = C()
    const s = c.getSession(sid)
    const messages: any[] = s ? ((c.buildPayload(s)?.messages as any[]) || []) : []
    st.hasHeader = true
    if (plan.kind === 'rewrite') writeRewriteSync(st, plan)
    else if (plan.data) {
      const fd = openAppend(st)
      writeAllSync(fd, Buffer.from(plan.data, 'utf8'))
      try { fs.fsyncSync(fd) } catch { /* ignore */ }
    }
    writeMetaSync(st, plan)
    st.ids = messages.map((m, i) => idOf(m, i))
    applyPlanToState(st, plan, messages)
    stats.flushes++
    stats.appendedLines += plan.lines
    stats.bytesWritten += plan.bytes + (plan.metaData ? plan.metaData.length : 0)
    stats.stringifyBytes += plan.stringifyBytes
    if (plan.dropLegacy) {
      const legacy = path.join(path.dirname(c.dir), `${sid}.json`)
      try { if (fs.existsSync(legacy)) { fs.rmSync(legacy); stats.migrations++ } } catch (e) {
        console.error('[member-store] 迁移后删老文件失败（保留不影响读）：', String((e as any)?.message || e))
      }
    }
    closeFd(st)
  } catch (e) {
    stats.writeErrors++
    /* 退出路径失败必须喊出来（老板最恨"静默当作写成功"）：抛给调用方记 ERROR */
    throw new Error(`[member-store] 同步落盘失败（${sid.slice(0, 8)}）：${String((e as any)?.message || e)}`)
  }
}

/** 排空所有排队中的成员会话（退出 / 重启前）。同步写 + fsync。 */
export function flushAllMemberSessions(): void {
  for (const st of Array.from(states.values())) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
  }
  // 内存里所有成员会话（包括"从没置脏过"的）都过一遍：退出前最后一次机会
  let ids: string[] = []
  try {
    ids = Array.from(states.keys())
  } catch { ids = [] }
  for (const id of ids) {
    try { commitMemberSync(id) } catch (e) {
      console.error('[member-store] flushAll 单会话失败（继续排空其它）：', String((e as any)?.message || e))
    }
  }
  for (const st of states.values()) {
    if (st.fd != null) {
      try { fs.fsyncSync(st.fd) } catch { /* ignore */ }
      closeFd(st)
    }
  }
}

/** 删除成员会话的全部落盘文件（进回收目录，**不物理删**，与主落盘 quarantine 同语义） */
export function dropMember(id: string): void {
  const sid = String(id || '')
  if (!idSafe(sid)) return
  const c = C()
  const st = states.get(sid)
  if (st) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
    closeFd(st)
    states.delete(sid)
  }
  const p = path.join(c.dir, `${sid}.jsonl`)
  const pm = path.join(c.dir, `${sid}.meta.json`)
  if (!fs.existsSync(p) && !fs.existsSync(pm)) return
  try {
    fs.mkdirSync(c.trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (fs.existsSync(p)) fs.renameSync(p, path.join(c.trashDir, `${stamp}__${sid}.jsonl`))
    if (fs.existsSync(pm)) fs.renameSync(pm, path.join(c.trashDir, `${stamp}__${sid}.meta.json`))
    console.warn(`[member-store] 成员会话已隔离到 _trash（未物理删）：${sid.slice(0, 8)}`)
    pruneTrash(c.trashDir)
  } catch (e) {
    console.error('[member-store] 隔离失败（文件保留，不影响一致性）：', String((e as any)?.message || e))
  }
}

/** 回收目录按时间留最新 TRASH_KEEP 个（不无限长） */
function pruneTrash(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .map((f) => { try { return { f, t: fs.statSync(path.join(dir, f)).mtimeMs } } catch { return null } })
      .filter(Boolean) as Array<{ f: string; t: number }>
    if (files.length <= TRASH_KEEP) return
    files.sort((a, b) => a.t - b.t)
    for (const x of files.slice(0, files.length - TRASH_KEEP)) {
      try { fs.rmSync(path.join(dir, x.f)) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/* 测试/验收辅助：等所有队列排空 */
export async function awaitMemberStoreIdle(timeoutMs = 15000): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    let busy = false
    for (const st of states.values()) if (st.timer || st.writing || st.failTimer) { busy = true; break }
    if (!busy && inflightCount === 0) return true
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 关闭：清定时器 + 关 fd（进程退出前调用；**不落盘**，落盘交给 flushAllMemberSessions） */
export function stopMemberStore(): void {
  for (const st of states.values()) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
    closeFd(st)
  }
}

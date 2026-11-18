/**
 * sessionStore.ts —— **新建会话 append-only 落盘**（L1a，落盘改造第一步）
 *
 * 来源：同目录既有的「会话 append-only 存储模块」，按 L1a 施工单**复制改造**，不是重写。
 * 已经生产验证过的核心资产原样保留：五类 op 行（a/i/r/p/d）、每会话串行队列 + 固定窗口
 * 200ms（不重置）+ 单批 >1MB 立刻 flush + 全局在飞上限、坏尾截断、compact（冗余行判据 + 60s 节流）、
 * 全量校验（verifyInPlace，仅空闲且节流 30s）、**失败不静默**（ERROR 日志 + 保留脏态 + 退避重试，
 * 绝不回退到全量写）、内存与磁盘都找不到正文时拒绝写空。
 *
 * ── L1a 改了什么 ──────────────────────────────────────────────────────────
 * ① 路径：`data/sessions/<id>/meta.json` + `data/sessions/<id>/0001.jsonl`（单文件，L1b 才分段）。
 * ② 去掉成员语义：标识符、日志前缀、统计名一律 session*。
 * ③ **删掉「老 .json → jsonl 懒迁移」整套逻辑**（迁移状态字段 / 删旧文件动作 / 迁移次数统计）。
 *    L1a 铁律：磁盘上已有 `<id>.json` 的老会话继续走现有全量路径，一个字节都不许碰。
 * ④ 新增单写者守卫：`buildPlan` 开头若发现 `<id>.json` 存在就**抛错**（老会话绝不进新格式写路径）。
 *    这不是"读不到就回退"，是拒绝写 + 留痕；由 flushOne 记 ERROR、保留脏态、退避重试。
 *
 * ── 格式判定在哪儿（重要）────────────────────────────────────────────────
 * 本模块**不判格式**。server.ts 的 `isAppendOnlySession(id, s)` 用磁盘事实判定：
 *   · 会话（既有口径）                ⇒ memberStore（L1a 不动）
 *   · `<id>.json` 存在                    ⇒ 老格式，走现有全量路径（L1a 不动）
 *   · 以上都不是（含"刚新建、还没首写"） ⇒ 新格式，走本模块；首写会创建 meta.json + 0001.jsonl
 * 判据取「老 .json 在不在」而不是「meta.json 在不在」：全新会话首写前没有 meta.json，
 * 按后者二分会被判成老格式并写出 `<id>.json`，从此永久固化成老格式 —— 与"新建一律 append-only"冲突。
 * 「老 .json 存在」是单调事实：老会话一定有、新会话一定没有，重启后同样成立，无内存标志位、无兜底。
 *
 * ── 读路径 ────────────────────────────────────────────────────────────────
 * `hasSessionData(id)`（meta.json 存在）命中 ⇒ `readSessionPayload(id)` 只读 `<id>/`，
 * **绝不回退读老 .json**；meta 损坏直接抛错，0001.jsonl 损坏按坏尾截断并记 warn/ERROR。
 *
 * L1a 明确不做：分段（L1b）、数据迁移（L3）、检查点（L4）、SQLite（L2）、subRuns 瘦身（L7）。
 *
 * ── L1b 改了什么（分段 + 三条整改）──────────────────────────────────────────
 * ① 正文按 8MB / 4000 行分段：`<id>/0001.jsonl`、`0002.jsonl`…；`meta.segments` 是**顺序的唯一权威**。
 *    历史段冻结（永不打开写句柄），compact 只作用当前段；跨段回放把 op 累积到同一个 state，
 *    所以 P/D 语义天然跨段生效。每段各自做坏尾截断。
 * ② **兼容 L1a 数据**：meta 没有 `segments` 字段 ⇒ 视为单段 `['0001.jsonl']`，不迁移、不改旧文件。
 * ③ 封段顺序：先 compact 当前段 → 写下一段 header → 更新 meta.segments → 之后 append 一律写新段。
 * ④ 三条整改：A 格式判定缓存到 session 对象（server.ts，消灭热路径 existsSync）；
 *    B 所有临时文件用 `<target>.<pid>.<seq>.tmp`（异步 flushOne / 同步 commitSync 不再抢同一个 .tmp）；
 *    C `meta.__ms = 1` 是**写入方格式标记**（表示这份 meta 由 sessionStore 写，供将来格式识别/迁移判定），
 *      **不是消息计数**；`__msCount` 已因写放大删除。读取时 delete，不污染上层。
 * ⑤ L1b 明确不做：SQLite（L2）、数据迁移（L3）、检查点（L4）、subRuns 瘦身（L7）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/* ════════════════════════════════════════════════════════════════════════════
 * 配置
 * ════════════════════════════════════════════════════════════════════════════ */

/** 一批落盘完成后的快照事实 */
export interface SessionWriteInfo {
  /** 本批落盘后该会话的**消息条数**（快照，不是活引用） */
  messages: number
  /** 本批写入的 op 行数（rewrite 时 = 1 + messages） */
  lines: number
  /** 本批写入 jsonl 的字节数 */
  bytes: number
  kind: 'append'
  /** ★L2：本批真正变更的消息 id（含 verifyInPlace 补写的**早期消息**、尾部 r、新增 a/i、结构 d）。
      索引据此做增量 upsert/delete；只处理尾部 N 条会漏早期修改，所以必须带全量变更 id。 */
  changedIds: string[]
}

export interface SessionStoreConfig {
  /** 存储目录（`data/sessions`；新格式落在 `<id>/` 子目录） */
  dir: string
  /** 取内存会话（不存在 ⇒ null） */
  getSession: (id: string) => any | null
  /** 与主落盘同一份字段白名单的 payload（含 messages）。返回 null = 内存与磁盘都找不到正文 */
  buildPayload: (s: any) => Record<string, any> | null
  /** 正文 + meta 落盘成功后的回调（主落盘用它更新摘要/索引，同序：先正文后索引）。
   *  第 3 参 info = **本批的快照事实**（payload.messages 是活引用，异步写完后它可能已经长了）。 */
  onWritten?: (s: any, payload: Record<string, any>, info: SessionWriteInfo) => void
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

interface Cfg extends SessionStoreConfig {
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
export function configureSessionStore(c: SessionStoreConfig): void {
  if (!c || !c.dir) throw new Error('[session-store] configureSessionStore: dir 必填')
  cfg = {
    ...c,
    windowMs: c.windowMs ?? 200,
    maxInflight: c.maxInflight ?? 2,
    compactBytes: c.compactBytes ?? 8 * 1024 * 1024,
    compactLines: c.compactLines ?? 4000,
    compactMinWaste: c.compactMinWaste ?? 400,
    /* ★L9-c-part2：默认 30s → 5min。这条线上的值不是性能调优旋钮，
       是"多久检查一次数据自洽"的可靠性参数 —— 30s 一次对大会话（即便降级到尾部）仍偏频，
       它是兜底手段不是高频巡检。 */
    fullVerifyMs: c.fullVerifyMs ?? 300_000,
    softFlushBytes: c.softFlushBytes ?? 1024 * 1024,
    trashDir: c.trashDir || path.join(c.dir, '_trash'),
  }
  try { fs.mkdirSync(cfg.dir, { recursive: true }) } catch (e) {
    console.error('[session-store] 建目录失败：', String((e as any)?.message || e))
  }
}

function C(): Cfg {
  if (!cfg) throw new Error('[session-store] 未初始化：必须先调用 configureSessionStore()')
  return cfg
}

/* ════════════════════════════════════════════════════════════════════════════
 * 统计（压测/验收直接读这里，不靠猜）
 * ════════════════════════════════════════════════════════════════════════════ */

export interface SessionStoreStats {
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
  seals: number            // ★L1b：封段次数（验收取证用）
  fullVerifies: number
  lastBatchMs: number
  maxBatchMs: number
  pendingSessions: number
  inflight: number
}

const stats: SessionStoreStats = {
  flushes: 0, appendedLines: 0, bytesWritten: 0, stringifyBytes: 0,
  writeErrors: 0, truncations: 0, truncatedBytes: 0, badLines: 0,
  compactions: 0, seals: 0, fullVerifies: 0,
  lastBatchMs: 0, maxBatchMs: 0, pendingSessions: 0, inflight: 0,
}

export function sessionStoreStats(): SessionStoreStats {
  let pending = 0
  for (const st of states.values()) if (st.timer || st.writing) pending++
  return { ...stats, pendingSessions: pending, inflight: inflightCount }
}

export function resetSessionStoreStats(): void {
  stats.flushes = 0; stats.appendedLines = 0; stats.bytesWritten = 0; stats.stringifyBytes = 0
  stats.writeErrors = 0; stats.truncations = 0; stats.truncatedBytes = 0; stats.badLines = 0
  stats.compactions = 0; stats.seals = 0; stats.fullVerifies = 0
  stats.lastBatchMs = 0; stats.maxBatchMs = 0
}

/* ════════════════════════════════════════════════════════════════════════════
 * 每会话状态
 * ════════════════════════════════════════════════════════════════════════════ */

const TAIL_K = 3              // 每拍校验的尾部窗口大小（原地修改探测；窗口越大 = 每拍固定成本越高）
const TRASH_KEEP = 200        // 回收目录最多保留多少个文件（超出按时间删最旧）

/** ★L1b：`meta.segments` 的段元数据。segments 的**顺序**是回放顺序的唯一权威。
 *  n = 该段贡献的存活消息数（追加产生的消息；跨段 P 不换归属、跨段 D 不重算历史段 n，
 *      全局真值以跨段回放为准；重启后 replayAll 会按 owner 精确重算一次）。
 *  first/last = 段内首末消息 id（分页定位用），封段时冻结。 */
interface SegmentMeta {
  f: string
  n: number
  bytes: number
  first: string
  last: string
}

interface SState {
  id: string
  loaded: boolean
  /** 乐观态：已排队（含在飞）的 op **被认为已生效** 之后的 id 顺序 */
  ids: string[]
  /** 尾部窗口签名：msgId → sha1(JSON)（只存尾部 TAIL_K 条，不用全量 map） */
  sigs: Map<string, string>
  /** ★L1b：当前段字节数 / op 行数（封段与 compact 判据；历史段冻结不计） */
  bytes: number
  lines: number
  /** 段顺序的唯一权威（落盘到 meta.segments） */
  segments: SegmentMeta[]
  /** 当前段文件名 */
  curSeg: string
  /** 当前段贡献的存活消息数 */
  curSegN: number
  /** 上次 buildPlan 算出的 meta（不含 messages）；封段后重算 segments 再写回 */
  lastMeta: Record<string, any> | null
  /** verifyInPlace 发现的补写 r 行，交给 buildPlan 并入本批（不另开写盘通路） */
  pendingFixes: string
  /** ★L2：与 pendingFixes 一一对应的消息 id（本批 changedIds 的起点） */
  pendingFixIds: string[]
  /** 文件里已经有 header 行（新会话第一拍必须补上） */
  hasHeader: boolean
  /** meta 上次落盘的签名（未变则不重写 meta 文件） */
  metaSig: string
  /** ★L1b：meta.json 是否已落盘。它是 hasSessionData 的格式真源，首写必须随正文一起建立；
     不能只依赖 metaSig 变化，否则某些批次会落出「有 0001.jsonl、没有 meta.json」的半成品。 */
  metaOnDisk: boolean
  timer: ReturnType<typeof setTimeout> | null
  writing: boolean
  again: boolean
  failCount: number
  failTimer: ReturnType<typeof setTimeout> | null
  lastFullVerifyAt: number
  lastCompactAt: number
  fd: number | null
  pendingBytes: number
  /** ★L9-c-part2：metaOnly touch（如 session.markRead 只改 lastReadAt）置位一次 ⇒
   *  下一拍 flushOne 跳过 verifyInPlace（只为一个数字把 65MB 会话全量对账一遍不值得）。
   *  用完即清；真实正文写入的 touch 不置位，照常校验。 */
  skipVerifyOnce?: boolean
}

const states = new Map<string, SState>()
let inflightCount = 0
let inflightWaiters: Array<() => void> = []

function pth(id: string) {
  const dir = path.join(C().dir, id)
  return { dir, meta: path.join(dir, 'meta.json'), transcript: path.join(dir, 'transcript.json') }
}

/** 段文件全路径。段名只允许 NNNN.jsonl —— 杜绝 meta.segments 带来的路径穿越。 */
function segFile(id: string, name: string): string {
  if (!/^\d{4}\.jsonl$/.test(name)) throw new Error(`[session-store] 非法段名（${id.slice(0, 8)}）：${String(name)}`)
  return path.join(pth(id).dir, name)
}

/* ══ ★1130（甲方案）：transcript 独立文件 ══════════════════════════════════════════
 * 为什么单独放：`transcript`（pi 形状的模型上下文种子）与 `messages`（DSH 形状的前端契约）
 * 是**同一段对话的两份副本**。它原来被写进 `meta.json` ⇒ 691 个 meta 共 612MB、其中 568MB 是它
 * （最大一个 36.44MB），带来的病：
 *   · 每次落盘要把 36MB 重新 stringify 进 meta（IO 放大）
 *   · `readSessionPayload` 要先 JSON.parse 整个 meta ⇒ **点开大会话要等 2.9 秒**（实测）
 *   · 同一段对话在磁盘上存两份
 * 现在：正文（jsonl）→ messages；本文件 → transcript。meta 只留元数据。
 *
 * 口径（三条，别改）：
 *   · **写**：只在正文落盘成功之后写（正文是主、transcript 是派生），与 subRuns 同一条纪律；
 *   · **不改内容**：转出去的是**原样的 transcript 数组**，一个字节都不动（迁移要可核对）；
 *   · **读优先**：有本文件就用它；没有才让上层从 messages 重建（既有 getter 逻辑不变）。
 */
function transcriptFileOf(id: string): string { return pth(id).transcript }

/** 读独立 transcript 文件（不存在/损坏返回 null，由调用方决定重建） */
export function readTranscriptFile(id: string): any[] | null {
  const sid = String(id || '')
  if (!idSafe(sid)) return null
  const p = transcriptFileOf(sid)
  try {
    if (!fs.existsSync(p)) return null
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return Array.isArray(arr) ? arr : null
  } catch (e) {
    /* 不静默：transcript 坏了意味着模型上下文要回退到重建（可能少工具调用），必须能查到 */
    console.error('[session-store] transcript.json 读取失败（该会话将回退到重建）：', sid.slice(0, 8), String((e as any)?.message || e))
    return null
  }
}

/** 写独立 transcript 文件（原子写；空数组 = 删除文件，不留空壳） */
export function writeTranscriptFile(id: string, transcript: any[] | null | undefined): void {
  const sid = String(id || '')
  if (!idSafe(sid)) return
  const p = transcriptFileOf(sid)
  const arr = Array.isArray(transcript) ? transcript : []
  try {
    if (!arr.length) {
      if (fs.existsSync(p)) fs.rmSync(p, { force: true })
      return
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = tmpName(p)
    fs.writeFileSync(tmp, JSON.stringify(arr), 'utf-8')
    fs.renameSync(tmp, p)
  } catch (e) {
    /* 写失败不阻塞主流程（正文已落盘），但必须 ERROR 留痕：下次打开会重建，可能少工具调用 */
    console.error('[session-store] transcript.json 写入失败：', sid.slice(0, 8), String((e as any)?.message || e))
  }
}


function curSegFile(st: SState): string {
  return segFile(st.id, st.curSeg)
}

/** ★整改 B：tmp 名唯一化。异步 flushOne 与同步 commitSync 不再抢同一个固定 `.tmp`。 */
let tmpSeq = 0
function tmpName(target: string): string {
  tmpSeq++
  return `${target}.${process.pid}.${tmpSeq}.tmp`
}

/** ★L1b：`meta.segments` 是段顺序的唯一权威；**缺失 = L1a 单段数据**（不迁移、不扫描猜测）。 */
function segmentListOf(id: string, meta: any): string[] {
  const raw = meta && Array.isArray(meta.segments) ? meta.segments : null
  if (raw) {
    const list = raw.map((x: any) => String(x?.f || '')).filter((f: string) => /^\d{4}\.jsonl$/.test(f))
    if (list.length !== raw.length) throw new Error(`[session-store] ${id.slice(0, 8)} meta.segments 含非法段名`)
    return list
  }
  return fs.existsSync(segFile(id, '0001.jsonl')) ? ['0001.jsonl'] : []
}

function readMeta(id: string): any {
  return JSON.parse(fs.readFileSync(pth(id).meta, 'utf-8'))
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
      hasHeader: false, metaSig: '', timer: null, writing: false, again: false,
      segments: [], curSeg: '0001.jsonl', curSegN: 0, lastMeta: null, pendingFixes: '', pendingFixIds: [], metaOnDisk: false,
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
  owner: string[]
  segCounts: Map<string, number>
  segLines: Map<string, number>
  segBytes: Map<string, number>
  lines: number
  bytes: number
  truncated: boolean
}

interface Accum {
  messages: any[]
  ids: string[]
  owner: string[]
}

/** 把 op 应用到**累积** state（这就是跨段 P/D 生效的原因：后段 op 作用于前段的 ids/messages）。 */
function applyOp(op: any, acc: Accum, seg: string): void {
  if (!op || typeof op !== 'object') return
  const t = op.t
  if (t === 'h') return
  if (t === 'a') {
    acc.messages.push(op.m)
    acc.ids.push(idOf(op.m, acc.messages.length - 1))
    acc.owner.push(seg)
    return
  }
  if (t === 'r') {
    const i = acc.ids.indexOf(String(op.id))
    if (i < 0) {
      acc.messages.push(op.m)
      acc.ids.push(String(op.id || idOf(op.m, acc.messages.length - 1)))
      acc.owner.push(seg)
    } else {
      acc.messages[i] = op.m          // 原地改：归属段不变（跨段 P 命中历史段消息）
    }
    return
  }
  if (t === 'i') {
    const m = op.m
    const mid = String(op.id || idOf(m, acc.messages.length))
    if (op.af == null) {
      acc.messages.unshift(m); acc.ids.unshift(mid); acc.owner.unshift(seg); return
    }
    const at = acc.ids.indexOf(String(op.af))
    if (at < 0) {
      acc.messages.push(m); acc.ids.push(mid); acc.owner.push(seg); return
    }
    acc.messages.splice(at + 1, 0, m); acc.ids.splice(at + 1, 0, mid); acc.owner.splice(at + 1, 0, seg)
    return
  }
  if (t === 'd') {
    const i = acc.ids.indexOf(String(op.id))
    if (i >= 0) {
      acc.messages.splice(i, 1); acc.ids.splice(i, 1); acc.owner.splice(i, 1)
    }
  }
}

/** 回放**一个段**。坏尾截断按段独立（末行无 '\n' 才截断），互不影响。
 *  段文件由 meta.segments 声明却不存在 ⇒ 抛错（数据不一致，绝不静默跳过）。 */
function replaySegment(file: string, sid: string, seg: string, acc: Accum): { lines: number; bytes: number; truncated: boolean } | null {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch (e) {
    if ((e as any)?.code === 'ENOENT') {
      throw new Error(`[session-store] ${sid.slice(0, 8)} 段文件缺失（${seg}）：meta.segments 与磁盘不一致`)
    }
    throw e
  }
  let buf: Buffer
  try { buf = fs.readFileSync(fd) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }

  let lines = 0, offset = 0, completeEnd = 0, badLines = 0
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset)
    if (nl === -1) break
    completeEnd = nl + 1
    let line = buf.toString('utf8', offset, nl)
    offset = completeEnd
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    lines++
    let op: any
    try { op = JSON.parse(line) } catch (e) {
      badLines++; stats.badLines++
      console.error(`[session-store] ${sid.slice(0, 8)} ${seg} 第 ${lines} 行损坏（跳过，后续继续读）：${String((e as any)?.message || e)}`)
      continue
    }
    try { applyOp(op, acc, seg) } catch (e) {
      badLines++; stats.badLines++
      console.error(`[session-store] ${sid.slice(0, 8)} ${seg} 第 ${lines} 行 apply 失败（跳过）：${String((e as any)?.message || e)}`)
    }
  }
  let truncated = false
  if (completeEnd < buf.length) {
    const lost = buf.length - completeEnd
    truncated = true
    stats.truncations++
    stats.truncatedBytes += lost
    console.warn(`[session-store] ⚠ ${sid.slice(0, 8)} ${seg} 撕裂尾：截断 ${lost} 字节（完整行 ${lines} 行）`)
    try { fs.truncateSync(file, completeEnd) } catch (e) {
      console.error(`[session-store] 截断失败（只读不影响本次加载）：${String((e as any)?.message || e)}`)
    }
  }
  if (badLines > 0) console.error(`[session-store] ${sid.slice(0, 8)} ${seg} 本次加载共 ${badLines} 行损坏（已跳过，未截断）`)
  return { lines, bytes: completeEnd, truncated }
}

/** ★L1b：按 meta.segments 顺序逐段回放，累积到同一个 state。 */
function replayAll(id: string, meta: any): ReplayResult | null {
  const list = segmentListOf(id, meta)
  if (!list.length) return null
  const acc: Accum = { messages: [], ids: [], owner: [] }
  const segLines = new Map<string, number>()
  const segBytes = new Map<string, number>()
  const segCounts = new Map<string, number>()
  let lines = 0, bytes = 0, truncated = false
  for (const f of list) {
    const r = replaySegment(segFile(id, f), id, f, acc)
    if (!r) continue
    lines += r.lines; bytes += r.bytes
    if (r.truncated) truncated = true
    segLines.set(f, r.lines); segBytes.set(f, r.bytes)
  }
  for (const o of acc.owner) segCounts.set(o, (segCounts.get(o) || 0) + 1)
  return { messages: acc.messages, ids: acc.ids, owner: acc.owner, segCounts, segLines, segBytes, lines, bytes, truncated }
}

/** 从回放出的 owner 精确重算每段元数据（读盘后调用一次，不是每拍算）。 */
function segmentsMetaOf(r: ReplayResult, list: string[]): SegmentMeta[] {
  return list.map((f) => {
    const idxs: number[] = []
    for (let i = 0; i < r.owner.length; i++) if (r.owner[i] === f) idxs.push(i)
    return {
      f,
      n: idxs.length,
      bytes: r.segBytes.get(f) || 0,
      first: idxs.length ? r.ids[idxs[0]] : '',
      last: idxs.length ? r.ids[idxs[idxs.length - 1]] : '',
    }
  })
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

/** 从磁盘装载状态（首次 touch / 首次读后的写都要它）。L1b：跨段回放 + 当前段定位。 */
function loadState(id: string, st: SState): void {
  st.loaded = true
  st.metaOnDisk = fs.existsSync(pth(id).meta)
  let meta: any = {}
  if (fs.existsSync(pth(id).meta)) {
    try { meta = readMeta(id) } catch (e) {
      /* meta 坏了不能静默：标题/usage/segments 都会丢，如实抛给调用方 */
      throw new Error(`[session-store] meta 不可用（${id.slice(0, 8)}）：${String((e as any)?.message || e)}`)
    }
  }
  const r = replayAll(id, meta)
  if (r) {
    const list = segmentListOf(id, meta)
    st.ids = r.ids
    st.segments = segmentsMetaOf(r, list)
    st.curSeg = list[list.length - 1]
    st.curSegN = r.segCounts.get(st.curSeg) || 0
    st.bytes = r.segBytes.get(st.curSeg) || 0      // 当前段字节（封段/compact 判据）
    st.lines = r.segLines.get(st.curSeg) || 0
    st.hasHeader = (r.segLines.get(st.curSeg) || 0) > 0
    st.lastMeta = meta
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
  /* 没有任何段 = 新建会话还没首写过。首段固定 0001.jsonl（L1a 布局一致）。 */
  st.ids = []
  st.sigs = new Map()
  st.segments = [{ f: '0001.jsonl', n: 0, bytes: 0, first: '', last: '' }]
  st.curSeg = '0001.jsonl'
  st.curSegN = 0
  st.bytes = 0
  st.lines = 0
  st.hasHeader = false
  st.lastMeta = null
}

/** ★L1a 格式判定的磁盘事实：`<id>/meta.json` 存在 = 新格式会话（启动扫描 / 读正文都只认它）。
 *  首写前 meta.json 不存在是**正常态**（新建会话还没落过盘），不是"读不到"。 */
export function hasSessionData(id: string): boolean {
  const sid = String(id || '')
  if (!idSafe(sid)) return false
  try { return fs.existsSync(pth(sid).meta) } catch { return false }
}

/** 新格式正文文件路径（索引 stat 用）。★L1b：返回**当前段**；
 *  热路径优先取已加载的内存 state（零同步 IO），冷路径才读 meta.segments。 */
export function bodyFileOf(id: string): string {
  const sid = String(id)
  const st = states.get(sid)
  if (st && st.loaded && st.curSeg) return curSegFile(st)
  const meta = readMeta(sid)
  const list = segmentListOf(sid, meta)
  return segFile(sid, list.length ? list[list.length - 1] : '0001.jsonl')
}

/** 列出磁盘上所有新格式会话 id（只认 meta.json 这个磁盘事实；启动补读用）。
 *  扫描失败记 ERROR 并返回空列表 —— 由调用方决定怎么处理，绝不静默当成"没有会话"。 */
export function listSessionIds(): string[] {
  const c = C()
  try {
    return fs.readdirSync(c.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && idSafe(d.name) &&
        fs.existsSync(path.join(c.dir, d.name, 'meta.json')))
      .map((d) => d.name)
  } catch (e) {
    console.error('[session-store] 列出新格式会话失败：', String((e as any)?.message || e))
    return []
  }
}

/** 读一个会话的完整 payload（meta + 跨段回放出的 messages）。没有 ⇒ null（**不造空壳**）。 */
export function readSessionPayload(id: string): Record<string, any> | null {
  const sid = String(id || '')
  if (!idSafe(sid)) return null
  const p = pth(sid)
  let meta: any = {}
  if (fs.existsSync(p.meta)) {
    try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf-8')) } catch (e) {
      throw new Error(`会话 meta 不可用（${path.basename(p.meta)}）：${String((e as any)?.message || e)}`)
    }
  } else {
    console.warn(`[session-store] ${sid.slice(0, 8)} 缺 meta 文件（标题/usage 等元数据缺失，内容完好）`)
  }
  const r = replayAll(sid, meta)
  if (!r) return null
  if (meta && typeof meta === 'object') {
    delete meta.__ms
    delete meta.__msCount
    delete meta.segments      // 段索引是落盘内部数据，不往上层 payload 里带
  }
  return { ...(meta || {}), id: sid, messages: r.messages }
}

/** 扫描目录读全部会话 payload（boot 用；`onlyId` 时只读那一个） */
export function readAllSessionPayloads(onlyId?: string): Record<string, any>[] {
  const out: Record<string, any>[] = []
  if (onlyId) {
    const one = readSessionPayload(String(onlyId))
    return one ? [one] : []
  }
  const dirs = listSessionIds()   // onlyId 分支已在上面提前返回
  for (const sid of dirs) {
    try {
      const one = readSessionPayload(sid)
      if (one) out.push(one)
    } catch (e) {
      /* 单个坏文件不挡启动（与主落盘同口径），但必须留 ERROR —— 不是静默跳过 */
      console.error('[session-store] 加载失败（该会话本次跳过）：', sid, String((e as any)?.message || e))
    }
  }
  return out
}

/* ════════════════════════════════════════════════════════════════════════════
 * 差异计算（核心：**每拍只 stringify 增量**）
 * ════════════════════════════════════════════════════════════════════════════ */

interface Plan {
  id: string
  data: string
  metaData: string | null
  metaSig: string
  bytes: number
  lines: number
  /** 本批新增（a/i）的消息 id，用于维护 segments[].first/last/n */
  addedIds: string[]
  /** ★L2：本批全部变更的 id（新增 + 原地改 + 删除 + 早期补写），给 onWritten 更新派生索引 */
  changedIds: string[]
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

/** ★L1b：构造真正要落盘的 meta.json 内容。
 *  段统计在**本批预测后**写入（当前段 n/bytes/first/last），避免"落盘值滞后一批"；
 *  这些值仍是派生缓存，重启后由 replayAll + segmentsMetaOf 精确重算一次。 */
function metaDataForPlan(st: SState, base: Record<string, any>, addedIds: string[], extraBytes: number): string {
  const last = st.segments.length - 1
  const segs = st.segments.map((x, i) => i !== last ? x : {
    ...x,
    n: x.n + addedIds.length,
    bytes: x.bytes + extraBytes,
    first: x.first || addedIds[0] || '',
    last: addedIds[addedIds.length - 1] || x.last,
  })
  return JSON.stringify({ ...base, segments: segs })
}

/**
 * 生成一批写盘计划。**同步**：只做"比较 + 序列化增量"，不碰磁盘（IO 交给 writePlan）。
 * 返回 null = 没有改动（不做无意义的空写）。
 */
function buildPlan(id: string, payloadArg?: Record<string, any> | null, opts: { force?: boolean } = {}): Plan | null {
  /* ★L1a 单写者守卫：老 .json 存在 ⇒ 这条会话永远不许进新格式写路径（防误判造成双写）。 */
  if (fs.existsSync(path.join(C().dir, `${id}.json`))) {
    throw new Error(`[session-store] 拒绝写入：会话 ${id.slice(0, 8)} 已有老格式 <id>.json（老会话只走全量路径）`)
  }
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
    console.error('[session-store] 跳过（内存与磁盘都找不到正文，绝不写空）：', id.slice(0, 8))
    return null
  }
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : []
  const metaBase: Record<string, any> = { ...payload }
  delete metaBase.messages
  /* ★1130（甲方案）：**transcript 也不许进 meta.json**。
     它与 messages 是同一段对话的两份副本，原来被 `{...payload}` 原样带进 meta
     ⇒ 691 个 meta 共 612MB、其中 568MB 就是它（最大一个 36.44MB），
     后果是每次落盘 stringify 36MB、点开大会话 JSON.parse 要 2.9 秒。
     现在它住在独立文件 `<id>/transcript.json`（读写见 `readTranscriptFile`/`writeTranscriptFile`）。
     这一行与 `delete metaBase.messages` 同性质：**结构保证**，不是兜底 ——
     写侧（`buildSessionPayload`）已经不返回它，这里再删是防止将来有人往 payload 里塞回去。 */
  delete metaBase.transcript
  /* ★整改 C：`__ms` 是写入方格式标记（说明这份 meta 由 sessionStore 写，供将来格式识别/迁移判定），
     **不是消息计数**；`__msCount` 已删（写放大）。读取时 delete，不污染上层。 */
  metaBase.__ms = 1
  st.lastMeta = metaBase
  /* ★L1b 结构正解：metaSig 只覆盖「用户元数据 + 段顺序(f 列表)」。
     segments 的 n/bytes/first/last 是**派生统计**，不能驱动 meta 写盘 —— 否则每加一条消息
     就要对 meta.json 做一次 tmp+rename（L1a 实测 4~9ms/批的写放大）。
     真正写盘时由 metaDataForPlan 带上**本批预测后**的准确段统计；重启后 replayAll 精确重算。 */
  const sigJson = JSON.stringify({ ...metaBase, segFiles: st.segments.map((x) => x.f) })
  const metaSig = sha1(sigJson)
  let stringifyBytes = sigJson.length
  const metaChanged = metaSig !== st.metaSig || !st.metaOnDisk

  const liveIds: string[] = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) liveIds[i] = idOf(messages[i], i)

  /* verifyInPlace 发现的内容差异并入本批 append —— 不另开写盘通路。
     写成功后由 applyPlanToState 清空；写失败保留（下批重试，r 行幂等）。 */
  const fixLines = st.pendingFixes ? st.pendingFixes.split('\n').length - 1 : 0
  const changedIds: string[] = st.pendingFixIds.slice()

  /* ── 快路径：纯追加 / 长度不变（只校验尾部窗口） ──────────────────────── */
  const nCur = st.ids.length
  const nLive = liveIds.length
  let prefixOk = nLive >= nCur
  if (prefixOk) {
    for (let i = 0; i < nCur; i++) { if (st.ids[i] !== liveIds[i]) { prefixOk = false; break } }
  }

  if (prefixOk) {
    let out = st.pendingFixes
    const addedIds: string[] = []
    let newLines = fixLines
    if (!st.hasHeader) { out += JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n'; newLines++ }
    if (nLive === nCur) {
      const from = Math.max(0, nLive - TAIL_K)
      for (let i = from; i < nLive; i++) {
        const m = messages[i]
        const json = JSON.stringify(m)
        stringifyBytes += json.length
        const mid = liveIds[i]
        if (st.sigs.get(mid) !== sha1(json)) { out += lineR(mid, m); newLines++; changedIds.push(mid) }
      }
    } else {
      if (nCur > 0) {
        const i = nCur - 1
        const m = messages[i]
        const json = JSON.stringify(m)
        stringifyBytes += json.length
        if (st.sigs.get(liveIds[i]) !== sha1(json)) { out += lineR(liveIds[i], m); newLines++; changedIds.push(liveIds[i]) }
      }
      for (let i = nCur; i < nLive; i++) {
        out += lineA(messages[i])
        newLines++
        addedIds.push(liveIds[i])
        changedIds.push(liveIds[i])
        stringifyBytes += Buffer.byteLength(JSON.stringify(messages[i]))
      }
    }
    if (!out && !metaChanged && !opts.force) return null
    if (!out) newLines = 0
    const outBytes = Buffer.byteLength(out)
    return {
      id, data: out, metaData: metaChanged ? metaDataForPlan(st, metaBase, addedIds, outBytes) : null, metaSig,
      bytes: outBytes, lines: newLines, addedIds, changedIds, stringifyBytes,
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
  let out = st.pendingFixes
  let newLines = fixLines
  const addedIds: string[] = []
  for (const mid of oldMid) { out += lineD(mid); newLines++; changedIds.push(mid) }
  let af: string | null = p > 0 ? liveIds[p - 1] : null
  for (let k = 0; k < newMid.length; k++) {
    const mid = newMid[k]
    const m = messages[p + k]
    stringifyBytes += JSON.stringify(m).length
    out += lineI(mid, af, m); newLines++
    addedIds.push(mid)
    changedIds.push(mid)
    af = mid
  }
  if (!out && !metaChanged && !opts.force) return null
  const outBytes = Buffer.byteLength(out)
  return {
    id, data: out, metaData: metaChanged ? metaDataForPlan(st, metaBase, addedIds, outBytes) : null, metaSig,
    bytes: outBytes, lines: newLines, addedIds, changedIds, stringifyBytes,
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
  if (st.fd == null) {
    fs.mkdirSync(pth(st.id).dir, { recursive: true })
    st.fd = fs.openSync(curSegFile(st), 'a')   // ★L1b：只打开**当前段**；历史段永不打开写句柄
  }
  return st.fd
}

function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
}

/** 写 meta.json（tmp + rename 原子替换）。★整改 B：tmp 名唯一。 */
function writeMetaSync(st: SState, metaData: string, metaSig: string): void {
  const p = pth(st.id)
  fs.mkdirSync(p.dir, { recursive: true })
  const tmp = tmpName(p.meta)
  fs.writeFileSync(tmp, metaData, 'utf-8')
  renameRetrySync(tmp, p.meta)
  st.metaSig = metaSig
  st.metaOnDisk = true
}

function applyPlanToState(st: SState, plan: Plan, messages: any[]): void {
  st.metaSig = plan.metaSig
  st.hasHeader = true
  st.bytes += plan.bytes          // 当前段字节
  st.lines += plan.lines          // 当前段 op 行数
  st.curSegN += plan.addedIds.length
  const cur = st.segments[st.segments.length - 1]
  if (cur && cur.f === st.curSeg) {
    cur.n = st.curSegN
    cur.bytes = st.bytes
    if (plan.addedIds.length) {
      if (!cur.first) cur.first = plan.addedIds[0]
      cur.last = plan.addedIds[plan.addedIds.length - 1]
    }
  }
  st.pendingFixes = ''            // 补写已随本批成功落盘
  st.pendingFixIds = []
  refreshTailSigs(st, messages)
}

/** 异步写一批（同会话在链上串行；失败 → 抛，调用方负责重试与状态回滚） */
async function writePlan(st: SState, plan: Plan): Promise<void> {
  await acquireInflight()
  try {
    /* 每会话一个 `<id>/` 目录；只在目录确实缺时才建（每批 await mkdir 会拖慢增量）。 */
    if (!fs.existsSync(pth(st.id).dir)) await fs.promises.mkdir(pth(st.id).dir, { recursive: true })
    /* ★L1b：meta.json 是 hasSessionData 的**格式真源**，必须先于正文 append 建立。
       原来「先正文(异步 fs.write) 后 meta」，一旦主线程被长任务堵住，fs.write 的回调不返回，
       正文已落盘而 meta 永远写不出来 ⇒ 留下「有 0001.jsonl、没 meta.json」的半成品会话，
       重启后该会话从列表消失。正文缺失时 replayAll 返回 null（不造空壳），所以 meta 先行是安全的。
       索引回调 onWritten 仍在 writePlan 成功后（顺序：meta → 正文 → 索引）。 */
    if (plan.metaData) {
      const tmp = tmpName(pth(st.id).meta)     // ★整改 B：唯一 tmp
      await fs.promises.writeFile(tmp, plan.metaData, 'utf-8')
      await renameRetryAsync(tmp, pth(st.id).meta)
      st.metaOnDisk = true
    }
    if (plan.data) {
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
  } finally {
    releaseInflight()
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
export function touch(id: string, opts?: { metaOnly?: boolean }): void {
  const sid = String(id || '')
  if (!idSafe(sid)) return
  const st = ensureState(sid)
  if (opts?.metaOnly) st.skipVerifyOnce = true
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
         运行中不做 —— 成员跑起来时每拍都做全量就等于把旧路径的代价又背回来了。
         ★L9-c-part2：metaOnly 拍（如 markRead 只改 lastReadAt，正文零变化）跳过一次 ——
         判据：这次拍没有正文要写，对账注定"replay 全量 ⇒ 发现没东西可写"，纯浪费；
         校验推迟到下一个真实正文拍 / 下个 fullVerifyMs 周期，发现能力不丢。 */
      const _skipOnce = st.skipVerifyOnce === true
      st.skipVerifyOnce = false
      const _p2needVerify = !_skipOnce && c.fullVerifyMs > 0 && !(c.isRunning ? c.isRunning(s) : false) && Date.now() - st.lastFullVerifyAt > c.fullVerifyMs
      if (_p2needVerify) {
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
        console.error(`[session-store] ✗ 落盘失败（第 ${st.failCount} 次，稍后重试；**不回退旧路径**）：${id.slice(0, 8)} ${String((e as any)?.message || e)}`)
        const backoff = Math.min(4000, 500 * Math.pow(2, Math.min(3, st.failCount - 1)))
        if (st.failTimer) clearTimeout(st.failTimer)
        st.failTimer = setTimeout(() => { st.failTimer = null; void flushOne(id) }, backoff)
        stats.lastBatchMs = Date.now() - t0
        if (stats.lastBatchMs > stats.maxBatchMs) stats.maxBatchMs = stats.lastBatchMs
        break
      }
      st.failCount = 0
      applyPlanToState(st, plan, messages)
      /* ★L1b：写完后按 8MB / 4000 行封段（与 commitSync 共用同一个同步实现）。
         封段失败只记 ERROR —— 正文已落盘成功，不把成功说成失败，也不把失败说成成功。 */
      try { maybeSealSegment(id, st) } catch (e) {
        stats.writeErrors++
        console.error(`[session-store] 封段失败（正文已落盘，下次再试）：${id.slice(0, 8)} ${String((e as any)?.message || e)}`)
      }
      stats.flushes++
      stats.appendedLines += plan.lines
      stats.bytesWritten += plan.bytes + (plan.metaData ? plan.metaData.length : 0)
      stats.stringifyBytes += plan.stringifyBytes
      const ms = Date.now() - t0
      stats.lastBatchMs = ms
      if (ms > stats.maxBatchMs) stats.maxBatchMs = ms
      if (ms > 800) console.warn(`[session-store] ⚠ 慢拍 ${ms}ms（${id.slice(0, 8)}，${plan.lines} 行 / ${plan.bytes}B）`)
      /* 压缩判定（★s4a 实测修正）：判据必须是**冗余行**（waste = 已写行数 − 存活消息数），
         不是"文件超过 8MB"。原来按字节判的结果：10MB 的会话**每一拍都触发全量重写**
         ——实测 8 秒写了 1421MB（写放大 100 倍），比旧路径还糟。
         现在的口径：waste > 400 行且（冗余比 > 50% 或 文件已过 8MB）才折叠；
         并且 60 秒内最多压一次（防抖动）。 */
      /* ★L1b：冗余判据按**当前段**算（历史段冻结，不计入）。 */
      const waste = st.lines - st.curSegN
      const wasteRatio = st.curSegN > 0 ? waste / st.curSegN : waste
      const shouldCompact = waste > c.compactMinWaste && (wasteRatio > 0.5 || st.bytes > c.compactBytes) &&
        (Date.now() - st.lastCompactAt > 60_000)
      if (shouldCompact) {
        st.lastCompactAt = Date.now()
        await compactOne(id, st)
      }
      // 落盘成功 → 交给主落盘更新摘要/索引（同序：先正文后索引）
      try {
        if (c.onWritten) c.onWritten(s, payload || {}, { messages: committedCount, lines: plan.lines, bytes: plan.bytes, kind: 'append', changedIds: plan.changedIds })
      } catch (e) {
        console.error('[session-store] onWritten 回调失败（正文已落盘，索引下次会补）：', String((e as any)?.message || e))
      }
    } while (st.again)
  } finally {
    st.writing = false
  }
}

/**
 * 全量校验（跨段）：把每条的 sha1 与**跨段回放**出来的内容对比。
 * 发现"中间消息被原地改"⇒ 生成 r 行交给 buildPlan 并入本批 append（不另开写盘通路、不碰历史段）。
 */
/** ★L9-c-part2：全量校验的体积上限 —— 超过它只校验尾部 FULL_VERIFY_TAIL 条。
 *  实测 75.8MB / 2639 条：replay 483ms + 逐条 sha1 1221ms = 1704ms 同步阻塞，
 *  而它的目的只是"发现中间消息被原地改"——那种编辑只发生在工具结果回填，几乎总在最近几条。
 *  ⚠️ 这个阈值**不是**性能参数，是"能不能发现某类错误"的口径决定：超过 2MB 的会话，
 *  尾部 300 条之外的**中间消息被原地改**将不再被自动发现（id 序列比对仍全量，删消息/乱序仍能发现）。
 *  要盯中间内容的完整审计走 _reindex / --verify 这类离线全量工具，不挂在写路径上。 */
const FULL_VERIFY_MAX_BYTES = 2 * 1024 * 1024    // 2MB
const FULL_VERIFY_TAIL = 300                     // 超过上限时只校验尾部这么多条

function verifyInPlace(id: string, st: SState): void {
  const c = C()
  let meta: any = {}
  try { meta = readMeta(id) } catch (e) {
    /* ★L2 小修 2：首写前本来就没有 meta.json，ENOENT 是**正常状态**，不能用 ERROR 刷屏；
       其它错误（JSON 损坏 / 权限）仍必须留痕 —— 静默的是「文件不存在」，不是「校验失败」。 */
    if ((e as any)?.code !== 'ENOENT') {
      console.error(`[session-store] 全量校验读 meta 失败（本次跳过校验）：${id.slice(0, 8)} ${String((e as any)?.message || e)}`)
    }
    return
  }
  const r = replayAll(id, meta)
  if (!r) return
  /* ★L2 小修 1：真正开始校验才计数（读 meta 失败/无段/无会话的跳过路径不算）。 */
  stats.fullVerifies++
  const s = c.getSession(id)
  if (!s) return
  const payload = c.buildPayload(s)
  if (!payload) return
  const messages: any[] = Array.isArray(payload.messages) ? payload.messages : []
  const liveIds = messages.map((m, i) => idOf(m, i))
  /* ★L9-c-part2：**长度错位不再整体放弃，改公共前缀比对**。
     原来这里 `liveIds.length !== r.ids.length ⇒ return` —— 而本函数恰恰在"内存领先磁盘
     （有 pending 追加）的写拍"上被调 ⇒ 长度必然不等 ⇒ 永远早退，全量校验形同虚设；
     唯一能走到比对的是"无追加的空闲拍"（markRead 类）—— 而那一类又被 metaOnly 跳过
     （见 flushOne）⇒ 两条路合起来 = 校验永远不比内容。改成：
       · id 序列（公共前缀）逐一比对，任何一位不同 = 结构性分歧（删/乱序）⇒ 仍放弃（不生成 r 行）；
       · 内容比对只覆盖 [from, min(内存, 磁盘)) —— 磁盘上真实存在的范围，内存领先的部分本来
         就马上要写盘，无需比对。
     这样写拍（内存领先）也能发现中间/尾部消息被原地改。 */
  const common = Math.min(messages.length, r.messages.length)
  let structural = false
  for (let i = 0; i < common; i++) {
    if (liveIds[i] !== r.ids[i]) { structural = true; break }
  }
  if (structural) return
  let fixes = ''
  /* ★L9-c-part2：大会话只校验尾部 -------------------------------------------------
     verifyInPlace 的唯一目的是发现"中间消息被原地改"这种隐形编辑（见 flushOne 注释），
     而原地改只发生在"工具结果回填"这类场景，几乎总在最近几条。
     实测 75.8MB / 2639 条：逐条 stringify×2+sha1×2 = 1221ms（replay 另算 483ms），
     对 65MB 会话每 30s 一次是完全不成比例的成本。
     判据用**跨段总字节数**（r.bytes，replay 的真实读量）：字节才是成本的真变量。
     不能用 st.bytes（当前段）—— 封段后当前段几乎为空，会把 65MB 会话错判成"小会话"退回全量。
     ⚠️ 尾部的 **id 序列比对（上面 liveIds vs r.ids）仍然全量做**——那是数组比较，很便宜，
     能发现"消息被删/顺序变了"；降级只砍"逐条内容 sha1"。 */
  const big = r.bytes > FULL_VERIFY_MAX_BYTES
  const from = big ? Math.max(0, messages.length - FULL_VERIFY_TAIL) : 0
  const end = common                                   // 只比磁盘上真实存在的范围
  let fixIds: string[] = []
  for (let i = from; i < end; i++) {
    const json = JSON.stringify(messages[i])
    stats.stringifyBytes += json.length
    if (sha1(json) !== sha1(JSON.stringify(r.messages[i]))) {
      fixes += lineR(liveIds[i], messages[i])
      fixIds.push(liveIds[i])
    }
  }
  if (fixes) {
    console.warn(`[session-store] 全量校验发现磁盘落后于内存（${id.slice(0, 8)}）⇒ 本批补写 r 行`)
    st.pendingFixes += fixes
    st.pendingFixIds.push(...fixIds)
  }
}

/** ★L1b：compact **只作用于当前段**。读当前段的 op 历史 → 折叠 → tmp/rename 写回。
 *  折叠必须保留"跨段 patch"：段2 里对段1 消息的 r/d 仍然以 r/d 行写出，
 *  不能退化成 a 行（否则回放时消息会重复）。历史段全程只读。 */
function compactCurrentSegmentSync(id: string, st: SState): void {
  const file = curSegFile(st)
  const buf = fs.readFileSync(file)
  const ops: any[] = []
  let offset = 0
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset)
    if (nl === -1) break                     // 撕裂尾：只丢最后半行
    let line = buf.toString('utf8', offset, nl)
    offset = nl + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    try { ops.push(JSON.parse(line)) } catch (e) {
      stats.badLines++
      console.error(`[session-store] compact 跳过损坏行（${st.curSeg}）：${String((e as any)?.message || e)}`)
    }
  }
  /* ★L9-c-part2-fix：折叠 = **先重放，再按最终态输出**。
     前两版都"边重放边往 out 里 push"，acc 与 out 两套状态要手工同步 —— 漏一处就出错
     （v1 按 id 建 Map 覆盖丢 557 条；v2 修了覆盖但 r 追加 / d 不回收 out 又引入重复/复活）。
     现在只信 acc（重放结果就是真相），段内消息一律输出最终态 a 行；
     跨段 r/d（指向历史段的消息，段内 indexOf 未命中）原样保留为 r/d 行 ——
     历史段只读，补丁不能拍成新消息，否则回放到该段时会重复。
     折叠后 replayAll 的结果与折叠前逐条一致（构造上成立，专测见交付说明）。 */
  const acc: { messages: any[]; ids: string[] } = { messages: [], ids: [] }
  type Cross = { kind: 'r' | 'd'; id: string; m?: any; seq: number }
  const cross: Cross[] = []
  let seq = 0
  for (const op of ops) {
    if (!op || op.t === 'h') { seq++; continue }
    if (op.t === 'a') {
      acc.messages.push(op.m); acc.ids.push(idOf(op.m, acc.messages.length))
    } else if (op.t === 'i') {
      const mid = String(op.id || idOf(op.m, acc.messages.length))
      const at = op.af == null ? -1 : acc.ids.indexOf(String(op.af))
      if (at < 0) { acc.messages.push(op.m); acc.ids.push(mid) }
      else { acc.messages.splice(at + 1, 0, op.m); acc.ids.splice(at + 1, 0, mid) }
    } else if (op.t === 'r') {
      const mid = String(op.id)
      const at = acc.ids.indexOf(mid)
      if (at < 0) cross.push({ kind: 'r', id: mid, m: op.m, seq })
      else acc.messages[at] = op.m                      // 只改 acc；输出统一按最终态
    } else if (op.t === 'd') {
      const mid = String(op.id)
      const at = acc.ids.indexOf(mid)
      if (at < 0) cross.push({ kind: 'd', id: mid, seq })
      else { acc.messages.splice(at, 1); acc.ids.splice(at, 1) }
    }
    seq++
  }
  const parts = [JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n']
  for (const m of acc.messages) parts.push(lineA(m))
  cross.sort((a, b) => a.seq - b.seq)
  for (const c of cross) parts.push(c.kind === 'r' ? lineR(c.id, c.m) : lineD(c.id))
  const data = parts.join('')
  closeFd(st)                                  // rename 会换 inode，旧 fd 必须关
  const tmp = tmpName(file)                    // ★整改 B：唯一 tmp
  fs.writeFileSync(tmp, data, 'utf-8')
  renameRetrySync(tmp, file)
  st.bytes = Buffer.byteLength(data)
  st.lines = parts.length
  /* ★L9-c-part2：fold 后按重放结果重算当前段状态 —— 旧行为漏了这步，
     st.ids / st.curSegN 与磁盘永久漂移（内存 2639 vs 磁盘 2082 ⇒ 后续校验全部失真）。 */
  const histN = Math.max(0, st.ids.length - st.curSegN)
  for (const oldId of st.ids.slice(histN)) st.sigs.delete(oldId)
  st.ids = st.ids.slice(0, histN).concat(acc.ids)
  st.curSegN = acc.messages.length
  for (let i = 0; i < acc.messages.length; i++) {
    st.sigs.set(acc.ids[i], sha1(JSON.stringify(acc.messages[i])))
  }
  const cur = st.segments[st.segments.length - 1]
  if (cur && cur.f === st.curSeg) { cur.bytes = st.bytes; cur.n = st.curSegN }
  stats.compactions++
  console.log(`[session-store] 压缩当前段 ${st.curSeg}：${(buf.length / 1024).toFixed(1)}KB → ${(st.bytes / 1024).toFixed(1)}KB（${parts.length} 行，存活 ${st.curSegN} 条）`)
}

/** ★L1b 封段（同步，异步/同步两条写路径共用**同一处实现**）。
 *  顺序：① compact 当前段 → ② 写下一段 header → ③ 冻结当前段元数据 + push 新段 + 写 meta.segments。
 *  之后所有 append 走新段，历史段再也不会被打开写句柄。 */
function maybeSealSegment(id: string, st: SState): void {
  const c = C()
  if (st.bytes <= c.compactBytes && st.lines <= c.compactLines) return
  compactCurrentSegmentSync(id, st)
  const nextName = String(st.segments.length + 1).padStart(4, '0') + '.jsonl'
  const nextFile = segFile(id, nextName)
  const header = JSON.stringify({ v: 1, t: 'h', id, at: Date.now() }) + '\n'
  closeFd(st)
  fs.mkdirSync(pth(id).dir, { recursive: true })
  fs.writeFileSync(nextFile, header, 'utf-8')
  const frozen = st.segments[st.segments.length - 1]
  if (frozen && frozen.f === st.curSeg) { frozen.bytes = st.bytes; frozen.n = st.curSegN }
  st.segments.push({ f: nextName, n: 0, bytes: Buffer.byteLength(header), first: '', last: '' })
  st.curSeg = nextName
  st.bytes = Buffer.byteLength(header)
  st.lines = 1
  st.curSegN = 0
  st.hasHeader = true
  const meta = { ...(st.lastMeta || {}), __ms: 1, segments: st.segments }
  const metaData = JSON.stringify(meta)
  writeMetaSync(st, metaData, sha1(metaData))
  stats.seals++
  console.log(`[session-store] 封段：${id.slice(0, 8)} ${frozen?.f || '?'} → ${nextName}（共 ${st.segments.length} 段，${frozen?.bytes || 0}B 冻结）`)
}

/** 压缩调度（flushOne 的 60s 节流判定之后调用）：只压缩当前段，历史段不动。 */
async function compactOne(id: string, st: SState): Promise<void> {
  const before = st.bytes
  try {
    compactCurrentSegmentSync(id, st)
    console.log(`[session-store] 压缩完成：${id.slice(0, 8)} ${(before / 1024).toFixed(1)}KB → ${(st.bytes / 1024).toFixed(1)}KB（${st.lines} 行）`)
  } catch (e) {
    stats.writeErrors++
    console.error(`[session-store] 压缩失败（原文件完好，下次再试）：${String((e as any)?.message || e)}`)
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 同步路径（退出 / 强杀前最后机会）
 * ════════════════════════════════════════════════════════════════════════════ */

/** 同步落盘一个会话（退出路径用；等价于 flushOne 的同步版） */
export function commitSync(id: string): void {
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
    const syncPayload = s ? c.buildPayload(s) : null
    const messages: any[] = Array.isArray(syncPayload?.messages) ? syncPayload.messages : []
    st.hasHeader = true
    /* ★L1b：与 writePlan 同序 —— meta（格式真源）先于正文。 */
    if (plan.metaData) writeMetaSync(st, plan.metaData, plan.metaSig)
    if (plan.data) {
      const fd = openAppend(st)
      writeAllSync(fd, Buffer.from(plan.data, 'utf8'))
      try { fs.fsyncSync(fd) } catch { /* ignore */ }
    }
    st.ids = messages.map((m, i) => idOf(m, i))
    applyPlanToState(st, plan, messages)
    /* ★L2：同步退出路径同样要更新派生索引 —— 与 flushOne 同一条口径，不能让其中一条写盘路径漏掉。
       索引写失败只记 ERROR，不把已经成功的正文落盘说成失败。 */
    try {
      if (c.onWritten) c.onWritten(s, syncPayload || {}, { messages: messages.length, lines: plan.lines, bytes: plan.bytes, kind: 'append', changedIds: plan.changedIds })
    } catch (e) { console.error('[session-store] commitSync 索引回调失败（正文已落盘）：', String((e as any)?.message || e)) }
    /* ★L1b：写完后按 8MB/4000 行封段（与 flushOne 共用同一个同步实现） */
    maybeSealSegment(sid, st)
    stats.flushes++
    stats.appendedLines += plan.lines
    stats.bytesWritten += plan.bytes + (plan.metaData ? plan.metaData.length : 0)
    stats.stringifyBytes += plan.stringifyBytes
    closeFd(st)
  } catch (e) {
    stats.writeErrors++
    throw new Error(`[session-store] 同步落盘失败（${sid.slice(0, 8)}）：${String((e as any)?.message || e)}`)
  }
}

/** 排空所有排队中的会话（退出 / 重启前）。同步写 + fsync。 */
export function flushAll(): void {
  for (const st of Array.from(states.values())) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
  }
  // 内存里所有会话（包括"从没置脏过"的）都过一遍：退出前最后一次机会
  let ids: string[] = []
  try {
    ids = Array.from(states.keys())
  } catch { ids = [] }
  for (const id of ids) {
    try { commitSync(id) } catch (e) {
      console.error('[session-store] flushAll 单会话失败（继续排空其它）：', String((e as any)?.message || e))
    }
  }
  for (const st of states.values()) {
    if (st.fd != null) {
      try { fs.fsyncSync(st.fd) } catch { /* ignore */ }
      closeFd(st)
    }
  }
}

/** 删除会话的全部落盘文件（进回收目录，**不物理删**，与主落盘 quarantine 同语义） */
export function dropSession(id: string): void {
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
  const dir = path.join(c.dir, sid)
  if (!fs.existsSync(dir)) return
  try {
    fs.mkdirSync(c.trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.renameSync(dir, path.join(c.trashDir, `${stamp}__${sid}`))
    console.warn(`[session-store] 会话目录已隔离到 _trash（未物理删）：${sid.slice(0, 8)}`)
    pruneTrash(c.trashDir)
  } catch (e) {
    console.error('[session-store] 隔离失败（文件保留，不影响一致性）：', String((e as any)?.message || e))
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
      try { fs.rmSync(path.join(dir, x.f), { recursive: true, force: true }) }
      catch (e) { console.error('[session-store] 回收目录清理失败：', x.f, String((e as any)?.message || e)) }
    }
  } catch (e) { console.error('[session-store] 回收目录扫描失败：', String((e as any)?.message || e)) }
}

/* 测试/验收辅助：等所有队列排空 */
export async function awaitSessionStoreIdle(timeoutMs = 15000): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    let busy = false
    for (const st of states.values()) if (st.timer || st.writing || st.failTimer) { busy = true; break }
    if (!busy && inflightCount === 0) return true
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 关闭：清定时器 + 关 fd（进程退出前调用；**不落盘**，落盘交给 flushAll） */
export function stopSessionStore(): void {
  for (const st of states.values()) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.failTimer) { clearTimeout(st.failTimer); st.failTimer = null }
    closeFd(st)
  }
}

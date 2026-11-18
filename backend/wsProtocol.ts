/**
 * 1035 阶段 A · WS 协议校验（纯函数层）
 *
 * ⚠️ 本文件**不被任何现有代码 import**（阶段 A 只做骨架，不接线）：
 *    - 不 import ./server.ts（那个 1.2M 字符的模块，import 进来就炸启动）
 *    - 不碰 http / ws 库，只做"信封 → 判定"的纯逻辑
 *    ⇒ 零行为变化、零重启风险。阶段 B 接线时才由 wsHub.ts 使用。
 *
 * 纪律（见 NiusDream-实时传输层重构方案-1035.md §〇）：
 *    禁止兜底 —— 任何"拿不到 / 判不出 / 字段缺失"一律返回 Fail，绝不补默认值。
 *    禁止打补丁 —— 没有 "|| 默认值"、没有 try/catch 吞异常。
 *
 * 协议版本：v1（不匹配即拒绝，不写兼容层）
 */

export const PROTOCOL_V = 1

/* ── 背压阈值（与现有 SSE 版同口径，见 server.ts:8484）──
   ⚠️ 单位是字节，口径 = node 写缓冲 / ws 的 bufferedAmount（不含内核 socket 缓冲） */
export const WS_SOFT_CAP_BYTES = 4 * 1024 * 1024
export const WS_HARD_CAP_BYTES = 16 * 1024 * 1024

/** op 幂等窗口：per-connection 记住最近 N 个 opId 的结果 */
export const OP_ID_WINDOW = 200

export const ERROR_CODES = [
  'unauthorized',
  'invalid-frame',
  'invalid-caps',
  'unsupported-version',
  'not-subscribed',
  'session-not-found',
  'conflict',
  'too-large',
  'op-expired',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const STREAMS = ['session', 'host'] as const
export type StreamName = (typeof STREAMS)[number]

export const FRAME_DETAILS = ['full', 'summary'] as const
export type FrameDetail = (typeof FRAME_DETAILS)[number]

/** 下行帧类型 */
export const DOWN_KINDS = ['event', 'frame', 'snapshot', 'ack', 'error', 'hello-ack', 'ping'] as const
export type DownKind = (typeof DOWN_KINDS)[number]

/**
 * 上行 op 白名单（方案 §3.4：**只迁这 9 个**，其余 340 个 RPC 继续走 HTTP）。
 * 增加 op = 改协议 = 升 PROTOCOL_V，不许悄悄加。
 */
export const OPS = ['subscribe', 'unsubscribe', 'prompt', 'steer', 'stop', 'approve', 'answer', 'resync', 'upgrade-detail'] as const
export type OpName = (typeof OPS)[number]

/**
 * 每个 op 的 sid 策略：
 *  - required          ：必须带非空 sid
 *  - required-or-empty ：必须带 sid 字段，但允许 ''（subscribe{sid:''} = 跨会话通道，见方案 §3.16）
 */
export const OP_SID_POLICY: Record<OpName, 'required' | 'required-or-empty'> = {
  subscribe: 'required-or-empty',
  unsubscribe: 'required-or-empty',
  prompt: 'required',
  steer: 'required',
  stop: 'required',
  approve: 'required',
  answer: 'required',
  resync: 'required',
  'upgrade-detail': 'required',
}

/** 哪些 op 必须带 payload（对象） */
export const OP_REQUIRES_PAYLOAD: Record<OpName, boolean> = {
  subscribe: false,
  unsubscribe: false,
  prompt: true,
  steer: true,
  stop: false,
  approve: true,
  answer: true,
  resync: true,
  'upgrade-detail': true,
}

/* ══════════════ 结果类型（判别联合，不用异常做流程控制）══════════════ */

export interface Fail {
  ok: false
  code: ErrorCode
  message: string
}
export interface Pass<T> {
  ok: true
  value: T
}
export type Result<T> = Pass<T> | Fail

const fail = (code: ErrorCode, message: string): Fail => ({ ok: false, code, message })
const pass = <T>(value: T): Pass<T> => ({ ok: true, value })

/* ══════════════ 能力（caps）══════════════ */

export interface Caps {
  streams: StreamName[]
  frameDetail: FrameDetail
  /** 客户端可接受的单帧上限（可选；不做默认值） */
  maxFrameBytes?: number
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 校验 hello.caps。
 * 严格：缺 caps / streams 空 / 未知 stream / 未知 frameDetail / maxFrameBytes 非正 → 全部 Fail。
 * **没有默认值** —— 想用 full 就必须显式声明 full。
 */
export function validateCaps(raw: unknown): Result<Caps> {
  if (!isPlainObject(raw)) return fail('invalid-caps', 'caps 缺失或不是对象（协议要求 hello 必须显式声明能力）')

  const streamsRaw = raw.streams
  if (!Array.isArray(streamsRaw) || streamsRaw.length === 0) {
    return fail('invalid-caps', 'caps.streams 必须是非空数组')
  }
  const streams: StreamName[] = []
  for (const s of streamsRaw) {
    if (typeof s !== 'string' || !(STREAMS as readonly string[]).includes(s)) {
      return fail('invalid-caps', `caps.streams 含未知流: ${String(s)}（允许: ${STREAMS.join('|')}）`)
    }
    if (!streams.includes(s as StreamName)) streams.push(s as StreamName)
  }

  const detailRaw = raw.frameDetail
  if (typeof detailRaw !== 'string' || !(FRAME_DETAILS as readonly string[]).includes(detailRaw)) {
    return fail('invalid-caps', `caps.frameDetail 缺失或未知: ${String(detailRaw)}（允许: ${FRAME_DETAILS.join('|')}）`)
  }

  const caps: Caps = { streams, frameDetail: detailRaw as FrameDetail }

  if (raw.maxFrameBytes !== undefined) {
    const n = raw.maxFrameBytes
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      return fail('invalid-caps', 'caps.maxFrameBytes 必须是正数（不填则省略该字段，不要写 0/null）')
    }
    caps.maxFrameBytes = n
  }
  return pass(caps)
}

/* ══════════════ 上行信封 ══════════════ */

export interface HelloFrame {
  v: number
  kind: 'hello'
  caps: Caps
}
export interface OpFrame {
  v: number
  kind: 'op'
  opId: string
  op: OpName
  /** subscribe/unsubscribe 允许 ''（跨会话通道） */
  sid: string
  payload?: Record<string, unknown>
}
/**
 * 心跳应答。浏览器**拿不到协议层 pong 的 API**，所以协议额外定义了一条应用层 pong：
 * 服务端发 `{kind:'ping'}`，客户端回 `{v:1, kind:'pong'}`。
 * （同时保留"任何入站消息都算活着"的判定 —— 见 wsHub.handleMessage）
 */
export interface PongFrame {
  v: number
  kind: 'pong'
}
export type ClientFrame = HelloFrame | OpFrame | PongFrame

/** v 校验单独一个函数：任何帧都要先过它 */
export function checkVersion(raw: unknown): Result<number> {
  if (!isPlainObject(raw)) return fail('invalid-frame', '帧不是对象')
  const v = raw.v
  if (typeof v !== 'number') return fail('invalid-frame', '缺 v（协议版本），不接受默认版本')
  if (v !== PROTOCOL_V) return fail('unsupported-version', `协议版本不匹配: 收到 v=${v}，本服务只支持 v=${PROTOCOL_V}`)
  return pass(v)
}

/**
 * 解析客户端发来的一帧（字符串或已解析对象）。
 * 顺序：能解析 → v → kind → 各 kind 的必填项。
 */
export function decodeClientFrame(input: unknown): Result<ClientFrame> {
  let obj: unknown = input
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input)
    } catch (e) {
      return fail('invalid-frame', '不是合法 JSON: ' + String((e as Error)?.message || e))
    }
  }
  const ver = checkVersion(obj)
  if (!ver.ok) return ver
  const raw = obj as Record<string, unknown>

  const kind = raw.kind
  if (kind === 'hello') {
    const caps = validateCaps(raw.caps)
    if (!caps.ok) return caps
    return pass({ v: PROTOCOL_V, kind: 'hello', caps: caps.value })
  }
  if (kind === 'op') return decodeOp(raw)
  if (kind === 'pong') return pass({ v: PROTOCOL_V, kind: 'pong' })
  return fail('invalid-frame', `未知 kind: ${String(kind)}（上行只允许 hello / op / pong）`)
}

function decodeOp(raw: Record<string, unknown>): Result<OpFrame> {
  const opId = raw.opId
  if (typeof opId !== 'string' || !opId.trim()) {
    return fail('invalid-frame', 'op 缺 opId（幂等靠它，不许省略）')
  }
  const op = raw.op
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
    return fail('invalid-frame', `未知 op: ${String(op)}（允许: ${OPS.join('|')}）`)
  }
  const opName = op as OpName

  const sid = raw.sid
  const policy = OP_SID_POLICY[opName]
  if (sid !== undefined && typeof sid !== 'string') return fail('invalid-frame', `op.sid 必须是字符串（op=${opName}）`)
  const sidStr = typeof sid === 'string' ? sid : undefined
  if (policy === 'required' && (!sidStr || !sidStr.trim())) {
    return fail('invalid-frame', `op=${opName} 必须带非空 sid`)
  }
  if (policy === 'required-or-empty' && sidStr === undefined) {
    return fail('invalid-frame', `op=${opName} 必须带 sid 字段（跨会话通道请显式传 ""）`)
  }

  const needsPayload = OP_REQUIRES_PAYLOAD[opName]
  if (needsPayload) {
    if (!isPlainObject(raw.payload)) return fail('invalid-frame', `op=${opName} 必须带 payload 对象`)
    return pass({ v: PROTOCOL_V, kind: 'op', opId, op: opName, sid: sidStr as string, payload: raw.payload })
  }
  const out: OpFrame = { v: PROTOCOL_V, kind: 'op', opId, op: opName, sid: sidStr as string }
  if (isPlainObject(raw.payload)) out.payload = raw.payload
  return pass(out)
}

/* ══════════════ 下行帧构造（服务端出帧只走这两个入口，便于统一口径）══════════════ */

export interface ErrorFrame {
  v: number
  kind: 'error'
  /** 关联的 op；全局错误为 '' */
  opId: string
  code: ErrorCode
  message: string
}
export interface AckFrame {
  v: number
  kind: 'ack'
  opId: string
  accepted: true
  payload: Record<string, unknown>
}

export function makeErrorFrame(opId: string, code: ErrorCode, message: string): ErrorFrame {
  return { v: PROTOCOL_V, kind: 'error', opId, code, message }
}

/** 受理 ack（方案 §3.14：ack = "已受理"，不是 "本轮结束"） */
export function makeAckFrame(opId: string, payload: Record<string, unknown>): AckFrame {
  return { v: PROTOCOL_V, kind: 'ack', opId, accepted: true, payload }
}

/* ══════════════ opId 幂等（per-connection）══════════════ */

export type BeginOutcome =
  /** 第一次见到，可以执行 */
  | { state: 'new' }
  /** 已执行完，直接回放结果（绝不重复执行） */
  | { state: 'replay'; payload: Record<string, unknown> }
  /** 正在执行中又来了同一个 opId */
  | { state: 'inflight' }
  /** 太旧，已滑出窗口 —— 不许猜"它没执行过" */
  | { state: 'expired' }

type Slot = { status: 'inflight' } | { status: 'done'; payload: Record<string, unknown> }

/**
 * 每条连接一个实例。窗口 = OP_ID_WINDOW，先进先出淘汰。
 *
 * 语义（方案 §3.4）：
 *   - 同 opId 重发 **直接回放缓存结果**，绝不重复执行（prompt 重跑 = 用户看到两条一样的消息）
 *   - 滑出窗口 ⇒ expired（报错让用户重操作，不静默重跑）
 *
 * ⚠️ 区分"没见过"与"见过但已滑出窗口"靠一个小环形表（evicted）。
 *    没有它就只能把"已过期"当成"全新" ⇒ **重复执行**（正是禁兜底要防的事）。
 */
export class OpIdRegistry {
  private readonly limit: number
  private readonly slots = new Map<string, Slot>()
  /** 已滑出窗口的 opId（仅用于回答 expired；上限同窗口大小） */
  private readonly evicted: string[] = []

  constructor(limit: number = OP_ID_WINDOW) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`OpIdRegistry limit 非法: ${String(limit)}`)
    this.limit = limit
  }

  get size(): number {
    return this.slots.size
  }

  /** 查询/占位：new 表示"归你执行"（**调用即占位**），其余都不许执行 */
  begin(opId: string): BeginOutcome {
    const hit = this.slots.get(opId)
    if (hit) {
      if (hit.status === 'inflight') return { state: 'inflight' }
      return { state: 'replay', payload: hit.payload }
    }
    if (this.evicted.includes(opId)) return { state: 'expired' }
    this.slots.set(opId, { status: 'inflight' })
    this.evict()
    return { state: 'new' }
  }

  /**
   * 记录执行结果。
   * ⚠️ 只对 begin() 返回过 'new' 的 opId 调用；重复调用视为内部 bug，直接报错（不静默覆盖）。
   */
  finish(opId: string, payload: Record<string, unknown>): void {
    const hit = this.slots.get(opId)
    if (!hit) throw new Error(`OpIdRegistry.finish 未知 opId: ${opId}（没走过 begin 就开始记账）`)
    if (hit.status === 'done') {
      throw new Error(`OpIdRegistry.finish 重复记账: ${opId}（说明上层对同一 opId 执行了两次）`)
    }
    this.slots.set(opId, { status: 'done', payload })
  }

  /**
   * 执行失败/中断时清掉占位，允许客户端重试同一 opId。
   * （失败不是"已执行"，不能留下 inflight 把后续重试全挡住）
   */
  abandon(opId: string): void {
    const hit = this.slots.get(opId)
    if (hit && hit.status === 'inflight') this.slots.delete(opId)
  }

  /**
   * 淘汰最旧的**已完成**记录。
   * ⚠️ 绝不淘汰 inflight：删掉占位会让之后同一个 opId 又变回 'new' ⇒ **重复执行**（比窗口变大危险得多）。
   * 极端情况下（同时有 >limit 个 inflight）窗口会短暂变大 —— 这是刻意的取舍，不是遗漏。
   */
  private evict(): void {
    if (this.slots.size <= this.limit) return
    for (const [key, slot] of this.slots) {
      if (this.slots.size <= this.limit) return
      if (slot.status !== 'done') continue
      this.slots.delete(key)
      this.evicted.push(key)
      while (this.evicted.length > this.limit) this.evicted.shift()
    }
  }
}

/* ══════════════ 背压分道（谁能丢）══════════════ */

export type FrameLane = 'droppable' | 'durable'

/**
 * 哪些帧在软上限下可以丢。
 * 口径与现有 SSE 版 isRecoverableFrame（server.ts:8487）**保持一致**，但按新协议重列：
 *   - event 可丢，但**丢了必须让客户端可发现**（发 session/lagged）→ 靠 seq 缺口 resync
 *   - snapshot / ack / error / hello-ack 不可丢
 *   - host 流（设置/会话增删）不可丢：丢了会"看着像没保存"，且量大不大
 */
export function frameLane(stream: StreamName, kind: DownKind, payloadType?: string): FrameLane {
  if (kind === 'event') return 'droppable'
  if (kind === 'frame') {
    /* 截图类是最大的一类，丢一帧只影响直播观感 */
    if (payloadType === 'browser-frame') return 'droppable'
    return 'droppable'
  }
  if (kind === 'snapshot' || kind === 'ack' || kind === 'error' || kind === 'hello-ack') return 'durable'
  if (kind === 'ping') return 'droppable'
  /* 编译期已经穷举；到这里说明 DownKind 加了新值却忘了归类 —— 按不可丢处理并留痕 */
  console.error(`[wsProtocol] frameLane 未归类的 kind=${String(kind)} stream=${stream}（按 durable 处理，请补归类）`)
  return 'durable'
}

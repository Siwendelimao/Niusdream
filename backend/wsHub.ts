/**
 * 1035 阶段 A/B · WS 连接管理器（wsHub）
 *
 * ⚠️ **不被 server.ts import**（阶段 A 只做骨架，不接线）。
 *    阶段 B 接线时只需在 server.ts 的 http.createServer 上挂 upgrade → hub.addConnection(socket)。
 *
 * 职责（严格照方案 §3.2/§3.6/§3.12/§3.16 实现，一条不多一条不少）：
 *   1. hello 状态机（5s 内必须 hello，否则 close 4001）
 *   2. caps 强制（enforce，不猜默认；summary 连接按能力裁剪帧）
 *   3. 订阅表（sid 集合 + 跨会话通道 sid:''）
 *   4. opId 幂等（每条连接一个 OpIdRegistry）
 *   5. 背压三档（软上限丢可丢帧 + 必发 lagged；硬上限 close 1008）
 *   6. 心跳（15s ping，连续 3 次无 pong → terminate）
 *   7. 帧路由（谁能收到哪条帧 —— 唯一入口，便于审）
 *
 * 纪律：禁止兜底。所有"拿不到"都在这里返回 error 帧或直接 close，绝不补默认值。
 */

import {
  PROTOCOL_V,
  WS_SOFT_CAP_BYTES,
  WS_HARD_CAP_BYTES,
  OP_ID_WINDOW,
  decodeClientFrame,
  makeErrorFrame,
  makeAckFrame,
  frameLane,
  OpIdRegistry,
  type AckFrame,
  type Caps,
  type DownKind,
  type ErrorCode,
  type ErrorFrame,
  type FrameDetail,
  type OpFrame,
  type StreamName,
} from './wsProtocol.ts'
import type { OpName } from './wsProtocol.ts'

/* ══════════════ 最小 socket 契约 ══════════════
   真实 `ws` 的 WebSocket 结构上满足它；测试用假 socket 也能满足 —— 所以本模块可离线单测。 */
export interface WsLike {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate?(): void
  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'pong', cb: () => void): void
  on(event: 'error', cb: (e: unknown) => void): void
}

/** ws 的 readyState 常量（不引库，避免把 ws 拖进纯逻辑层） */
const WS_OPEN = 1

export interface DownFrame {
  v: number
  stream: StreamName
  sid: string
  kind: DownKind
  seq?: number
  rev?: number
  logEpoch?: string
  payload: Record<string, unknown>
}

/**
 * 线上可发的帧 = 业务帧（带 stream/sid 信封）| ack | error。
 * ack/error 是**连接级**语义（不属于某条流），所以不带 stream/sid —— 它们在 wsProtocol 里已自带 v/kind。
 */
export type WireFrame = DownFrame | AckFrame | ErrorFrame

export interface HubOptions {
  pingIntervalMs?: number
  helloTimeoutMs?: number
  softCapBytes?: number
  hardCapBytes?: number
  maxMissedPongs?: number
  opIdWindow?: number
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void
  /**
   * 服务端身份/水位来源。**必须由接线方提供**（hub 自己不知道 logEpoch，也不该编一个）。
   * 不提供 ⇒ hello-ack 里**省略**这些字段（省略是诚实的；填 ''/0 就是撒谎）。
   */
  serverInfo?: {
    logEpoch: string
    /** 某会话事件日志水位（= nextSeq - 1）。给了 subscribe 回执才会带 lastSeq */
    watermark?: (sid: string) => number
  }
}

interface Ctx {
  pingIntervalMs: number
  helloTimeoutMs: number
  softCapBytes: number
  hardCapBytes: number
  maxMissedPongs: number
  opIdWindow: number
  log: NonNullable<HubOptions['log']>
  serverInfo?: HubOptions['serverInfo']
}

const defaultLog: NonNullable<HubOptions['log']> = (level, msg, extra) => {
  const line = `[wsHub] ${msg}`
  if (level === 'error') console.error(line, extra ?? '')
  else if (level === 'warn') console.warn(line, extra ?? '')
  else console.log(line, extra ?? '')
}

/* ══════════════ 连接 ══════════════ */

let connSeq = 0

export class HubConnection {
  readonly id: string
  readonly socket: WsLike
  /** hello 之后才有 caps —— 之前是 null（**不许**预先塞一个默认 caps） */
  caps: Caps | null = null
  readonly subscribedSids = new Set<string>()
  /** sid:'' 的订阅（跨会话通道，方案 §3.16） */
  crosstalk = false
  readonly ops = new OpIdRegistry(OP_ID_WINDOW)
  droppedFrames = 0
  missedPongs = 0
  closed = false
  /** 每条连接最近一次"lagged 已发"的时间，用于节流 */
  lastLaggedAt = 0
  private readonly ctx: Ctx

  constructor(socket: WsLike, ctx: Ctx) {
    this.id = 'ws-' + ++connSeq
    this.socket = socket
    this.ctx = ctx
    this.ops = new OpIdRegistry(ctx.opIdWindow)
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WS_OPEN
  }

  /** 是否已声明某条流（host 流靠这个判） */
  hasStream(s: StreamName): boolean {
    return !!this.caps && this.caps.streams.includes(s)
  }

  get frameDetail(): FrameDetail | null {
    return this.caps ? this.caps.frameDetail : null
  }

  isSubscribed(sid: string): boolean {
    if (!sid) return this.crosstalk
    return this.subscribedSids.has(sid)
  }

  private writeRaw(text: string): void {
    if (!this.isOpen) return
    try {
      this.socket.send(text)
    } catch (e) {
      this.ctx.log('error', `send 失败（连接 ${this.id}）`, { err: String((e as Error)?.message || e) })
    }
  }

  /** 直接写（不过背压守卫）—— 只给 lagged / ack / error / ping 这类必达或极小帧用 */
  writeBypass(frame: WireFrame): void {
    this.writeRaw(JSON.stringify(frame))
  }
}

/* ══════════════ 帧路由（唯一入口，便于审） ══════════════ */

/** session 流里"必须跨会话送达"的帧类型（方案 §3.16） */
const CROSSTALK_EVENT_TYPES = new Set(['session/hitl-request', 'session/question'])
/** session 流里"订阅了 sid 也要送 + 跨会话通道也要送"的帧类型（方案 §3.16）
 *  ★1035 阶段E：`session/interaction-done` 并入此类 —— 原来它靠"会话桶 + 全局桶"两次 writeMuxTo 实现，
 *  现在由这一条路由规则覆盖（订阅该会话的连接 + 跨会话通道都收到），语义等价、少一套投递。 */
const STATUS_EVENT_TYPES = new Set(['session/status', 'session/interaction-done'])

const payloadTypeOf = (f: DownFrame): string => {
  const t = f.payload?.type
  return typeof t === 'string' ? t : ''
}

/**
 * 这条帧该不该发给这个连接。
 * 规则与方案 §3.16 表逐条对应 —— 改这里等于改协议，必须同步改文档。
 *
 * ⚠️ 路由**只看 payload.type，不看 kind**：
 *    kind 是"顺序语义"（event 要 seq 连续 / frame 可覆盖），
 *    而"谁能收到"是**投递语义**，两者不该耦合。
 *    （实测教训：session/status 这类帧没有真 seq，若按 kind 判就发不进跨会话通道。）
 */
export function shouldDeliver(conn: HubConnection, frame: DownFrame): boolean {
  if (!conn.caps) return false // 没 hello 的连接收不到任何业务帧

  const pType = payloadTypeOf(frame)

  if (frame.stream === 'host') {
    /* host 流：只给声明了 host 的连接（设置/会话增删） */
    return conn.hasStream('host')
  }

  if (CROSSTALK_EVENT_TYPES.has(pType)) {
    /* 审批/询问卡：必须跨会话（历史教训：只投会话桶 ⇒ 后台会话等授权 10 分钟超时） */
    return conn.crosstalk
  }

  if (STATUS_EVENT_TYPES.has(pType)) {
    return conn.isSubscribed(frame.sid) || conn.crosstalk
  }

  /* 会话内容帧（event/frame/snapshot）：严格只给订阅了该 sid 的连接 */
  return conn.isSubscribed(frame.sid)
}

/* ══════════════ 能力裁剪（summary 连接不吃明细） ══════════════ */

/**
 * 按 caps.frameDetail 裁剪内容帧（方案 §3.8）。
 *
 * `summary` = 只给"消息文本 + 工具名/状态 + 轮末统计"，**不发 segments/args/result/details**。
 * 注意：`full` 连接必须原样返回（视觉一致的硬前提 R1）。
 */
export function projectFrameForCaps(frame: DownFrame, detail: FrameDetail): DownFrame {
  if (detail === 'full') return frame
  const pType = payloadTypeOf(frame)
  if (frame.kind !== 'frame' || pType !== 'content') return frame

  const rawBlocks = frame.payload?.blocks
  const blocks = Array.isArray(rawBlocks) ? rawBlocks : []
  const kept: Record<string, unknown>[] = []
  let toolCount = 0
  let lastToolName = ''

  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    const kind = String(blk.kind || '')
    if (kind === 'text' || kind === 'reasoning') {
      /* 正文/思考保留文本（手机要显示），但去掉任何明细字段 */
      const out: Record<string, unknown> = { kind, id: blk.id, rev: blk.rev }
      if (typeof blk.text === 'string') out.text = blk.text
      kept.push(out)
      continue
    }
    if (kind === 'tool' || kind === 'tool-call' || kind === 'tool-result') {
      toolCount++
      const name = String(blk.name || '')
      if (name) lastToolName = name
      kept.push({ kind: 'tool', id: blk.id, rev: blk.rev, name, status: blk.status })
      continue
    }
    if (kind === 'subagent') {
      kept.push({ kind: 'subagent', id: blk.id, rev: blk.rev, runId: blk.runId, status: blk.status })
      continue
    }
    /* 其余块（notice/image/plan…）在 summary 下**丢弃**：不是"降级成 text"，是明确不要 */
    kept.push({ kind, id: blk.id, rev: blk.rev })
  }

  const outPayload: Record<string, unknown> = {
    ...frame.payload,
    blocks: kept,
    summary: { toolCount, lastToolName, totalBlocks: blocks.length },
  }
  /* 明细字段一律删干净（存在即为泄流量） */
  delete outPayload.sparse
  delete outPayload.segments

  return { ...frame, payload: outPayload }
}

/* ══════════════ Hub ══════════════ */

export interface OpHandlerContext {
  conn: HubConnection
  frame: OpFrame
  /** 受理时立刻回（方案 §3.14：ack = 已受理，不是本轮结束） */
  ack: (payload: Record<string, unknown>) => void
  /** 归还"允许重试"的机会（执行失败时调用） */
  abandon: () => void
}

export type OpHandler = (ctx: OpHandlerContext) => void | Promise<void>

/** 订阅事件：conn 订了某个 sid（sid='' 是跨会话通道） */
export type SubscribeHook = (conn: HubConnection, sid: string) => void
/** 连接就绪事件：hello-ack 发出去之后（用来补首屏快照，SSE 版在 handleHostStream 里做） */
export type ReadyHook = (conn: HubConnection) => void

export interface HubStats {
  connections: number
  ready: number
  crosstalk: number
  droppedTotal: number
  perConnection: { id: string; ready: boolean; sids: number; crosstalk: boolean; dropped: number; detail: FrameDetail | null }[]
}

export class WsHub {
  private readonly ctx: Ctx
  private readonly conns = new Set<HubConnection>()
  private readonly handlers = new Map<OpName, OpHandler>()
  private readonly subscribeHooks: SubscribeHook[] = []
  private readonly readyHooks: ReadyHook[] = []
  private readonly helloTimers = new Map<HubConnection, ReturnType<typeof setTimeout>>()
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: HubOptions = {}) {
    this.ctx = {
      pingIntervalMs: opts.pingIntervalMs ?? 15000,
      helloTimeoutMs: opts.helloTimeoutMs ?? 5000,
      softCapBytes: opts.softCapBytes ?? WS_SOFT_CAP_BYTES,
      hardCapBytes: opts.hardCapBytes ?? WS_HARD_CAP_BYTES,
      maxMissedPongs: opts.maxMissedPongs ?? 3,
      opIdWindow: opts.opIdWindow ?? OP_ID_WINDOW,
      log: opts.log ?? defaultLog,
      ...(opts.serverInfo ? { serverInfo: opts.serverInfo } : {}),
    }
  }

  /** 阶段 B 接线时按 op 名注册实现（未注册的 op 一律 internal 错误，不静默忽略） */
  onOp(op: OpName, handler: OpHandler): void {
    this.handlers.set(op, handler)
  }

  /**
   * 订阅钩子：客户端订了某会话时回调。
   * 用途与 SSE 版**完全对应**（server.ts:15834「订阅即补当前轮快照」）——
   * 不补的话，断开/切会话期间那几帧永久丢失，界面就停在旧状态（实测"重连后没显示"）。
   */
  onSubscribe(hook: SubscribeHook): void {
    this.subscribeHooks.push(hook)
  }

  /** 连接就绪钩子（hello-ack 之后）：用于补首屏快照，对应 SSE 的 handleHostStream 首帧 */
  onConnectionReady(hook: ReadyHook): void {
    this.readyHooks.push(hook)
  }

  /** 发给指定连接（钩子里用；带背压与能力裁剪） */
  sendTo(conn: HubConnection, frame: DownFrame): 'sent' | 'dropped' | 'closed' {
    return this.send(conn, frame)
  }

  get connectionCount(): number {
    return this.conns.size
  }

  /* ── 连接生命周期 ── */

  addConnection(socket: WsLike): HubConnection {
    const conn = new HubConnection(socket, this.ctx)
    this.conns.add(conn)

    socket.on('message', (raw: unknown) => this.handleMessage(conn, raw))
    socket.on('pong', () => {
      conn.missedPongs = 0
    })
    socket.on('close', () => this.dispose(conn))
    socket.on('error', (e: unknown) => {
      this.ctx.log('warn', `连接错误 ${conn.id}`, { err: String((e as Error)?.message || e) })
      this.dispose(conn)
    })

    /* hello 超时：不 hello 就不许占资源（方案 §3.2） */
    this.helloTimers.set(
      conn,
      setTimeout(() => {
        if (!conn.caps) {
          this.ctx.log('warn', `hello 超时，关闭连接 ${conn.id}`)
          this.close(conn, 4001, 'hello-timeout')
        }
      }, this.ctx.helloTimeoutMs),
    )
    return conn
  }

  private dispose(conn: HubConnection): void {
    conn.closed = true
    this.conns.delete(conn)
    const t = this.helloTimers.get(conn)
    if (t) {
      clearTimeout(t)
      this.helloTimers.delete(conn)
    }
  }

  close(conn: HubConnection, code: number, reason: string): void {
    if (conn.closed) return
    try {
      conn.socket.close(code, reason)
    } catch {
      /* close 失败只能 terminate —— 这不是"忽略错误"：连接已判定必须死，必须让它死 */
      conn.socket.terminate?.()
    }
    this.dispose(conn)
  }

  /* ── 入站 ── */

  handleMessage(conn: HubConnection, raw: unknown): void {
    /* 任何入站消息都证明"对端活着" ⇒ 重置心跳计数。
       为什么必须这样：浏览器**没有协议层 pong 的 API**，只有 node 的 ws 客户端会回 pong。
       若只认 pong，浏览器连接会在 45s 后被自己踢掉（实测前就该想到的事，这里补上）。
       这不是兜底：心跳问的是"还活着吗"，收到任何字节就是答案。 */
    conn.missedPongs = 0

    const decoded = decodeClientFrame(typeof raw === 'string' ? raw : String(raw))
    if (!decoded.ok) {
      this.sendError(conn, '', decoded.code, decoded.message)
      /* 版本不匹配 = 结构性不兼容，必须断开（方案 §3.2：不留兼容层） */
      if (decoded.code === 'unsupported-version') this.close(conn, 4002, 'unsupported-version')
      return
    }
    const frame = decoded.value

    if (frame.kind === 'hello') {
      if (conn.caps) {
        /* 重复 hello：协议不允许（能力是连接属性，中途变更会让已发的帧口径不一致） */
        this.sendError(conn, '', 'invalid-frame', '已经 hello 过，不允许二次 hello')
        return
      }
      conn.caps = frame.caps
      const t = this.helloTimers.get(conn)
      if (t) {
        clearTimeout(t)
        this.helloTimers.delete(conn)
      }
      conn.writeBypass({
        v: PROTOCOL_V,
        stream: 'session',
        sid: '',
        kind: 'hello-ack',
        /* 只说知道的：接线方没提供 serverInfo 就**省略**这些字段（填 ''/0 等于撒谎）。
           水位不在这里给 —— hello 时客户端还没订阅，逐会话水位随 subscribe 回执下发。 */
        payload: {
          ...(this.ctx.serverInfo ? { logEpoch: this.ctx.serverInfo.logEpoch } : {}),
          serverTime: Date.now(),
          frameDetail: frame.caps.frameDetail,
        },
      })
      this.ctx.log('info', `hello ok ${conn.id}`, { streams: frame.caps.streams, detail: frame.caps.frameDetail })
      /* 就绪钩子（等价 SSE 的"连上先推一次 workspace"） */
      for (const h of this.readyHooks) {
        try {
          h(conn)
        } catch (e) {
          /* 钩子出错只影响它自己那一步，不能让 hello 失败 */
          this.ctx.log('error', `ready 钩子抛错（连接 ${conn.id}）`, { err: String((e as Error)?.message || e) })
        }
      }
      return
    }

    /* 应用层 pong（浏览器唯一能回的心跳应答）：走不到 op 分支 */
    if (frame.kind === 'pong') return

    /* op：必须先 hello（没 caps 就不知道要不要裁剪、也不知道订了哪些流） */
    if (!conn.caps) {
      this.sendError(conn, frame.opId, 'invalid-frame', '必须先 hello 才能发 op')
      return
    }

    const outcome = conn.ops.begin(frame.opId)
    if (outcome.state === 'replay') {
      /* 幂等：直接回放缓存结果，**绝不重复执行** */
      conn.writeBypass(makeAckFrame(frame.opId, outcome.payload))
      return
    }
    if (outcome.state === 'inflight') {
      this.sendError(conn, frame.opId, 'conflict', '同一 opId 正在执行中')
      return
    }
    if (outcome.state === 'expired') {
      this.sendError(conn, frame.opId, 'op-expired', 'opId 已滑出幂等窗口，请重新操作')
      return
    }

    /* 订阅类 op 由 hub 自己处理（不需要业务侧） */
    if (frame.op === 'subscribe' || frame.op === 'unsubscribe') {
      this.applySubscription(conn, frame)
      /* subscribe 回执带上该会话的真实水位：客户端据此立刻判断"我现在有没有缺口"，
         不必等到收第一帧才发现。没有 watermark 提供者 / 跨会话通道（sid=''）就不带。 */
      const wm = this.ctx.serverInfo?.watermark
      const ackPayload: Record<string, unknown> = { ok: true, sid: frame.sid }
      if (frame.op === 'subscribe' && frame.sid && wm) ackPayload.lastSeq = wm(frame.sid)
      /* ★1035：订阅回执必须带 logEpoch —— 前端拿它当"跨重启的 seq 不可比"的判据。
         没有它，后端重启后 seq 从 0 重来会被前端当"乱序"整批丢弃（实测会表现成"回复不显示"）。 */
      if (this.ctx.serverInfo) ackPayload.logEpoch = this.ctx.serverInfo.logEpoch
      conn.ops.finish(frame.opId, ackPayload)
      conn.writeBypass(makeAckFrame(frame.opId, ackPayload))
      return
    }

    const handler = this.handlers.get(frame.op)
    if (!handler) {
      /* 阶段 A 的必然状态：骨架期没注册 handler。**报 internal，不静默成功** */
      conn.ops.abandon(frame.opId)
      this.sendError(conn, frame.opId, 'internal', `op 未接线: ${frame.op}`)
      return
    }

    const ctx: OpHandlerContext = {
      conn,
      frame,
      ack: (payload) => {
        conn.ops.finish(frame.opId, payload)
        conn.writeBypass(makeAckFrame(frame.opId, payload))
      },
      abandon: () => conn.ops.abandon(frame.opId),
    }
    try {
      const r = handler(ctx)
      if (r && typeof (r as Promise<void>).then === 'function') {
        void (r as Promise<void>).catch((e: unknown) => {
          conn.ops.abandon(frame.opId)
          this.sendError(conn, frame.opId, 'internal', String((e as Error)?.message || e))
        })
      }
    } catch (e) {
      conn.ops.abandon(frame.opId)
      this.sendError(conn, frame.opId, 'internal', String((e as Error)?.message || e))
    }
  }

  private applySubscription(conn: HubConnection, frame: OpFrame): void {
    if (frame.op === 'subscribe') {
      if (frame.sid === '') conn.crosstalk = true
      else conn.subscribedSids.add(frame.sid)
      /* 订阅钩子：等价 SSE 的「订阅即补当前轮快照」—— 必须在登记之后回调，
         这样钩子里补发的那一帧一定能发到这条连接（shouldDeliver 已能看到新 sid）。 */
      for (const h of this.subscribeHooks) {
        try {
          h(conn, frame.sid)
        } catch (e) {
          this.ctx.log('error', `subscribe 钩子抛错（sid=${frame.sid ? frame.sid.slice(0, 8) : "''"}）`, {
            err: String((e as Error)?.message || e),
          })
        }
      }
      return
    }
    if (frame.sid === '') conn.crosstalk = false
    else conn.subscribedSids.delete(frame.sid)
  }

  /* ── 出站 ── */

  sendError(conn: HubConnection, opId: string, code: ErrorCode, message: string): void {
    conn.writeBypass(makeErrorFrame(opId, code, message))
    this.ctx.log('warn', `error→${conn.id}`, { code, message, opId })
  }

  /**
   * 发给单个连接（ack/error 用），并施加背压。
   * 返回 'sent' | 'dropped' | 'closed'
   */
  send(conn: HubConnection, frame: DownFrame): 'sent' | 'dropped' | 'closed' {
    if (!conn.isOpen) return 'closed'

    /* 硬上限：断开（**不静默丢 event**，让客户端重连补账） */
    if (conn.socket.bufferedAmount >= this.ctx.hardCapBytes) {
      this.ctx.log('warn', `写缓冲超硬上限，断开 ${conn.id}`, { buffered: conn.socket.bufferedAmount })
      this.close(conn, 1008, 'backpressure')
      return 'closed'
    }

    const lane = frameLane(frame.stream, frame.kind, payloadTypeOf(frame))
    if (lane === 'droppable' && conn.socket.bufferedAmount >= this.ctx.softCapBytes) {
      conn.droppedFrames++
      this.notifyLagged(conn, frame)
      return 'dropped'
    }

    const projected = projectFrameForCaps(frame, conn.frameDetail ?? 'full')
    conn.writeBypass(projected)
    return 'sent'
  }

  /** 丢帧必须可见（方案 §3.6）：回一条 lagged，客户端据此 resync */
  private notifyLagged(conn: HubConnection, frame: DownFrame): void {
    const now = Date.now()
    /* 节流：同连接 500 帧或 30s 内最多一条（与现有 SSE 版同口径） */
    if (conn.droppedFrames % 500 !== 1 && now - conn.lastLaggedAt < 30000) return
    conn.lastLaggedAt = now
    conn.writeBypass({
      v: PROTOCOL_V,
      stream: 'session',
      sid: frame.sid,
      kind: 'event',
      payload: { type: 'session/lagged', sessionId: frame.sid, skipped: conn.droppedFrames },
    })
  }

  /** 广播：按 shouldDeliver 逐个连接发（内部已做能力裁剪与背压） */
  broadcast(frame: DownFrame): { sent: number; dropped: number; closed: number } {
    let sent = 0
    let dropped = 0
    let closed = 0
    for (const conn of this.conns) {
      if (!shouldDeliver(conn, frame)) continue
      const r = this.send(conn, frame)
      if (r === 'sent') sent++
      else if (r === 'dropped') dropped++
      else closed++
    }
    return { sent, dropped, closed }
  }

  /* ── 心跳 ── */

  /**
   * 心跳 tick（单测直接调它；生产由 startHeartbeat 定时调用）。
   * 返回本轮被 terminate 的连接数。
   */
  tick(now: number = Date.now()): number {
    let killed = 0
    for (const conn of this.conns) {
      if (conn.missedPongs >= this.ctx.maxMissedPongs) {
        this.ctx.log('warn', `心跳超时，terminate ${conn.id}`, { missed: conn.missedPongs })
        try {
          conn.socket.terminate?.()
        } catch {
          /* 已在关闭路径上；terminate 抛错无补救动作，只留痕 */
          this.ctx.log('error', `terminate 抛错 ${conn.id}`)
        }
        this.dispose(conn)
        killed++
        continue
      }
      conn.missedPongs++
      this.send(conn, { v: PROTOCOL_V, stream: 'session', sid: '', kind: 'ping', payload: { t: now } })
    }
    return killed
  }

  startHeartbeat(): void {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => this.tick(), this.ctx.pingIntervalMs)
  }

  stopHeartbeat(): void {
    if (!this.pingTimer) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  stats(): HubStats {
    const perConnection: HubStats['perConnection'] = []
    let ready = 0
    let crosstalk = 0
    let droppedTotal = 0
    for (const c of this.conns) {
      if (c.caps) ready++
      if (c.crosstalk) crosstalk++
      droppedTotal += c.droppedFrames
      perConnection.push({
        id: c.id,
        ready: !!c.caps,
        sids: c.subscribedSids.size,
        crosstalk: c.crosstalk,
        dropped: c.droppedFrames,
        detail: c.frameDetail,
      })
    }
    return { connections: this.conns.size, ready, crosstalk, droppedTotal, perConnection }
  }
}

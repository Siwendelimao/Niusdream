/**
 * 1035 阶段 A/B · wsHub 单测（假 socket，不起服务、不占端口、不碰后端）
 *
 * 跑法： cd backend && node --import tsx/esm --test wsHub.test.ts
 *
 * 覆盖：hello 状态机 / caps 强制 / 订阅路由 / 跨会话通道 / 能力裁剪 / 背压三档 / opId 幂等 / 心跳 / 只读统计
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WsHub, projectFrameForCaps, shouldDeliver, type DownFrame, type WsLike } from './wsHub.ts'

/* ══════════════ 假 socket ══════════════ */

class FakeSocket implements WsLike {
  readyState = 1
  bufferedAmount = 0
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null
  terminated = false
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = { message: [], close: [], pong: [], error: [] }

  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3
  }
  terminate(): void {
    this.terminated = true
    this.readyState = 3
  }

  on(event: 'message', cb: (data: unknown) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'pong', cb: () => void): void
  on(event: 'error', cb: (e: unknown) => void): void
  on(event: string, cb: (...args: unknown[]) => void): void {
    ;(this.handlers[event] ||= []).push(cb)
  }

  /** 测试驱动：模拟收到消息 */
  emitMessage(data: unknown): void {
    for (const cb of this.handlers.message) cb(data)
  }
  emitPong(): void {
    for (const cb of this.handlers.pong) cb()
  }

  get frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
  framesOfKind(kind: string): Record<string, unknown>[] {
    return this.frames.filter((f) => f.kind === kind)
  }
}

const silent = () => {}
const hubOpts = { log: silent as never }

const hello = (caps: Record<string, unknown>) => JSON.stringify({ v: 1, kind: 'hello', caps })
const op = (opName: string, opId: string, sid?: string, payload?: Record<string, unknown>) =>
  JSON.stringify({ v: 1, kind: 'op', opId, op: opName, sid, payload })

const FULL_CONN = hello({ streams: ['session', 'host'], frameDetail: 'full' })
const SESSION_ONLY = hello({ streams: ['session'], frameDetail: 'full' })

function connected(hub: WsHub, caps = FULL_CONN): { sock: FakeSocket; conn: ReturnType<WsHub['addConnection']> } {
  const sock = new FakeSocket()
  const conn = hub.addConnection(sock)
  hub.handleMessage(conn, caps)
  return { sock, conn }
}

const contentFrame = (sid: string, extra: Record<string, unknown> = {}): DownFrame => ({
  v: 1,
  stream: 'session',
  sid,
  kind: 'frame',
  rev: 1,
  payload: { type: 'content', turnId: 't1', turnRev: 1, full: true, blocks: [{ kind: 'text', id: 'b1', rev: 1, text: 'hi' }], ...extra },
})

/* ══════════════ 1. hello 状态机 ══════════════ */

test('hello 超时（没 hello）→ close 4001', async () => {
  const hub = new WsHub({ ...hubOpts, helloTimeoutMs: 10 })
  const sock = new FakeSocket()
  hub.addConnection(sock)
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(sock.closedWith, { code: 4001, reason: 'hello-timeout' })
  assert.equal(hub.connectionCount, 0)
})

test('hello 成功 → hello-ack，且带 frameDetail', () => {
  const hub = new WsHub(hubOpts)
  const { sock } = connected(hub, hello({ streams: ['session'], frameDetail: 'summary' }))
  const ack = sock.framesOfKind('hello-ack')
  assert.equal(ack.length, 1)
  assert.equal((ack[0].payload as Record<string, unknown>).frameDetail, 'summary')
})

test('二次 hello → error（能力是连接属性，中途变更会让已发帧口径不一致）', () => {
  const hub = new WsHub(hubOpts)
  const { sock, conn } = connected(hub)
  hub.handleMessage(conn, FULL_CONN)
  const err = sock.framesOfKind('error')
  assert.equal(err.length, 1)
  assert.match(String(err[0].message), /二次 hello/)
})

test('没 hello 就发 op → error（不猜 caps）', () => {
  const hub = new WsHub(hubOpts)
  const sock = new FakeSocket()
  const conn = hub.addConnection(sock)
  hub.handleMessage(conn, op('stop', 'o1', 's1'))
  const err = sock.framesOfKind('error')
  assert.equal(err.length, 1)
  assert.equal(err[0].code, 'invalid-frame')
})

test('caps 缺失 → invalid-caps（不默认 full）', () => {
  const hub = new WsHub(hubOpts)
  const sock = new FakeSocket()
  const conn = hub.addConnection(sock)
  hub.handleMessage(conn, JSON.stringify({ v: 1, kind: 'hello' }))
  const err = sock.framesOfKind('error')
  assert.equal(err[0].code, 'invalid-caps')
  assert.equal(conn.caps, null)
})

/* ══════════════ 2. 订阅与路由 ══════════════ */

test('subscribe 后 ack；未订阅的会话帧收不到', () => {
  const hub = new WsHub(hubOpts)
  const a = connected(hub)
  const b = connected(hub)
  hub.handleMessage(a.conn, op('subscribe', 'sub-a', 's1'))
  hub.handleMessage(b.conn, op('subscribe', 'sub-b', 's2'))

  const before = b.sock.sent.length
  const r = hub.broadcast(contentFrame('s1'))
  assert.equal(r.sent, 1) // 只有 a
  assert.equal(b.sock.sent.length, before)
  assert.equal(a.sock.framesOfKind('ack').length, 1)
})

test('session/status 同时送给 sid 订阅者与跨会话通道', () => {
  const hub = new WsHub(hubOpts)
  const sidOwner = connected(hub)
  const crosstalk = connected(hub)
  const outsider = connected(hub)
  hub.handleMessage(sidOwner.conn, op('subscribe', 'x1', 's1'))
  hub.handleMessage(crosstalk.conn, op('subscribe', 'x2', ''))
  hub.handleMessage(outsider.conn, op('subscribe', 'x3', 's9'))

  const statusFrame: DownFrame = {
    v: 1, stream: 'session', sid: 's1', kind: 'event', seq: 1,
    payload: { type: 'session/status', sessionId: 's1', running: false, agentEnd: true },
  }
  const r = hub.broadcast(statusFrame)
  assert.equal(r.sent, 2)
  assert.equal(outsider.sock.framesOfKind('event').length, 0)
})

test('审批/询问卡走跨会话通道：后台会话的卡也能收到（防 10 分钟超时老病）', () => {
  const hub = new WsHub(hubOpts)
  const viewingOther = connected(hub)   // 正在看别的会话
  const noCrosstalk = connected(hub)
  hub.handleMessage(viewingOther.conn, op('subscribe', 'v1', 's-other'))
  hub.handleMessage(viewingOther.conn, op('subscribe', 'v2', ''))
  hub.handleMessage(noCrosstalk.conn, op('subscribe', 'n1', 's-other'))

  const hitl: DownFrame = {
    v: 1, stream: 'session', sid: 's-bg', kind: 'event', seq: 7,
    payload: { type: 'session/hitl-request', sessionId: 's-bg', requestId: 'r1' },
  }
  const r = hub.broadcast(hitl)
  assert.equal(r.sent, 1)
  assert.equal(viewingOther.sock.framesOfKind('event').length, 1)
  assert.equal(noCrosstalk.sock.framesOfKind('event').length, 0)
})

test('host 流只给声明了 host 的连接', () => {
  const hub = new WsHub(hubOpts)
  const full = connected(hub, FULL_CONN)
  const sessionOnly = connected(hub, SESSION_ONLY)
  const hostFrame: DownFrame = { v: 1, stream: 'host', sid: '', kind: 'frame', rev: 1, payload: { type: 'host/workspace-changed' } }
  const r = hub.broadcast(hostFrame)
  assert.equal(r.sent, 1)
  assert.equal(full.sock.framesOfKind('frame').length, 1)
  assert.equal(sessionOnly.sock.framesOfKind('frame').length, 0)
})

test('unsubscribe 之后不再收到', () => {
  const hub = new WsHub(hubOpts)
  const c = connected(hub)
  hub.handleMessage(c.conn, op('subscribe', 'u1', 's1'))
  hub.handleMessage(c.conn, op('unsubscribe', 'u2', 's1'))
  hub.broadcast(contentFrame('s1'))
  assert.equal(c.sock.framesOfKind('frame').length, 0)
})

test('shouldDeliver：没 hello 的连接收不到任何业务帧', () => {
  const hub = new WsHub(hubOpts)
  const sock = new FakeSocket()
  const conn = hub.addConnection(sock)
  assert.equal(shouldDeliver(conn, contentFrame('s1')), false)
})

/* ══════════════ 3. 能力裁剪（summary） ══════════════ */

test('summary 连接：工具块不带 args/segments，只留 name/status + 轮末统计', () => {
  const frame: DownFrame = {
    v: 1, stream: 'session', sid: 's1', kind: 'frame', rev: 9,
    payload: {
      type: 'content', turnId: 't1', turnRev: 3, full: true,
      blocks: [
        { kind: 'text', id: 'b1', rev: 1, text: '正文' },
        { kind: 'tool', id: 'b2', rev: 2, name: 'fs_read', status: 'done', args: { path: 'x'.repeat(500) }, segments: [{ a: 1 }] },
        { kind: 'subagent', id: 'b3', rev: 3, runId: 'run1', status: 'running', segments: [{ b: 2 }] },
      ],
    },
  }
  const out = projectFrameForCaps(frame, 'summary')
  const blocks = out.payload.blocks as Record<string, unknown>[]
  assert.equal(blocks.length, 3)
  const tool = blocks[1]
  assert.equal(tool.args, undefined)
  assert.equal(tool.segments, undefined)
  assert.equal(tool.name, 'fs_read')
  const sa = blocks[2]
  assert.equal(sa.segments, undefined)
  assert.equal(sa.runId, 'run1')
  const summary = out.payload.summary as Record<string, unknown>
  assert.equal(summary.toolCount, 1)
  assert.equal(summary.lastToolName, 'fs_read')
  // 原始帧不被改动
  assert.ok((frame.payload.blocks as Record<string, unknown>[])[1].args)
})

test('full 连接：帧原样下发（视觉一致的硬前提 R1）', () => {
  const hub = new WsHub(hubOpts)
  const c = connected(hub, FULL_CONN)
  hub.handleMessage(c.conn, op('subscribe', 'f1', 's1'))
  const frame = contentFrame('s1', { sparse: [{ i: 0, rev: 2, block: { kind: 'text', id: 'b1', rev: 2, text: 'yo' } }] })
  hub.broadcast(frame)
  const got = c.sock.framesOfKind('frame')[0]
  assert.deepEqual(got.payload, frame.payload)
  assert.equal(got.stream, 'session')
  assert.equal(got.sid, 's1')
  assert.equal(got.rev, 1)
})

/* ══════════════ 4. 背压三档 ══════════════ */

test('软上限：可丢帧被丢，但必须发 lagged（丢帧必须可见）', () => {
  const hub = new WsHub({ ...hubOpts, softCapBytes: 100, hardCapBytes: 1000 })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('subscribe', 'p1', 's1'))
  c.sock.bufferedAmount = 500 // 超软上限，未到硬上限
  const evt: DownFrame = { v: 1, stream: 'session', sid: 's1', kind: 'event', seq: 2, payload: { type: 'session/event' } }
  const r = hub.broadcast(evt)
  assert.equal(r.dropped, 1)
  /* 业务帧没发出去（lagged 本身也是 kind:'event'，所以要按 payload.type 区分） */
  const business = c.sock.frames.filter((f) => f.kind === 'event' && (f.payload as Record<string, unknown>)?.type === 'session/event')
  assert.equal(business.length, 0)
  const lagged = c.sock.frames.filter((f) => (f.payload as Record<string, unknown>)?.type === 'session/lagged')
  assert.equal(lagged.length, 1)
  assert.equal((lagged[0].payload as Record<string, unknown>).skipped, 1)
})

test('软上限：不可丢帧（snapshot/ack/error）照发', () => {
  const hub = new WsHub({ ...hubOpts, softCapBytes: 100, hardCapBytes: 1000 })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('subscribe', 'p2', 's1'))
  c.sock.bufferedAmount = 500
  const snap: DownFrame = { v: 1, stream: 'session', sid: 's1', kind: 'snapshot', payload: { type: 'history' } }
  hub.broadcast(snap)
  assert.equal(c.sock.framesOfKind('snapshot').length, 1)
})

test('硬上限：直接 close 1008（event 不静默丢）', () => {
  const hub = new WsHub({ ...hubOpts, softCapBytes: 100, hardCapBytes: 1000 })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('subscribe', 'p3', 's1'))
  c.sock.bufferedAmount = 5000
  const r = hub.broadcast(contentFrame('s1'))
  assert.equal(r.closed, 1)
  assert.deepEqual(c.sock.closedWith, { code: 1008, reason: 'backpressure' })
  assert.equal(hub.connectionCount, 0)
})

/* ══════════════ 5. opId 幂等 ══════════════ */

test('同 opId 重发 → handler 只执行一次，第二次是回放', () => {
  const hub = new WsHub(hubOpts)
  let calls = 0
  hub.onOp('stop', (c) => {
    calls++
    c.ack({ stopped: true })
  })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('stop', 'same', 's1'))
  hub.handleMessage(c.conn, op('stop', 'same', 's1'))
  assert.equal(calls, 1)
  assert.equal(c.sock.framesOfKind('ack').length, 2)
})

test('handler 不 ack（仍 inflight）→ 同 opId 再来报 conflict，不重复执行', () => {
  const hub = new WsHub(hubOpts)
  let calls = 0
  hub.onOp('approve', () => {
    calls++ // 故意不 ack
  })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('approve', 'af1', 's1', { requestId: 'r' }))
  hub.handleMessage(c.conn, op('approve', 'af1', 's1', { requestId: 'r' }))
  assert.equal(calls, 1)
  const err = c.sock.framesOfKind('error')
  assert.equal(err.length, 1)
  assert.equal(err[0].code, 'conflict')
})

test('handler 抛错 → error internal，且允许重试同一 opId', () => {
  const hub = new WsHub(hubOpts)
  let calls = 0
  hub.onOp('stop', () => {
    calls++
    throw new Error('boom')
  })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('stop', 'boom1', 's1'))
  hub.handleMessage(c.conn, op('stop', 'boom1', 's1'))
  assert.equal(calls, 2)
  const err = c.sock.framesOfKind('error')
  assert.equal(err.length, 2)
  assert.match(String(err[0].message), /boom/)
})

test('未注册的 op → internal（骨架期不静默成功）', () => {
  const hub = new WsHub(hubOpts)
  const c = connected(hub)
  hub.handleMessage(c.conn, op('prompt', 'np1', 's1', { message: 'hi' }))
  const err = c.sock.framesOfKind('error')
  assert.equal(err[0].code, 'internal')
  assert.match(String(err[0].message), /未接线/)
})

test('opId 滑出窗口 → op-expired（不是重跑）', () => {
  const hub = new WsHub({ ...hubOpts, opIdWindow: 1 })
  let calls = 0
  hub.onOp('stop', (c) => {
    calls++
    c.ack({ ok: true })
  })
  const c = connected(hub)
  hub.handleMessage(c.conn, op('stop', 'a', 's1'))
  hub.handleMessage(c.conn, op('stop', 'b', 's1')) // 挤掉 a
  hub.handleMessage(c.conn, op('stop', 'a', 's1'))
  assert.equal(calls, 2)
  const err = c.sock.framesOfKind('error')
  assert.equal(err.length, 1)
  assert.equal(err[0].code, 'op-expired')
})

/* ══════════════ 6. 心跳 ══════════════ */

test('心跳：连续无 pong 达阈值 → terminate', () => {
  const hub = new WsHub({ ...hubOpts, maxMissedPongs: 2 })
  const c = connected(hub)
  assert.equal(hub.tick(1), 0) // missed 1
  assert.equal(hub.tick(2), 0) // missed 2
  assert.equal(hub.tick(3), 1) // 2 >= 2 → 杀
  assert.equal(c.sock.terminated, true)
  assert.equal(hub.connectionCount, 0)
})

test('收到 pong 后计数归零，不会被误杀', () => {
  const hub = new WsHub({ ...hubOpts, maxMissedPongs: 2 })
  const c = connected(hub)
  hub.tick(1)
  hub.tick(2)
  c.sock.emitPong()
  assert.equal(hub.tick(3), 0)
  assert.equal(hub.tick(4), 0)
  assert.equal(c.sock.terminated, false)
})

test('心跳发送 ping 帧', () => {
  const hub = new WsHub(hubOpts)
  const c = connected(hub)
  hub.tick(123)
  const ping = c.sock.framesOfKind('ping')
  assert.equal(ping.length, 1)
  assert.equal((ping[0].payload as Record<string, unknown>).t, 123)
})

/* ══════════════ 7. 只读统计（可观测性） ══════════════ */

test('stats 反映连接/订阅/丢弃/裁剪档位', () => {
  const hub = new WsHub({ ...hubOpts, softCapBytes: 10, hardCapBytes: 1000 })
  const a = connected(hub, FULL_CONN)
  const b = connected(hub, hello({ streams: ['session'], frameDetail: 'summary' }))
  hub.handleMessage(a.conn, op('subscribe', 's-a', 's1'))
  hub.handleMessage(b.conn, op('subscribe', 's-b', ''))

  a.sock.bufferedAmount = 50
  hub.broadcast(contentFrame('s1'))
  a.sock.bufferedAmount = 0

  const st = hub.stats()
  assert.equal(st.connections, 2)
  assert.equal(st.ready, 2)
  assert.equal(st.crosstalk, 1)
  assert.equal(st.droppedTotal, 1)
  const pa = st.perConnection.find((x) => x.id === a.conn.id)
  const pb = st.perConnection.find((x) => x.id === b.conn.id)
  assert.equal(pa?.sids, 1)
  assert.equal(pb?.detail, 'summary')
})

/* ══════════════ 8. 连接断开清理 ══════════════ */

test('socket 触发 close → hub 移除连接（不漏内存）', () => {
  const hub = new WsHub(hubOpts)
  const c = connected(hub)
  assert.equal(hub.connectionCount, 1)
  // 模拟底层 ws 的 close 事件
  const handlers = (c.sock as unknown as { handlers: Record<string, Array<() => void>> }).handlers
  for (const cb of handlers.close) cb()
  assert.equal(hub.connectionCount, 0)
})

/* ═══════════ 9. 心跳 × 浏览器（拿不到协议层 pong） ═══════════ */

test('浏览器回应用层 pong 就能续命，不会被误杀', () => {
  const hub = new WsHub({ ...hubOpts, maxMissedPongs: 2 })
  const c = connected(hub)
  hub.tick(1)
  hub.tick(2) // missed 已达 2
  hub.handleMessage(c.conn, JSON.stringify({ v: 1, kind: 'pong' }))
  assert.equal(hub.tick(3), 0, '回过 pong 就不该被杀')
  assert.equal(c.sock.terminated, false)
})

test('任何入站消息都算"还活着"（不只 pong）', () => {
  const hub = new WsHub({ ...hubOpts, maxMissedPongs: 1 })
  const c = connected(hub)
  hub.tick(1) // missed = 1（阈值 1）
  hub.handleMessage(c.conn, JSON.stringify({ v: 1, kind: 'op', opId: 'x', op: 'stop', sid: 's1' }))
  assert.equal(hub.tick(2), 0)
  assert.equal(c.sock.terminated, false)
})

test('hello 之前收到 pong 不算错（心跳应答不属于业务 op）', () => {
  const hub = new WsHub(hubOpts)
  const sock = new FakeSocket()
  const conn = hub.addConnection(sock)
  hub.handleMessage(conn, JSON.stringify({ v: 1, kind: 'pong' }))
  assert.equal(sock.framesOfKind('error').length, 0)
})

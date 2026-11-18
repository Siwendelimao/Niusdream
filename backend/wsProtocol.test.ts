/**
 * 1035 阶段 A · wsProtocol 单测（node:test，与 responsesProtocol.test.ts 同口径）
 *
 * 跑法： cd backend && node --import tsx/esm --test wsProtocol.test.ts
 *
 * 覆盖原则：**每一条"缺数据"都必须有对应断言**（禁兜底的验收方式）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROTOCOL_V,
  OP_ID_WINDOW,
  OP_SID_POLICY,
  OPS,
  decodeClientFrame,
  validateCaps,
  checkVersion,
  makeErrorFrame,
  makeAckFrame,
  frameLane,
  OpIdRegistry,
} from './wsProtocol.ts'

/* ═══════════ 1. 版本 ═══════════ */

test('v 必须是数字且等于 1；缺失不接受默认', () => {
  const missing = checkVersion({ kind: 'hello' })
  assert.equal(missing.ok, false)
  assert.equal((missing as any).code, 'invalid-frame')
  assert.match((missing as any).message, /缺 v/)

  const wrong = checkVersion({ v: 2 })
  assert.equal(wrong.ok, false)
  assert.equal((wrong as any).code, 'unsupported-version')

  assert.equal(checkVersion({ v: PROTOCOL_V }).ok, true)
})

/* ═══════════ 2. caps ═══════════ */

test('caps 缺失 → invalid-caps（不许默认 full）', () => {
  const r = validateCaps(undefined)
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'invalid-caps')
})

test('caps.streams 空数组 / 未知流 → invalid-caps', () => {
  const empty = validateCaps({ streams: [], frameDetail: 'full' })
  assert.equal(empty.ok, false)
  assert.equal((empty as any).code, 'invalid-caps')

  const unknown = validateCaps({ streams: ['session', 'nope'], frameDetail: 'full' })
  assert.equal(unknown.ok, false)
  assert.match((unknown as any).message, /未知流/)
})

test('caps.frameDetail 缺失/未知 → invalid-caps（不降级成 full）', () => {
  assert.equal(validateCaps({ streams: ['session'] }).ok, false)
  const bad = validateCaps({ streams: ['session'], frameDetail: 'FULL' })
  assert.equal(bad.ok, false)
  assert.equal((bad as any).code, 'invalid-caps')
})

test('caps.maxFrameBytes 非法值 → invalid-caps；不填则字段不存在（不是 0）', () => {
  for (const bad of [0, -1, Number.NaN, '1024', null]) {
    const r = validateCaps({ streams: ['session'], frameDetail: 'full', maxFrameBytes: bad })
    assert.equal(r.ok, false, `maxFrameBytes=${String(bad)} 应被拒`)
  }
  const ok = validateCaps({ streams: ['session'], frameDetail: 'summary' })
  assert.equal(ok.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call((ok as any).value, 'maxFrameBytes'), false)
})

test('caps.streams 去重保序', () => {
  const r = validateCaps({ streams: ['host', 'session', 'host'], frameDetail: 'full' })
  assert.equal(r.ok, true)
  assert.deepEqual((r as any).value.streams, ['host', 'session'])
})

/* ═══════════ 3. hello / op 信封 ═══════════ */

test('hello 帧可解析', () => {
  const r = decodeClientFrame(JSON.stringify({ v: 1, kind: 'hello', caps: { streams: ['session', 'host'], frameDetail: 'full' } }))
  assert.equal(r.ok, true)
  assert.equal((r as any).value.kind, 'hello')
  assert.deepEqual((r as any).value.caps.streams, ['session', 'host'])
})

test('非法 JSON → invalid-frame（不是崩）', () => {
  const r = decodeClientFrame('{oops')
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'invalid-frame')
})

test('未知 kind → invalid-frame（上行只允许 hello / op）', () => {
  const r = decodeClientFrame({ v: 1, kind: 'subscribe' })
  assert.equal(r.ok, false)
  assert.match((r as any).message, /未知 kind/)
})

test('op 缺 opId → invalid-frame', () => {
  const r = decodeClientFrame({ v: 1, kind: 'op', op: 'stop', sid: 's1' })
  assert.equal(r.ok, false)
  assert.match((r as any).message, /opId/)
})

test('未知 op → invalid-frame，并列出允许值', () => {
  const r = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'session.rename', sid: 's1' })
  assert.equal(r.ok, false)
  assert.match((r as any).message, new RegExp(OPS.join('\\|')))
})

test('prompt 缺 sid → invalid-frame（业务 op 不许无归属）', () => {
  const r = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'prompt', payload: { message: 'hi' } })
  assert.equal(r.ok, false)
  assert.match((r as any).message, /non-empty|非空/) // message 文案中文：必须带非空 sid
})

test('subscribe 允许空 sid（跨会话通道），但字段必须出现', () => {
  const emptyOk = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'subscribe', sid: '' })
  assert.equal(emptyOk.ok, true)
  assert.equal((emptyOk as any).value.sid, '')

  const missing = decodeClientFrame({ v: 1, kind: 'op', opId: 'b', op: 'subscribe' })
  assert.equal(missing.ok, false)
  assert.match((missing as any).message, /必须带 sid 字段/)
})

test('prompt 必须带 payload 对象', () => {
  const r = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'prompt', sid: 's1' })
  assert.equal(r.ok, false)
  assert.match((r as any).message, /payload/)

  const ok = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'prompt', sid: 's1', payload: { message: 'hi' } })
  assert.equal(ok.ok, true)
})

test('stop 不需要 payload，带了也保留', () => {
  const a = decodeClientFrame({ v: 1, kind: 'op', opId: 'a', op: 'stop', sid: 's1' })
  assert.equal(a.ok, true)
  assert.equal((a as any).value.payload, undefined)

  const b = decodeClientFrame({ v: 1, kind: 'op', opId: 'b', op: 'stop', sid: 's1', payload: { reason: 'user' } })
  assert.equal(b.ok, true)
  assert.deepEqual((b as any).value.payload, { reason: 'user' })
})

test('每个 op 的 sid 策略都有定义（新增 op 忘配策略会挂）', () => {
  for (const op of OPS) assert.ok(OP_SID_POLICY[op], `op=${op} 缺 sid 策略`)
})

/* ═══════════ 4. 下行帧构造 ═══════════ */

test('error / ack 帧带协议版本，ack 只有 accepted:true 一种形态', () => {
  const err = makeErrorFrame('op-1', 'not-subscribed', '未订阅')
  assert.deepEqual(err, { v: 1, kind: 'error', opId: 'op-1', code: 'not-subscribed', message: '未订阅' })

  const ack = makeAckFrame('op-1', { messageId: 'cmid-1' })
  assert.equal(ack.v, 1)
  assert.equal(ack.accepted, true)
  assert.equal(ack.payload.messageId, 'cmid-1')
})

/* ═══════════ 5. opId 幂等 ═══════════ */

test('同 opId 第二次 begin → replay（绝不重复执行）', () => {
  const reg = new OpIdRegistry()
  assert.equal(reg.begin('a').state, 'new')
  reg.finish('a', { messageId: 'm1' })

  const again = reg.begin('a')
  assert.equal(again.state, 'replay')
  assert.deepEqual((again as any).payload, { messageId: 'm1' })
})

test('inflight 期间重复来的 opId → inflight（不执行也不谎报结果）', () => {
  const reg = new OpIdRegistry()
  assert.equal(reg.begin('a').state, 'new')
  assert.equal(reg.begin('a').state, 'inflight')
})

test('abandon 后同一 opId 可重试（失败不算已执行）', () => {
  const reg = new OpIdRegistry()
  assert.equal(reg.begin('a').state, 'new')
  reg.abandon('a')
  assert.equal(reg.begin('a').state, 'new')
})

test('finish 重复记账 → 抛错（暴露上层 bug，不静默覆盖）', () => {
  const reg = new OpIdRegistry()
  reg.begin('a')
  reg.finish('a', {})
  assert.throws(() => reg.finish('a', {}), /重复记账/)
})

test('窗口满后最旧的已完成后 → expired（不是 new，否则会重复执行）', () => {
  const reg = new OpIdRegistry(3)
  for (const id of ['a', 'b', 'c']) {
    reg.begin(id)
    reg.finish(id, { id })
  }
  // 再进一条，挤掉最旧的 'a'
  reg.begin('d')
  reg.finish('d', { id: 'd' })
  assert.equal(reg.size, 3)
  assert.equal(reg.begin('a').state, 'expired')
  assert.equal(reg.begin('d').state, 'replay')
})

test('从没见过的 opId → new（与 expired 区分开）', () => {
  const reg = new OpIdRegistry(2)
  assert.equal(reg.begin('never-seen').state, 'new')
})

test('inflight 不会被淘汰（避免同一个 opId 变回 new 导致重复执行）', () => {
  const reg = new OpIdRegistry(2)
  reg.begin('inflight-1')
  reg.begin('done-1')
  reg.finish('done-1', {})
  reg.begin('done-2')
  reg.finish('done-2', {})
  // 窗口 2：应淘汰 done-1，而 inflight-1 必须留着
  assert.equal(reg.begin('inflight-1').state, 'inflight')
  assert.equal(reg.begin('done-2').state, 'replay')
})

test('默认窗口大小 = OP_ID_WINDOW', () => {
  const reg = new OpIdRegistry()
  for (let i = 0; i < OP_ID_WINDOW + 5; i++) {
    reg.begin('op-' + i)
    reg.finish('op-' + i, {})
  }
  assert.equal(reg.size, OP_ID_WINDOW)
})

/* ═══════════ 6. 背压分道 ═══════════ */

test('可丢 / 不可丢的归类', () => {
  assert.equal(frameLane('session', 'event'), 'droppable')
  assert.equal(frameLane('session', 'frame'), 'droppable')
  assert.equal(frameLane('session', 'snapshot'), 'durable')
  assert.equal(frameLane('session', 'ack'), 'durable')
  assert.equal(frameLane('session', 'error'), 'durable')
  assert.equal(frameLane('host', 'hello-ack'), 'durable')
  assert.equal(frameLane('session', 'ping'), 'droppable')
})

/* ═══════════ 7. 应用层 pong（浏览器唯一能回的心跳应答） ═══════════ */

test('pong 帧可解析（浏览器拿不到协议层 pong API）', () => {
  const r = decodeClientFrame({ v: 1, kind: 'pong' })
  assert.equal(r.ok, true)
  assert.equal((r as { ok: true; value: { kind: string } }).value.kind, 'pong')
})

test('pong 缺 v 仍被拒（版本是硬要求），且提示里列出允许的 kind', () => {
  const r = decodeClientFrame({ kind: 'pong' })
  assert.equal(r.ok, false)
  assert.equal((r as { ok: false; code: string }).code, 'invalid-frame')
  const bad = decodeClientFrame({ v: 1, kind: 'pongx' })
  assert.match((bad as { ok: false; message: string }).message, /hello \/ op \/ pong/)
})

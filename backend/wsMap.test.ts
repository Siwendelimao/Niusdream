/**
 * 1035 B-2 · wsMap 单测（"哪类帧算事实"这件事的唯一裁决处）
 * 跑法： cd backend && node --import tsx/esm --test wsMap.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapToWsFrame, type MuxFrameLike } from './wsMap.ts'

function map(frame: MuxFrameLike, stream: 'session' | 'host' = 'session') {
  const violations: string[] = []
  const out = mapToWsFrame({
    sessionId: 'sess-A',
    frame,
    stream,
    logEpoch: 'ep1',
    protocolV: 1,
    onViolation: (m) => violations.push(m),
  })
  return { out, violations }
}

/* ═══════════ 1. 事实帧（入日志、有 seq） ═══════════ */

test('session/event 带 seq → kind=event，seq 保留', () => {
  const { out, violations } = map({ type: 'session/event', seq: 42, value: { k: 1 } })
  assert.equal(out.kind, 'event')
  assert.equal(out.seq, 42)
  assert.equal(out.sid, 'sess-A')
  assert.equal(out.logEpoch, 'ep1')
  assert.equal(violations.length, 0)
})

/* ═══════════ 2. 流式中间态（不入日志、无 seq）—— 不是违约 ═══════════ */

test('session/event + expectFinal:false → kind=frame，且**不许**报违约', () => {
  const { out, violations } = map({ type: 'session/event', expectFinal: false, value: { delta: 'x' } })
  assert.equal(out.kind, 'frame')
  assert.equal(out.seq, undefined)
  assert.equal(violations.length, 0, '流式中间态没 seq 是设计，不该当违约报错')
})

/* ═══════════ 3. 真违约：该有 seq 却没有 ═══════════ */

test('expectFinal:true 但没 seq → 降级 frame + 报违约（绝不编 seq）', () => {
  const { out, violations } = map({ type: 'session/event', expectFinal: true })
  assert.equal(out.kind, 'frame')
  assert.equal(out.seq, undefined)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /事实帧缺 seq/)
})

test('expectFinal 未声明（undefined）也算"该有 seq" → 报违约（与后端注释的兼容口径一致）', () => {
  const { out, violations } = map({ type: 'session/event' })
  assert.equal(out.kind, 'frame')
  assert.equal(violations.length, 1)
})

test('seq 不是有限数字（NaN / 字符串 / null）→ 视为没有 seq', () => {
  for (const bad of [Number.NaN, '42', null, Infinity]) {
    const { out, violations } = map({ type: 'session/event', seq: bad, expectFinal: true })
    assert.equal(out.kind, 'frame', `seq=${String(bad)} 不该被当成有效 seq`)
    assert.equal(violations.length, 1)
  }
})

/* ═══════════ 4. 非事实类型一律镜像帧 ═══════════ */

test('session/status、session/projection、session/agent-event → frame，且不报违约', () => {
  for (const t of ['session/status', 'session/projection', 'session/agent-event', 'session/log', 'proc/updated']) {
    const { out, violations } = map({ type: t, seq: Date.now() })
    assert.equal(out.kind, 'frame', `${t} 应是镜像帧`)
    assert.equal(violations.length, 0)
    assert.equal(out.seq, undefined, `${t} 不许把 Date.now() 当顺序水位带出去`)
  }
})

/* ═══════════ 5. sid / stream / payload ═══════════ */

test('sid 取帧内 sessionId（优先于入参）', () => {
  const { out } = map({ type: 'session/status', sessionId: 'from-frame' })
  assert.equal(out.sid, 'from-frame')
})

test('帧内没有 sessionId 时用入参 sid', () => {
  const { out } = map({ type: 'session/status' })
  assert.equal(out.sid, 'sess-A')
})

test('host 流 sid 恒为空串（host 不是会话）', () => {
  const { out } = map({ type: 'host/workspace-changed', sessionId: 'whatever' }, 'host')
  assert.equal(out.stream, 'host')
  assert.equal(out.sid, '')
})

test('payload 原样保留老帧字段，并把 type 显式带上', () => {
  const { out } = map({ type: 'session/projection', key: 'unread', value: { unread: 3 } })
  assert.equal(out.payload.type, 'session/projection')
  assert.equal(out.payload.key, 'unread')
  assert.deepEqual(out.payload.value, { unread: 3 })
})

test('type 缺失 → "unknown"，不当成事实帧', () => {
  const { out, violations } = map({})
  assert.equal(out.payload.type, 'unknown')
  assert.equal(out.kind, 'frame')
  assert.equal(violations.length, 0)
})

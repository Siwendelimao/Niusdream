/**
 * 1035 阶段0 · wsProbe 单测
 * 跑法： node --import tsx/esm --test wsProbe.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noteFrame, readProbe, resetProbe, setSampleEvery } from './wsProbe.ts'

const agentFrame = (partial: unknown, delta?: string) => ({
  type: 'session/agent-event',
  event: { assistantMessageEvent: { type: 'message_update', partial, delta } },
})

test('按类型累计条数/总和/峰值', () => {
  resetProbe()
  noteFrame('session/log', 100)
  noteFrame('session/log', 300)
  const { frames } = readProbe()
  assert.equal(frames['session/log'].n, 2)
  assert.equal(frames['session/log'].avg, 200)
  assert.equal(frames['session/log'].max, 300)
})

test('reset 清零', () => {
  resetProbe()
  noteFrame('session/log', 100)
  resetProbe()
  assert.deepEqual(readProbe().frames, {})
  assert.equal(readProbe().agentBreak.sampled, 0)
})

test('agent-event 采样后能拆出 partial / message / delta 的占比', () => {
  resetProbe()
  setSampleEvery(1) // 测试里不采样，逐帧算
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(500) }] }
  noteFrame('session/agent-event', 800, agentFrame(partial, 'abc'))

  const b = readProbe().agentBreak
  assert.equal(b.sampled, 1)
  assert.ok(b.partialBytes > 500, 'partial 应被算进去')
  assert.equal(b.deltaBytes, JSON.stringify('abc').length)
  assert.ok(b.maxPartialBytes >= b.partialBytes)
  assert.equal(b.errors, 0)
})

test('message 字段也计入（老协议 event.message 全量快照）', () => {
  resetProbe()
  setSampleEvery(1)
  const frame = {
    type: 'session/agent-event',
    event: { message: { role: 'assistant', content: 'y'.repeat(400) }, assistantMessageEvent: { type: 'message_update' } },
  }
  noteFrame('session/agent-event', 600, frame)
  const b = readProbe().agentBreak
  assert.ok(b.messageBytes > 400)
  assert.equal(b.partialBytes, 0)
})

test('非 agent-event 帧不参与拆解（不浪费 CPU）', () => {
  resetProbe()
  setSampleEvery(1)
  noteFrame('session/projection', 500, { type: 'session/projection' })
  assert.equal(readProbe().agentBreak.sampled, 0)
})

test('拆解异常只计数、不抛（不能因为诊断把业务搞崩）', () => {
  resetProbe()
  setSampleEvery(1)
  const bad = {
    type: 'session/agent-event',
    get event(): unknown {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => noteFrame('session/agent-event', 100, bad))
  assert.equal(readProbe().agentBreak.errors, 1)
})

test('setSampleEvery 非法值直接报错（不静默用默认）', () => {
  assert.throws(() => setSampleEvery(0), /非法/)
  assert.throws(() => setSampleEvery(1.5), /非法/)
  setSampleEvery(10)
})

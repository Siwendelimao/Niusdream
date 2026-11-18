/**
 * 1035 C′ · agentEventSlim 单测
 * 跑法： node --import tsx/esm --test agentEventSlim.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slimAgentEvent } from './agentEventSlim.ts'

const updateEvent = (opts: { withMessage?: boolean; withAe?: boolean; withPartial?: boolean } = {}) => {
  const ev: Record<string, unknown> = { type: 'message_update' }
  if (opts.withMessage !== false) ev.message = { role: 'assistant', content: [{ type: 'text', text: 'BIG'.repeat(500) }] }
  if (opts.withAe !== false) {
    const ae: Record<string, unknown> = { type: 'toolcall_delta', contentIndex: 0, delta: 'ab' }
    if (opts.withPartial !== false) {
      ae.partial = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'BIG'.repeat(500) },
          { type: 'thinking', thinking: 'HUGE'.repeat(300) },
          { type: 'toolCall', id: 'call_1', name: 'fs_read', arguments: '{"p":1}' },
        ],
      }
    }
    ev.assistantMessageEvent = ae
  }
  return ev
}

const len = (v: unknown) => JSON.stringify(v).length

/* ═══════════ 1. 主用例：message_update 瘦身 ═══════════ */

test('message_update：删掉 event.message，partial.content 只留 toolCall', () => {
  const ev = updateEvent()
  const before = len(ev)
  const out = slimAgentEvent(ev)
  assert.equal(out.changed, true)
  assert.equal(out.violations.length, 0)

  const slim = out.event as Record<string, unknown>
  assert.equal(slim.message, undefined, 'event.message 必须被删（前端 message_update 分支不读它）')

  const ae = slim.assistantMessageEvent as Record<string, unknown>
  const content = (ae.partial as { content: unknown[] }).content
  assert.equal(content.length, 1)
  assert.equal((content[0] as Record<string, unknown>).type, 'toolCall')
  assert.equal((content[0] as Record<string, unknown>).id, 'call_1')

  /* 体积必须大幅下降 —— 这是这次优化的唯一目的 */
  const after = len(slim)
  assert.ok(after < before * 0.2, `瘦身后应小于原来 20%：before=${before} after=${after}`)
})

test('partial 里的正文/思考块一律不保留（前端只用 toolCall）', () => {
  const out = slimAgentEvent(updateEvent())
  const ae = (out.event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>
  const types = ((ae.partial as { content: { type: string }[] }).content || []).map((c) => c.type)
  assert.deepEqual(types, ['toolCall'])
})

test('不修改入参（pi 交进来的原对象可能还有别的监听方）', () => {
  const ev = updateEvent()
  const originalMsg = ev.message
  const originalContentLen = ((ev.assistantMessageEvent as Record<string, unknown>).partial as { content: unknown[] }).content.length

  slimAgentEvent(ev)

  assert.equal(ev.message, originalMsg, 'event.message 不该被删掉（只删副本里的）')
  const afterLen = ((ev.assistantMessageEvent as Record<string, unknown>).partial as { content: unknown[] }).content.length
  assert.equal(afterLen, originalContentLen, 'partial.content 不该被就地裁剪')
})

/* ═══════════ 2. 其余事件类型一律不动 ═══════════ */

test('message_start / message_end / tool_execution_* / agent_end 原样返回', () => {
  for (const t of ['message_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'message_added']) {
    const ev = { type: t, message: { role: 'assistant', content: [] }, seq: 1 }
    const out = slimAgentEvent(ev)
    assert.equal(out.changed, false, `${t} 不该被改`)
    assert.equal(out.event, ev, `${t} 必须原对象返回`)
  }
})

test('非对象 / 缺 type 原样返回', () => {
  assert.equal(slimAgentEvent(null).changed, false)
  assert.equal(slimAgentEvent('str').changed, false)
  assert.equal(slimAgentEvent({}).changed, false)
})

/* ═══════════ 3. 证明不了就一个字段都不删 ═══════════ */

test('缺 assistantMessageEvent → 保留 message，并报违约', () => {
  const ev = updateEvent({ withAe: false })
  const out = slimAgentEvent(ev, { onViolation: () => {} })
  assert.equal(out.changed, false)
  assert.equal((out.event as Record<string, unknown>).message !== undefined, true, '唯一数据源不许删')
  assert.equal(out.violations.length, 1)
  assert.match(out.violations[0], /缺 assistantMessageEvent/)
})

test('有 ae 但没 partial.content → 保留 message，并报违约', () => {
  const ev = updateEvent({ withPartial: false })
  const out = slimAgentEvent(ev, { onViolation: () => {} })
  assert.equal(out.changed, false)
  assert.equal((out.event as Record<string, unknown>).message !== undefined, true)
  assert.match(out.violations[0], /partial\.content/)
})

test('partial.content 为空数组 → 正常瘦身（保留 message 才是错：前端拿得到空 toolCall 就够）', () => {
  const ev = updateEvent()
  ;((ev.assistantMessageEvent as Record<string, unknown>).partial as { content: unknown[] }).content = []
  const out = slimAgentEvent(ev)
  assert.equal(out.changed, true)
  assert.equal((out.event as Record<string, unknown>).message, undefined)
})

test('partial.content 里没有 toolCall（纯正文流）→ 也瘦身，content 变空数组', () => {
  const ev = updateEvent()
  ;((ev.assistantMessageEvent as Record<string, unknown>).partial as { content: unknown[] }).content = [
    { type: 'text', text: 'x'.repeat(2000) },
  ]
  const out = slimAgentEvent(ev)
  assert.equal(out.changed, true)
  const ae = (out.event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>
  assert.deepEqual((ae.partial as { content: unknown[] }).content, [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, AssistantMessageEventStream } from './agentCompat.ts'
import { buildCloneTools, cancelClones, isCloneRunActive, type CloneContext, type CloneRun } from './cloneRuntime.ts'

function stream(content: any[], options: { signal?: AbortSignal; wait?: Promise<void>; error?: string } = {}) {
  const out = new AssistantMessageEventStream()
  void (async () => {
    if (options.wait) await Promise.race([options.wait, new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))])
    const aborted = options.signal?.aborted
    const m: any = { role: 'assistant', content: aborted || options.error ? [] : content, api: 'openai-completions', provider: 'test', model: 'fixture',
      usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(), stopReason: aborted ? 'aborted' : options.error ? 'error' : content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', errorMessage: options.error }
    out.push({ type: 'start', partial: m })
    if (aborted || options.error) out.push({ type: 'error', reason: m.stopReason, error: m })
    else out.push({ type: 'done', reason: m.stopReason, message: m })
    out.end()
  })()
  return out
}
function context(options: { wait?: Promise<void>; fail?: number; noOutput?: boolean } = {}) {
  const runs = new Map<string, CloneRun>()
  const requests: any[] = []
  let count = 0
  const ctx: CloneContext = {
    sessionId: `test-${Math.random()}`, name: 'Nis', presetId: 'test', model: 'fixture', workDir: 'C:/clone-test', tools: [],
    log() {}, publish(_callId, batch) { for (const r of batch) runs.set(r.runId, structuredClone(r)) },
    createStream(_system, signal) { const n = ++count; return (_m: unknown, c: any) => {
      requests.push(c)
      if (n <= (options.fail || 0)) return stream([], { error: 'fixture failure' })
      if (options.noOutput) return stream([], { signal })
      return stream([{ type: 'toolCall', id: `report-${n}`, name: 'bb_write', arguments: { result: `证据完成 ${n}`, finish: true } }], { signal, wait: options.wait })
    } },
  }
  return { ctx, runs, requests }
}
const tasks = { tasks: [{ task: '读取 A，给证据' }, { task: '读取 B，给证据' }] }

test('real parent Agent waits for clones and continues without a second user turn or notification', async () => {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const f = context({ wait })
  const tool = buildCloneTools(f.ctx)[0]
  let parentRequests = 0, starts = 0, ends = 0
  const parent = new Agent({ initialState: { tools: [tool] }, streamFn: () => {
    parentRequests++
    return parentRequests === 1 ? stream([{ type: 'toolCall', id: 'batch-1', name: 'spawn_clone', arguments: tasks }]) : stream([{ type: 'text', text: '同轮汇总' }])
  } })
  parent.subscribe(e => { if (e.type === 'agent_start') starts++; if (e.type === 'agent_end') ends++ })
  const pending = parent.prompt('请并行读两个文件')
  await delay(30)
  assert.equal(starts, 1); assert.equal(ends, 0); assert.equal(parentRequests, 1)
  assert.equal(f.runs.size, 2)
  for (const r of f.runs.values()) { assert.equal(r.status, 'running'); assert.equal(isCloneRunActive(r.runId), true) }
  release(); await pending
  assert.equal(ends, 1); assert.equal(starts, 1); assert.equal(parentRequests, 2)
  assert.equal(parent.state.messages.filter(m => m.role === 'user').length, 1)
  assert.equal([...f.runs.values()].every(r => r.status === 'done'), true)
  assert.equal([...f.runs.values()].every(r => !isCloneRunActive(r.runId)), true)
  assert.equal(parent.state.messages.filter(m => m.role === 'assistant').at(-1)?.content?.[0]?.type, 'text')
  assert.equal(f.runs.size, 2, 'success must not trigger false retry')
  for (const r of f.runs.values()) { assert.equal(r.usage.input, 10); assert.equal(r.usage.totalTokens, 15); assert.ok(r.segments.every(s => s.id)) }
})

test('two tool calls have disjoint run identities, including after slot reuse', async () => {
  const f = context(), tool = buildCloneTools(f.ctx)[0]
  await tool.execute('call-A', tasks)
  const idsA = [...f.runs.keys()]
  await tool.execute('call-B', tasks)
  assert.equal(f.runs.size, 4)
  assert.ok(idsA.every(id => f.runs.get(id)?.callId === 'call-A'))
  assert.equal([...f.runs.values()].filter(r => r.callId === 'call-B').length, 2)
  assert.equal(new Set([...f.runs.values()].map(r => r.memberId)).size, 2)
})

test('cancelClones cancels only the selected parent; no member state API is involved', async () => {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const a = context({ wait }), b = context({ wait })
  const pa = buildCloneTools(a.ctx)[0].execute('cancel-A', tasks)
  const pb = buildCloneTools(b.ctx)[0].execute('keep-B', tasks)
  await delay(20)
  cancelClones(a.ctx.sessionId); await pa
  assert.ok([...a.runs.values()].every(r => r.status === 'interrupted'))
  assert.equal(a.runs.size, 2, 'user stop must not retry')
  assert.ok([...b.runs.values()].every(r => r.status === 'running'))
  release(); await pb
  assert.ok([...b.runs.values()].every(r => r.status === 'done'))
})

test('parent AbortSignal stops children and releases slots for next call', async () => {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const f = context({ wait }), ac = new AbortController(), tool = buildCloneTools(f.ctx)[0]
  const p = tool.execute('signal-A', tasks, ac.signal)
  await delay(10); ac.abort(); await p
  release(); await tool.execute('signal-B', tasks)
  assert.equal([...f.runs.values()].filter(r => r.callId === 'signal-B' && r.status === 'done').length, 2)
})

test('one failure is returned to parent without automatic retry', async () => {
  const f = context({ fail: 1 })
  const r = await buildCloneTools(f.ctx)[0].execute('failure-1', tasks)
  assert.equal(f.runs.size, 2)
  assert.equal(r.details.completed, 1)
  assert.equal([...f.runs.values()].filter(r => r.status === 'error').length, 1)
})

test('two failures retry once with explicit attempt and same batch ownership', async () => {
  const f = context({ fail: 2 })
  const r = await buildCloneTools(f.ctx)[0].execute('failure-2', tasks)
  assert.equal(f.runs.size, 4); assert.equal(r.details.completed, 2)
  assert.equal([...f.runs.values()].filter(r => r.attempt === 2).length, 2)
  assert.ok([...f.runs.values()].every(r => r.callId === 'failure-2'))
})

test('empty output is not successful and retry is bounded', async () => {
  const f = context({ noOutput: true })
  const r = await buildCloneTools(f.ctx)[0].execute('no-output', tasks)
  assert.equal(f.runs.size, 4); assert.equal(r.details.completed, 0)
})

test('readonly boundary removes write tools and narrows family actions in schema and execution', async () => {
  const f = context()
  let inspected = false
  f.ctx.tools = [
    { name: 'fs_write', parameters: {}, execute: async () => { throw new Error('must not run') } } as any,
    { name: 'memory', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }, execute: async () => ({ content: [] }) } as any,
  ]
  f.ctx.createStream = (_s, signal) => (_m, c) => {
    inspected = true
    assert.equal(c.tools.some(t => t.name === 'fs_write'), false)
    const mem = c.tools.find(t => t.name === 'memory')
    assert.deepEqual(mem.parameters.properties.action.anyOf.map(x => x.const), ['search'])
    return stream([{ type: 'toolCall', id: 'done', name: 'bb_write', arguments: { result: '已核验只读权限', finish: true } }], { signal })
  }
  await buildCloneTools(f.ctx)[0].execute('readonly', tasks)
  assert.equal(inspected, true)
})

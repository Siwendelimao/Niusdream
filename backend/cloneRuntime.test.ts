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
function context(options: { wait?: Promise<void>; fail?: number; noOutput?: boolean; plan?: (turn: number, actor: string) => { content?: any[]; error?: string; wait?: Promise<void> } | undefined } = {}) {
  const runs = new Map<string, CloneRun>()
  const requests: any[] = []
  let count = 0
  const turns = new Map<string, number>()
  const ctx: CloneContext = {
    sessionId: `test-${Math.random()}`, name: 'Nis', presetId: 'test', model: 'fixture', workDir: 'C:/clone-test', tools: [],
    log() {}, publish(_callId, batch) { for (const r of batch) runs.set(r.runId, structuredClone(r)) },
    /* plan 给单个分身按"它自己的第几轮"编排内容（默认一次交卷）——用来测 >30 轮、局部失败等。 */
    createStream(_system, signal, actor) { const n = ++count; return (_m: unknown, c: any) => {
      requests.push(c)
      const turn = (turns.get(actor) || 0) + 1; turns.set(actor, turn)
      const planned = options.plan?.(turn, actor)
      if (planned) return stream(planned.content || [], { signal, error: planned.error, wait: planned.wait || options.wait })
      if (n <= (options.fail || 0)) return stream([], { error: 'fixture failure' })
      if (options.noOutput) return stream([], { signal })
      return stream([{ type: 'toolCall', id: `report-${n}`, name: 'bb_write', arguments: { result: `证据完成 ${n}`, finish: true } }], { signal, wait: options.wait })
    } },
  }
  return { ctx, runs, requests }
}
const tasks = { tasks: [{ task: '读取 A，给证据' }, { task: '读取 B，给证据' }] }
const three = { tasks: [{ task: '读取 A，给证据' }, { task: '读取 B，给证据' }, { task: '读取 C，给证据' }] }

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

test('two of three failures: exactly three runs, real statuses, no automatic redispatch', async () => {
  let n = 0
  const f = context({ plan: () => (++n <= 2 ? { error: 'fixture failure' } : undefined) })
  const r = await buildCloneTools(f.ctx)[0].execute('failure-2', three)
  assert.equal(f.runs.size, 3, '首次调用只产生 3 个 run，失败的不重派')
  assert.equal(r.details.completed, 1)
  assert.equal([...f.runs.values()].filter(x => x.status === 'error').length, 2)
  assert.equal([...f.runs.values()].filter(x => x.attempt === 2).length, 0)
  assert.ok([...f.runs.values()].every(x => x.callId === 'failure-2'))
  const text = String((r as any).content[0].text)
  assert.equal((text.match(/error/g) || []).length, 2, '两条失败如实写进返回文本')
})

test('parent redispatches only the failed ones with a new explicit call (callId/runId differ)', async () => {
  let n = 0
  const f = context({ plan: () => (++n <= 2 ? { error: 'fixture failure' } : undefined) })
  const tool = buildCloneTools(f.ctx)[0]
  const first = await tool.execute('call-1', three)
  const failedTasks = three.tasks.filter((_t, i) => i < 2).map(t => ({ task: t.task })).slice(0, 2)
  const r = await tool.execute('call-2', { tasks: failedTasks })
  assert.equal(f.runs.size, 5, '首次 3 个 + 重派 2 个')
  assert.equal(r.details.spawned, 2)
  const second = [...f.runs.values()].filter(x => x.callId === 'call-2')
  assert.equal(second.length, 2)
  assert.equal(new Set([...f.runs.values()].map(x => x.runId)).size, 5, 'runId 全不同')
  assert.ok([...f.runs.values()].every(x => x.attempt === 1))
  assert.equal(first.details.spawned, 3)
})

test('single-task call is legal (1~MAX), two-task batch still unchanged', async () => {
  const f = context()
  const tool = buildCloneTools(f.ctx)[0]
  const one = await tool.execute('single', { tasks: [{ task: '只读一个文件' }] })
  assert.equal(one.details.spawned, 1); assert.equal(one.details.completed, 1)
  await assert.rejects(() => tool.execute('empty', { tasks: [] }))
  await assert.rejects(() => tool.execute('blank', { tasks: [{ task: '  ' }] }))
  const two = await tool.execute('pair', tasks)
  assert.equal(two.details.spawned, 2); assert.equal(two.details.completed, 2)
})

test('a clone may take more than 30 model turns in the same attempt and still finish', async () => {
  let reads = 0
  const f = context({ plan: turn => (turn > 35
    ? { content: [{ type: 'toolCall', id: 'finish', name: 'bb_write', arguments: { result: '35 轮后交卷', finish: true } }] }
    : { content: [{ type: 'toolCall', id: `read-${turn}`, name: 'fs_read', arguments: { path: `C:/clone-test/${turn}.md` } }] }) })
  f.ctx.tools = [{ name: 'fs_read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: async () => { reads++; return { content: [{ type: 'text', text: 'ok' }] } } } as any]
  const r = await buildCloneTools(f.ctx)[0].execute('long-run', { tasks: [{ task: '翻 35 个文件后总结' }] })
  const run = [...f.runs.values()][0]
  assert.equal(reads, 35, '35 次工具轮都真的执行了')
  assert.equal(run.status, 'done', '同一 attempt 跑满 35 轮仍能完成')
  assert.equal(run.attempt, 1)
  assert.ok(!/30 次模型调用上限/.test(String(run.error || '')))
  assert.equal(r.details.completed, 1)
})

test('empty output is not successful and is not retried automatically', async () => {
  const f = context({ noOutput: true })
  const r = await buildCloneTools(f.ctx)[0].execute('no-output', tasks)
  assert.equal(f.runs.size, 2); assert.equal(r.details.completed, 0)
})

test('readonly boundary removes write tools and narrows family actions in schema and execution', async () => {
  const f = context()
  let inspected: any = null
  f.ctx.tools = [
    { name: 'fs_write', parameters: {}, execute: async () => { throw new Error('must not run') } } as any,
    { name: 'memory', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }, execute: async () => ({ content: [] }) } as any,
  ]
  /* ⚠️ 工具表走**第 5 个参数 tools()**（cloneRuntime 传 `() => agent.state.tools`），且必须延迟取：
     建 stream 时 agent 还没初始化完（读 agent 会 TDZ 抛错，而抛错会被 Agent 吞掉 ⇒ 假绿）。 */
  f.ctx.createStream = (_s, signal, _actor, _note, toolsOf) => () => {
    inspected = toolsOf()
    return stream([{ type: 'toolCall', id: 'done', name: 'bb_write', arguments: { result: '已核验只读权限', finish: true } }], { signal })
  }
  await buildCloneTools(f.ctx)[0].execute('readonly', tasks)
  assert.ok(inspected, 'createStream 必须真的被调用')
  assert.equal(inspected.some((t: any) => t.name === 'fs_write'), false)
  const mem = inspected.find((t: any) => t.name === 'memory')
  assert.deepEqual(mem.parameters.properties.action.anyOf.map((x: any) => x.const), ['search'])
})

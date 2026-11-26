import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent, AssistantMessageEventStream } from './agentCompat.ts'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { createTeamV2Scheduler, type TeamV2Executor } from './teamV2Scheduler.ts'

const source = '左栏状态不对；用量也不对。'
const first = { messageId: 'user-1', partKey: 'sidebar', title: 'Sidebar', quote: '左栏状态不对', acceptance: 'Reconnect shows correct state' }
const second = { ...first, partKey: 'usage', title: 'Usage', quote: '用量也不对' }
const readUserMessage = (id: string) => id === first.messageId ? source : undefined

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nis-team-scheduler-'))
  const file = join(root, 'team.db')
  let ledger = openTeamV2Ledger(file)
  return {
    get ledger() { return ledger },
    reopen() { ledger.close(); ledger = openTeamV2Ledger(file); return ledger },
    close() { ledger.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('two receipts from one user message; native Agent start opens the sole slot and submit is not acceptance', { timeout: 5000 }, async () => {
  const f = fixture()
  const ledger = f.ledger
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const visited: number[] = []
  let drain: Promise<number> | undefined
  try {
    const scheduler = createTeamV2Scheduler(ledger, { readUserMessage, async execute(job, start) {
      visited.push(job.request.id)
      assert.equal(ledger.runningMembers().length, 0, 'reserving executor is not starting')
      const agent = new Agent({ streamFn: () => {
        const stream = new AssistantMessageEventStream()
        void (async () => {
          if (visited.length === 1) await release.promise
          const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'fixture report' }], api: 'openai-completions' as const,
            provider: 'test', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(), stopReason: 'stop' as const }
          stream.push({ type: 'start', partial: message })
          stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
        })()
        return stream
      } })
      const off = agent.subscribe(event => {
        if (event.type !== 'agent_start') return
        start()
        if (visited.length === 1) started.resolve()
      })
      try {
        await agent.prompt(job.request.quote)
        assert.ok(agent.state.messages.some(m => m.role === 'assistant' && m.stopReason === 'stop'))
        return { kind: 'submitted', artifact: `fixture:${job.attempt.id}` }
      } finally { off() }
    } })
    assert.throws(() => scheduler.receive({ ...first, quote: 'fake original wording' }), /original user message/)
    const a = scheduler.receive(first), b = scheduler.receive(second)
    assert.equal(scheduler.receive(first).id, a.id)
    const a1 = ledger.assign(a.id, a.revision, 'jo')
    ledger.assign(b.id, b.revision, 'lin')
    drain = scheduler.drain()
    await started.promise
    assert.equal(await scheduler.drain(), 0)
    assert.deepEqual(visited, [a.id])
    assert.deepEqual(ledger.list().map(r => r.phase), ['running', 'queued'])
    release.resolve()
    assert.equal(await drain, 2)
    assert.deepEqual(visited, [a.id, b.id])
    assert.equal(ledger.runningMembers().length, 0)
    assert.deepEqual(ledger.list().map(r => r.phase), ['submitted', 'submitted'])
    ledger.verify(a.id, a1.id, `fixture:${a1.id}`, true, 'separate verification')
    assert.deepEqual(ledger.list().map(r => r.phase), ['accepted', 'submitted'])
  } finally { release.resolve(); await drain?.catch(() => {}); f.close() }
})

test('reconcile old running records after known owner exit, without relaunching them', async () => {
  const f = fixture()
  try {
    let ledger = f.ledger
    const a = ledger.receive(first), b = ledger.receive(second)
    const old = ledger.assign(a.id, 1, 'jo'), next = ledger.assign(b.id, 1, 'jo')
    ledger.start(a.id, old.id)
    ledger = f.reopen()
    const called: number[] = []
    const scheduler = createTeamV2Scheduler(ledger, { readUserMessage, async execute(job, start) {
      called.push(job.attempt.id)
      start()
      return { kind: 'failed', evidence: 'The fixture ended with exit 1.' }
    } })
    await assert.rejects(scheduler.drain(), /Reconcile/)
    assert.equal(ledger.recoverAfterOwnerExit(), 1)
    assert.equal(ledger.recoverAfterOwnerExit(), 0)
    assert.equal(await scheduler.drain(), 1)
    assert.deepEqual(called, [next.id])
    assert.deepEqual(ledger.list().map(r => r.phase), ['interrupted', 'failed'])
    assert.match(ledger.attempts(a.id)[0].evidence!, /执行和产物未确认/)
    assert.throws(() => ledger.submit(a.id, old.id, 'late'), /Stale/)
  } finally { f.close() }
})

test('missing start and thrown executor errors do not fabricate completion or replay', async () => {
  const f = fixture()
  try {
    const ledger = f.ledger
    const a = ledger.receive(first), b = ledger.receive(second)
    ledger.assign(a.id, 1, 'jo'); ledger.assign(b.id, 1, 'jo')
    let late!: () => void
    const execute: TeamV2Executor = async (job, start) => {
      if (job.request.id === a.id) { late = start; return { kind: 'submitted', artifact: 'early' } }
      start()
      throw new Error('fixture transport ended without receipt')
    }
    const scheduler = createTeamV2Scheduler(ledger, { readUserMessage, execute })
    await assert.rejects(scheduler.drain(), /without a start/)
    assert.throws(late, /late team start/)
    await assert.rejects(scheduler.drain(), /transport ended/)
    assert.deepEqual(ledger.list().map(r => r.phase), ['interrupted', 'interrupted'])
    assert.equal(await scheduler.drain(), 0)
    assert.deepEqual(ledger.runningMembers(), [])
  } finally { f.close() }
})

test('an explicit refusal before start settles as failed, not interrupted', async () => {
  const f = fixture()
  try {
    const ledger = f.ledger
    const a = ledger.receive(first)
    ledger.assign(a.id, 1, 'jo')
    /* 开工前核验失败（撤权/工作区变了）：没有任何副作用 ⇒ 必须是可重派的 failed，
       不能记成 interrupted（那会触发"未知副作用"人工对账，把队列锁死）。 */
    const execute: TeamV2Executor = async () => ({ kind: 'failed', evidence: '授权已失效：成员已不在团队，拒绝开工' })
    const scheduler = createTeamV2Scheduler(ledger, { readUserMessage, execute })
    assert.equal(await scheduler.drain(), 1)
    const row = ledger.list()[0]
    assert.equal(row.phase, 'failed')
    assert.match(String(row.attempt?.evidence), /拒绝开工/)
    assert.equal(ledger.needsRestartReview(), false, '开工前拒绝不许触发重启对账')
    assert.deepEqual(ledger.runningMembers(), [])
  } finally { f.close() }
})

test('two slots run two different members at once, never the same attempt twice, and a busy member stays queued', { timeout: 8000 }, async () => {
  const f = fixture()
  const ledger = f.ledger
  const startedIds: number[] = []
  const gates = new Map<number, { promise: Promise<void>; resolve: () => void }>()
  try {
    const third = ledger.receive({ ...first, partKey: 'third', title: 'Third', quote: '用量也不对' })
    const a = ledger.receive(first), b = ledger.receive(second)
    ledger.assign(a.id, a.revision, 'jo')
    ledger.assign(b.id, b.revision, 'lin')
    ledger.assign(third.id, third.revision, 'jo')   // 与 a 同成员 ⇒ 必须排队

    const scheduler = createTeamV2Scheduler(ledger, {
      readUserMessage,
      slots: 2,
      async execute(job, start) {
        start()
        startedIds.push(job.request.id)
        let resolve!: () => void
        const promise = new Promise<void>(r => { resolve = r })
        gates.set(job.request.id, { promise, resolve })
        await promise
        return { kind: 'submitted', artifact: `slot:${job.attempt.id}` }
      },
    })

    const drain = scheduler.drain()
    /* 两个不同成员同时开跑 */
    while (startedIds.length < 2) await new Promise(r => setTimeout(r, 10))
    assert.deepEqual([...startedIds].sort(), [a.id, b.id].sort(), '两个槽必须同时跑两个不同成员：' + JSON.stringify(startedIds))

    /* 同成员的第三单不许挤进第三槽（也没有第三槽） */
    await new Promise(r => setTimeout(r, 60))
    assert.equal(startedIds.length, 2, '成员正忙时它的下一单必须留在队列')
    assert.equal(ledger.runningMembers().length, 2, '同时最多 2 个 running')

    /* 释放 a 的槽 → 同成员的第三单接上 */
    gates.get(a.id)!.resolve()
    while (startedIds.length < 3) await new Promise(r => setTimeout(r, 10))
    assert.equal(startedIds[2], third.id, 'a 完事后同成员的第三单要接着跑')

    gates.get(b.id)!.resolve()
    gates.get(third.id)!.resolve()
    assert.equal(await drain, 3)
    assert.deepEqual(ledger.list().map(r => r.phase), ['submitted', 'submitted', 'submitted'])
    assert.equal(ledger.runningMembers().length, 0)
  } finally { for (const g of gates.values()) g.resolve(); f.close() }
})

test('slots are bounded by the team member limit (20), not by 2', () => {
  const f = fixture()
  try {
    /* ★1124（老板拍板）：并行上限 = 团队成员数上限 20；2 槽那个旧上限已撤掉。 */
    assert.throws(() => createTeamV2Scheduler(f.ledger, { readUserMessage, slots: 21, async execute() { return { kind: 'failed', evidence: 'x' } } }), /at most 20/)
    const twenty = createTeamV2Scheduler(f.ledger, { readUserMessage, slots: 20, async execute() { return { kind: 'failed', evidence: 'x' } } })
    assert.ok(twenty, '20 槽必须允许（团队最大成员数）')
  } finally { f.close() }
})

test('a clean side-effect fence runs before settlement and lets the receipt settle', async () => {
  const f = fixture()
  try {
    const ledger = f.ledger
    const a = ledger.receive(first)
    ledger.assign(a.id, 1, 'jo')
    const execute: TeamV2Executor = async (_job, start) => { start(); return { kind: 'submitted', artifact: 'ledger:artifact-fence' } }
    let fences = 0
    const scheduler = createTeamV2Scheduler(ledger, { readUserMessage, execute, drained: async () => { fences++; return { ok: true } } })
    assert.equal(await scheduler.drain(), 1)
    assert.equal(fences, 1, '结算前必须过围栏，且只过一次')
    assert.equal(ledger.list()[0].phase, 'submitted')
  } finally { f.close() }
})

test('a live tool process after the executor returns blocks submit and becomes interrupted', async () => {
  const f = fixture()
  try {
    const ledger = f.ledger
    const a = ledger.receive(first)
    ledger.assign(a.id, 1, 'jo')
    const execute: TeamV2Executor = async (_job, start) => { start(); return { kind: 'submitted', artifact: 'ledger:artifact-fence' } }
    const scheduler = createTeamV2Scheduler(ledger, {
      readUserMessage, execute,
      drained: async () => ({ ok: false, reason: 'node(pid 4242) 仍在运行' }),
    })
    await assert.rejects(scheduler.drain(), /left live tool processes/)
    const row = ledger.list()[0]
    assert.equal(row.phase, 'interrupted')
    assert.equal(row.attempt?.artifact ?? null, null, '围栏不过时绝不许留下 artifact')
    assert.match(String(row.attempt?.evidence), /工具进程未确认退出/)
    /* 围栏是跨次调度的：进程还没确认退出时，下一次 drain 必须继续挡住（不是"这次算了"）。 */
    await assert.rejects(scheduler.drain(), /unconfirmed side effect/)
    assert.equal(ledger.fenceHolds().length, 1, '围栏必须仍然挂着')
  } finally { f.close() }
})

test('a submitted attempt is handed to autoVerify with its own request/attempt/artifact', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    const seen: Array<{ requestId: number; attemptId: number; artifact: string; verify: string | null | undefined }> = []
    const scheduler = createTeamV2Scheduler(f.ledger, {
      readUserMessage,
      slots: 1,
      async autoVerify(input) {
        seen.push({ requestId: input.request.id, attemptId: input.attempt.id, artifact: input.artifact, verify: input.request.verify })
      },
      async execute(job, start) {
        start(process.cwd())
        return { kind: 'submitted' as const, artifact: 'accepted' }
      },
    })
    f.ledger.receiveAndAssign(first.messageId, [{ ...first, memberId: 'm1' }])
    const settled = await scheduler.drain()
    console.log("DEBUG settled=", settled, "seen=", JSON.stringify(seen), "rows=", JSON.stringify(f.ledger.list().map(r=>({id:r.requestId,phase:r.phase,evidence:String(r.attempt?.evidence||"").slice(0,200)}))))
    assert.equal(seen.length, 1, '交付必须触发一次自动验收：' + JSON.stringify(seen))
    assert.equal(seen[0].artifact, 'accepted')
    assert.equal(seen[0].requestId, 1)
    assert.equal(seen[0].attemptId, 1)
    /* 没有判据时 verify 是 null —— 宿主会自己跳过（这张单停待验收等人） */
    assert.equal(seen[0].verify, null)
  } finally { f.close() }
})

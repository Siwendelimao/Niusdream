import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { deriveStageStanding, stageAttemptKey } from './teamV2Stage.ts'

let seq = 0
function task(title: string, memberId: string, messageId = 'user-batch-' + seq) {
  return { messageId, partKey: 'task:' + title, title, quote: '需求：' + title, acceptance: '验收：' + title, memberId }
}

test('stage identity and standing are pure derivations, not a stored second truth', () => {
  const ordered = [{ requestId: 1, revision: 1, attemptId: 4 }, { requestId: 2, revision: 3, attemptId: 9 }]
  assert.equal(stageAttemptKey(ordered), stageAttemptKey([...ordered].reverse()))
  assert.notEqual(stageAttemptKey(ordered), stageAttemptKey([{ requestId: 1, revision: 2, attemptId: 4 }, ordered[1]]))
  assert.throws(() => stageAttemptKey([]), /at least one attempt/)
  assert.throws(() => stageAttemptKey([ordered[0], ordered[0]]), /Duplicate/)
  assert.throws(() => stageAttemptKey([{ requestId: 0, revision: 1, attemptId: 1 }]), /Invalid/)
  assert.equal(deriveStageStanding(['accepted', 'accepted']), 'accepted')
  // 提交不等于验收通过：只要还有待验收，就不是通过
  assert.equal(deriveStageStanding(['submitted', 'submitted']), 'awaiting_review')
  assert.equal(deriveStageStanding(['submitted', 'failed']), 'awaiting_review')
  // 还有排队/运行 ⇒ 这一批没有结束（返工也走这里）
  assert.equal(deriveStageStanding(['submitted', 'queued']), 'executing')
  assert.equal(deriveStageStanding(['accepted', 'running']), 'executing')
  assert.equal(deriveStageStanding(['interrupted']), 'interrupted')
  assert.equal(deriveStageStanding(['rejected', 'failed']), 'rejected')
  assert.equal(deriveStageStanding(['failed']), 'failed')
  assert.throws(() => deriveStageStanding([]), /at least one attempt/)
})

test('two overlapping batches settle independently and each keeps only its own attempts', () => {
  const ledger = openTeamV2Ledger(':memory:')
  const totals = () => ({ ...ledger.stageTotals() })
  try {
    const [a, b] = ledger.receiveAndAssign('user-batch-1', [task('甲', 'm1', 'user-batch-1'), task('乙', 'm2', 'user-batch-1')])
    const [c] = ledger.receiveAndAssign('user-batch-2', [task('丙', 'm1', 'user-batch-2')])
    assert.equal(ledger.settleStages(), 0, '排队中的批次不结算')
    ledger.start(a.request.id, a.attempt.id, '/w'); ledger.submit(a.request.id, a.attempt.id, 'artifact:a')
    ledger.start(c.request.id, c.attempt.id, '/w'); ledger.submit(c.request.id, c.attempt.id, 'artifact:c')
    // 批 1 的乙还没开工：批 2 已全部结束 → 只结算批 2，不等整个会话空闲
    assert.equal(ledger.settleStages(), 1)
    let page = ledger.stageSettlements(0, 10)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].authorizingMessageId, 'user-batch-2')
    assert.deepEqual(page.items[0].items.map(item => item.requestId), [c.request.id])
    assert.equal(page.items[0].standing, 'awaiting_review')
    assert.equal(page.items[0].report.state, 'pending')
    // 乙之后才结束，批 1 这时才结算，条目只含批 1 的两单
    ledger.start(b.request.id, b.attempt.id, '/w')
    ledger.submit(b.request.id, b.attempt.id, 'artifact:b')
    assert.equal(ledger.settleStages(), 1)
    page = ledger.stageSettlements(0, 10)
    assert.deepEqual(page.items.map(item => item.authorizingMessageId), ['user-batch-2', 'user-batch-1'])
    assert.deepEqual(page.items[1].items.map(item => [item.requestId, item.revision, item.attemptId]), [[a.request.id, 1, a.attempt.id], [b.request.id, 1, b.attempt.id]])
    assert.deepEqual(page.items[1].items.map(item => item.phase), ['submitted', 'submitted'])
    assert.deepEqual({ ...page.items[1].report }, { state: 'pending', deliveredMessageId: null, createdAt: page.items[1].report.createdAt })
    assert.deepEqual(totals(), { settlements: 2, pendingReports: 2, deliveredReports: 0 })
  } finally { ledger.close() }
})

test('last item decides: submitted, failed, interrupted and rejected each keep their own standing', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const [ok] = ledger.receiveAndAssign('msg-ok', [task('提交', 'm1', 'msg-ok')])
    const [bad] = ledger.receiveAndAssign('msg-bad', [task('失败', 'm1', 'msg-bad')])
    const [stop] = ledger.receiveAndAssign('msg-stop', [task('中断', 'm1', 'msg-stop')])
    const [no] = ledger.receiveAndAssign('msg-no', [task('驳回', 'm1', 'msg-no')])
    ledger.start(ok.request.id, ok.attempt.id); ledger.submit(ok.request.id, ok.attempt.id, 'artifact:ok')
    ledger.start(bad.request.id, bad.attempt.id); ledger.fail(bad.request.id, bad.attempt.id, '模型报错')
    ledger.interrupt(stop.request.id, stop.attempt.id, 'queued', '上一位后端退出')
    ledger.start(no.request.id, no.attempt.id); ledger.submit(no.request.id, no.attempt.id, 'artifact:no')
    ledger.verify(no.request.id, no.attempt.id, 'artifact:no', false, '证据不足')
    assert.equal(ledger.settleStages(), 4)
    const byId = Object.fromEntries(ledger.stageSettlements(0, 10).items.map(item => [item.authorizingMessageId, item]))
    assert.equal(byId['msg-ok'].standing, 'awaiting_review')
    assert.equal(byId['msg-bad'].standing, 'failed')
    assert.equal(byId['msg-stop'].standing, 'interrupted')
    assert.equal(byId['msg-no'].standing, 'rejected')
    // 中断的恢复核对状态是读出来的，不是结算时写死的
    assert.equal(byId['msg-stop'].items[0].recoveryChecked, false)
    ledger.acknowledgeRecovery(ledger.pendingRecoveryAttempts(), '老板', '已确认外部副作用未发生')
    const again = ledger.stageSettlements(0, 10).items.find(item => item.authorizingMessageId === 'msg-stop')
    assert.equal(again.items[0].recoveryChecked, true)
    /* ★本轮修正：人工核对完这单就从 interrupted 转 failed（可重派）——
       否则它既不能 rework 也不能重派，会永远挂在待核里。阶段状态随之 failed。 */
    assert.equal(again.standing, 'failed')
  } finally { ledger.close() }
})

test('repeat settlement adds no record and no report; rework opens a new stage with new attempts', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const [row] = ledger.receiveAndAssign('msg-rework', [task('返工', 'm1', 'msg-rework')])
    ledger.start(row.request.id, row.attempt.id); ledger.submit(row.request.id, row.attempt.id, 'artifact:old')
    assert.equal(ledger.settleStages(), 1)
    const first = ledger.stageSettlements(0, 10).items[0]
    for (let i = 0; i < 3; i++) assert.equal(ledger.settleStages(), 0)
    assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 1, pendingReports: 1, deliveredReports: 0 })
    // 旧回执只属于旧尝试：驳回后按新验收重新派工，旧阶段条目不被改写
    ledger.verify(row.request.id, row.attempt.id, 'artifact:old', false, '旧回执不通过')
    ledger.reviseAcceptance(row.request.id, 1, '新验收标准', { messageId: 'msg-stage-revise', quote: '追加验收标准' })
    const next = ledger.assign(row.request.id, 2, 'm1')
    ledger.start(row.request.id, next.id); ledger.submit(row.request.id, next.id, 'artifact:new')
    assert.equal(ledger.settleStages(), 1)
    const page = ledger.stageSettlements(0, 10)
    assert.equal(page.items.length, 2)
    assert.deepEqual(page.items[0].items.map(item => [item.attemptId, item.phase]), [[row.attempt.id, 'rejected']])
    assert.deepEqual(page.items[1].items.map(item => [item.revision, item.attemptId, item.phase]), [[2, next.id, 'submitted']])
    assert.equal(page.items[1].standing, 'awaiting_review')
    // 汇报记录一结算一条，不会因为返工再生成第二条属于同一结算的记录
    assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 2, pendingReports: 2, deliveredReports: 0 })
    assert.equal(ledger.stageSettlements(page.items[1].settlementId, 10).items.length, 0)
  } finally { ledger.close() }
})

test('a report record only becomes delivered through a real message id', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const [row] = ledger.receiveAndAssign('msg-deliver', [task('投递', 'm1', 'msg-deliver')])
    ledger.start(row.request.id, row.attempt.id); ledger.submit(row.request.id, row.attempt.id, 'artifact:d')
    ledger.settleStages()
    const id = ledger.stageSettlements(0, 10).items[0].settlementId
    assert.throws(() => ledger.markStageReportDelivered(id, '   '), /Invalid team ledger input/)
    assert.throws(() => ledger.markStageReportDelivered(999, 'msg-real'), /not found/)
    assert.deepEqual({ ...ledger.markStageReportDelivered(id, 'msg-real') }, { settlementId: id, state: 'delivered', deliveredMessageId: 'msg-real', createdAt: ledger.stageSettlements(0, 10).items[0].report.createdAt })
    // 同一结算不能被另一条消息再“已发送”，也不能重复累加
    assert.throws(() => ledger.markStageReportDelivered(id, 'msg-other'), /already delivered/)
    assert.equal(ledger.markStageReportDelivered(id, 'msg-real').deliveredMessageId, 'msg-real')
    assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 1, pendingReports: 0, deliveredReports: 1 })
  } finally { ledger.close() }
})

test('a dispatched batch is identified by its dispatch, never fabricated for legacy work', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    // 旧的收单（无派工批次）永远不结算、不被回填批次
    const legacy = ledger.receive(task('旧工单', 'm1', 'msg-legacy'))
    ledger.assign(legacy.id, 1, 'm1')
    const [queued] = ledger.receiveAndAssign('msg-new', [task('新工单', 'm1', 'msg-new')])
    assert.equal(ledger.settleStages(), 0)
    ledger.start(queued.request.id, queued.attempt.id); ledger.fail(queued.request.id, queued.attempt.id, '失败')
    assert.equal(ledger.settleStages(), 1)
    const page = ledger.stageSettlements(0, 10)
    assert.equal(page.items.length, 1)
    assert.deepEqual(page.items[0].items.map(item => item.requestId), [queued.request.id])
    // 重放同一批（不新建工单）不留下空批次
    assert.deepEqual(ledger.receiveAndAssign('msg-new', [task('新工单', 'm1', 'msg-new')]).map(row => row.created), [false])
    assert.equal(ledger.settleStages(), 0)
    assert.equal(ledger.stageTotals().settlements, 1)
  } finally { ledger.close() }
})

test('a dispatch that fails half way leaves no request and no batch behind', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    assert.throws(() => ledger.receiveAndAssign('msg-atomic', [task('第一项', 'm1', 'msg-atomic'), task('第二项', '', 'msg-atomic')]), /Invalid team ledger input/)
    assert.deepEqual(ledger.list(), [])
    assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 0, pendingReports: 0, deliveredReports: 0 })
    // 回滚后同一批可以正常重派，批次身份仍是这次派工
    assert.deepEqual(ledger.receiveAndAssign('msg-atomic', [task('第一项', 'm1', 'msg-atomic')]).map(row => [row.request.id, row.created]), [[1, true]])
  } finally { ledger.close() }
})

test('an old ledger keeps its history read-only and never invents a batch for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nis-team-stage-old-'))
  const file = join(dir, 'old.sqlite')
  try {
    /* 旧库只有这些表：打开时必须只补新列，不回填、不改写旧行。 */
    const raw = new DatabaseSync(file)
    raw.exec(`CREATE TABLE request (id INTEGER PRIMARY KEY, messageId TEXT NOT NULL, partKey TEXT NOT NULL,
      title TEXT NOT NULL, quote TEXT NOT NULL, acceptance TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(messageId, partKey)) STRICT;`)
    raw.prepare("INSERT INTO request (messageId, partKey, title, quote, acceptance) VALUES ('old-msg','0:5','旧工单','旧原话','旧验收')").run()
    raw.close()
    const ledger = openTeamV2Ledger(file)
    try {
      const page = ledger.page(null, 10)
      assert.deepEqual(page.items.map(item => [item.request.id, item.request.title, item.phase]), [[1, '旧工单', 'received']])
      assert.equal((page.items[0].request as { batchId?: number | null }).batchId, null)
      assert.equal(ledger.settleStages(), 0)
      assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 0, pendingReports: 0, deliveredReports: 0 })
      // 同库新收单（非派工）依旧不算批次
      const fresh = ledger.receive(task('新收单', 'm1', 'new-msg'))
      ledger.assign(fresh.id, 1, 'm1')
      assert.equal(ledger.settleStages(), 0)
      /* ★1124b：分页改最新优先 —— 新收的那张排在第一位（原来升序时它在 [1]）。 */
      assert.equal((ledger.page(null, 10).items[0].request as { batchId?: number | null }).batchId, null)
    } finally { ledger.close() }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 }) }
})

test('only a stopped execution reports its batch; bookkeeping commits report nothing', async () => {
  const events: number[][] = []
  const reported = () => events.filter(list => list.length > 0)
  /* The ledger publishes on a microtask so callers never re-enter an open transaction. */
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const ledger = openTeamV2Ledger(':memory:', stopped => events.push(stopped))
  try {
    const [row] = ledger.receiveAndAssign('msg-events', [task('事件', 'm1', 'msg-events')])
    const batchId = (ledger.page(null, 10).items[0].request as { batchId: number }).batchId
    ledger.receive(task('又一张', 'm1', 'msg-events-2'))
    await settle()
    assert.equal(reported().length, 0, '收单不改结算条件')
    ledger.start(row.request.id, row.attempt.id, process.cwd())
    await settle()
    assert.equal(reported().length, 0, '开工只是让批次离开“已停止”，不结算')
    ledger.submit(row.request.id, row.attempt.id, 'artifact:event')
    await settle()
    assert.deepEqual(reported(), [[batchId]], '提交（停止执行）才报告受影响批次')
    assert.equal(ledger.settleStages([batchId]), 1)
    const settlementId = ledger.stageSettlements(0, 10).items[0].settlementId
    ledger.checkFile(row.request.id, row.attempt.id, 'artifact:event', () => ({ kind: 'file-sha256', relativePath: 'a.txt', expected: 'x', actual: 'x', bytes: 1, outcome: 'matched' }))
    await settle()
    assert.equal(reported().length, 1, '文件核验不触发结算：' + JSON.stringify(events))
    ledger.recordReview({ requestId: row.request.id, attemptId: row.attempt.id, artifact: 'artifact:event' }, null,
      { status: 'opinion', providerId: 'p', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, opinion: { status: 'supported', summary: 's' } })
    await settle()
    assert.equal(reported().length, 1, 'C 记账不触发结算：' + JSON.stringify(events))
    ledger.verify(row.request.id, row.attempt.id, 'artifact:event', true, '人工验收')
    await settle()
    assert.equal(reported().length, 1, 'submitted→accepted 不改变停止状态与尝试集合')
    ledger.markStageReportDelivered(settlementId, 'msg-delivered')
    await settle()
    assert.equal(reported().length, 1, '投递记账不触发结算')
  } finally { ledger.close() }
})

test('a restart sweep settles what an old process left stopped, and skips settled history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nis-team-stage-sweep-'))
  const file = join(dir, 'ledger.sqlite')
  try {
    let ledger = openTeamV2Ledger(file)
    const [left] = ledger.receiveAndAssign('msg-left-behind', [task('遗留', 'm1', 'msg-left-behind')])
    const [done] = ledger.receiveAndAssign('msg-done', [task('已完成', 'm1', 'msg-done')])
    ledger.start(left.request.id, left.attempt.id)
    ledger.submit(left.request.id, left.attempt.id, 'artifact:left')
    ledger.start(done.request.id, done.attempt.id)
    ledger.submit(done.request.id, done.attempt.id, 'artifact:done')
    /* 只结算第二条（模拟旧版本把第一条漏在了盘上）。 */
    /* ★1124b：最新优先 —— 后收的 done 现在是 items[0]（升序时才是 [1]），语义仍是"只结算第二条"。 */
    assert.equal(ledger.settleStages([(ledger.page(null, 10).items[0].request as { batchId: number }).batchId]), 1)
    const before = ledger.stageSettlements(0, 10).items
    ledger.close()

    const raw = new DatabaseSync(file)
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM stage_settlement').get().n, 1)
    } finally { raw.close() }

    ledger = openTeamV2Ledger(file)
    try {
      assert.equal(ledger.settleStages(), 1, '重启补齐漏掉的那一批')
      assert.equal(ledger.settleStages(), 0, '已补齐后不再产生第二条')
      const after = ledger.stageSettlements(0, 10).items
      assert.deepEqual(after.map(item => item.authorizingMessageId), ['msg-done', 'msg-left-behind'])
      assert.deepEqual(after[0], before[0], '已结算的历史一字不改')
      assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 2, pendingReports: 2, deliveredReports: 0 })
    } finally { ledger.close() }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
})

test('settled history is filtered out before any batch work, so the sweep is one probe per item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nis-team-stage-history-'))
  const file = join(dir, 'ledger.sqlite')
  try {
    const ledger = openTeamV2Ledger(file)
    try {
      const raw = new DatabaseSync(file)
      raw.exec('BEGIN')
      const batch = raw.prepare('INSERT INTO dispatch_batch VALUES (?, ?, 1)')
      const request = raw.prepare("INSERT INTO request (id,messageId,partKey,title,quote,acceptance,revision,batchId) VALUES (?, ?, 'one', 't','q','a', 1, ?)")
      const attempt = raw.prepare("INSERT INTO attempt VALUES (?, ?, 1, 'm1', 'submitted', 'f', NULL, NULL)")
      const settlement = raw.prepare('INSERT INTO stage_settlement VALUES (?, ?, ?, 1)')
      const item = raw.prepare('INSERT INTO stage_item VALUES (?, ?, 1, ?)')
      const report = raw.prepare("INSERT INTO stage_report VALUES (?, ?, 'pending', NULL, 1)")
      for (let i = 1; i <= 500; i++) {
        batch.run(i, 'u' + i); request.run(i, 'u' + i, i); attempt.run(i, i)
        settlement.run(i, i, 'k' + i); item.run(i, i, i); report.run(i, i)
      }
      raw.exec('COMMIT')
      raw.close()
      assert.equal(ledger.settleStages(), 0, '500 个已结算批次不该被重新尝试')
      const [fresh] = ledger.receiveAndAssign('msg-fresh', [task('新批次', 'm1', 'msg-fresh')])
      ledger.start(fresh.request.id, fresh.attempt.id)
      ledger.submit(fresh.request.id, fresh.attempt.id, 'artifact:fresh')
      assert.equal(ledger.settleStages(), 1, '只补新的那一批')
      assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 501, pendingReports: 501, deliveredReports: 0 })
    } finally { ledger.close() }
  } finally {
    /* Windows 上 WAL 句柄是异步释放的：ledger.close() 返回 ≠ 文件立刻可删（这个用例要处理 500 条结算，
       实测偶发 EPERM 卡住 6 秒以上 —— 与断言无关，是**测试环境卫生**问题）。
       做法：等它变成可删（最多 10 秒）；仍不行就如实打警告并留下目录路径，**不静默吞、也不造假红**。 */
    let removed = false
    for (let i = 0; i < 50 && !removed; i++) {
      try { rmSync(dir, { recursive: true, force: true }); removed = true } catch { await new Promise(resolve => setTimeout(resolve, 200)) }
    }
    if (!removed) console.warn('[test] 临时目录未能清理（Windows 句柄延迟，断言已通过）：' + dir)
  }
})

test('settled stages survive a process restart without a second report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nis-team-stage-'))
  const file = join(dir, 'ledger.sqlite')
  try {
    let ledger = openTeamV2Ledger(file)
    const [done] = ledger.receiveAndAssign('msg-restart', [task('完成', 'm1', 'msg-restart')])
    const [cut] = ledger.receiveAndAssign('msg-cut', [task('被中断', 'm1', 'msg-cut')])
    ledger.start(done.request.id, done.attempt.id); ledger.submit(done.request.id, done.attempt.id, 'artifact:r')
    ledger.start(cut.request.id, cut.attempt.id)
    ledger.close()

    ledger = openTeamV2Ledger(file)
    try {
      // 重开时结算前：只有已结束的批 1 会结算；运行中的批 2 还不结算
      assert.equal(ledger.settleStages(), 1)
      assert.equal(ledger.recoverAfterOwnerExit(), 1)
      assert.equal(ledger.needsRestartReview(), true)
      assert.equal(ledger.settleStages(), 1)
      const totals = { ...ledger.stageTotals() }
      assert.deepEqual(totals, { settlements: 2, pendingReports: 2, deliveredReports: 0 })
      const page = ledger.stageSettlements(0, 10)
      assert.deepEqual(page.items.map(item => [item.authorizingMessageId, item.standing]), [['msg-restart', 'awaiting_review'], ['msg-cut', 'interrupted']])
      assert.deepEqual(page.items[1].items.map(item => item.recoveryChecked), [false])
      assert.equal(ledger.settleStages(), 0)
      assert.deepEqual({ ...ledger.stageTotals() }, totals)
    } finally { ledger.close() }

    ledger = openTeamV2Ledger(file)
    try {
      assert.deepEqual({ ...ledger.stageTotals() }, { settlements: 2, pendingReports: 2, deliveredReports: 0 })
      assert.equal(ledger.stageSettlements(0, 10).items.length, 2)
    } finally { ledger.close() }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 }) }
})

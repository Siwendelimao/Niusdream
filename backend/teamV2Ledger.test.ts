import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { memberReportArtifact } from './teamV2Report.ts'

const first = { messageId: 'user-msg-7', partKey: 'sidebar', title: 'Fix sidebar', quote: '左栏状态不对', acceptance: 'Reconnect restores the correct state' }
const second = { ...first, partKey: 'usage', title: 'Fix usage', quote: '用量也不对' }

test('intake, sidebar execution fact, versioned acceptance and restart on one ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'nis-team-v2-'))
  const file = join(root, 'ledger.sqlite')
  let board = openTeamV2Ledger(file)
  try {
    const a = board.receive(first), b = board.receive(second)
    assert.deepEqual(board.receive(first), a)
    assert.throws(() => board.receive({ ...first, quote: 'different' }), /intake identity/)
    assert.deepEqual(board.list().map(row => [row.request.id, row.request.quote, row.phase]), [
      [a.id, first.quote, 'received'], [b.id, second.quote, 'received'],
    ])
    const initial = board.assign(a.id, 1, 'jo')
    const queued = board.assign(b.id, 1, 'jo')
    assert.throws(() => board.assign(a.id, 1, 'other'), /already assigned/)
    assert.deepEqual(board.runningMembers(), [])
    assert.throws(() => board.submit(a.id, initial.id, 'sha:old'), /invalid team attempt/)
    board.start(a.id, initial.id)
    assert.throws(() => board.start(b.id, queued.id), /already running/)
    assert.deepEqual(board.runningMembers().map(row => ({ ...row })), [{ memberId: 'jo', requestId: a.id, attemptId: initial.id }])
    assert.throws(() => board.reviseAcceptance(a.id, 1, 'new criteria'), /Settle/)
    board.submit(a.id, initial.id, 'sha:old')
    assert.deepEqual(board.runningMembers(), [])
    assert.equal(board.list()[0].phase, 'submitted')
    assert.throws(() => board.verify(a.id, initial.id, 'sha:wrong', true, 'check passed'), /Invalid team verification/)
    board.verify(a.id, initial.id, 'sha:old', false, 'reconnect regression')
    const retry = board.assign(a.id, 1, 'lin')
    board.start(a.id, retry.id)
    board.start(b.id, queued.id)
    assert.equal(board.runningMembers().length, 2)
    assert.throws(() => board.verify(a.id, initial.id, 'sha:old', true, 'late'), /Stale/)
    assert.throws(() => board.submit(a.id, queued.id, 'sha:wrong-request'), /Stale/)
    board.submit(a.id, retry.id, 'sha:new')
    board.verify(a.id, retry.id, 'sha:new', true, '3 checks passed')
    board.fail(b.id, queued.id, 'build process stopped with exit 1')
    const updated = board.reviseAcceptance(a.id, 1, 'Also verify narrow viewport', { messageId: 'msg-a2', quote: 'also check the narrow viewport' })
    assert.equal(updated.id, a.id)
    assert.equal(updated.revision, 2)
    assert.throws(() => board.assign(a.id, 1, 'lin'), /Stale/)
    assert.equal(board.receive(first).revision, 2)
    assert.throws(() => board.verify(a.id, retry.id, 'sha:new', true, 'again'), /Stale/)
    board.close()
    board = openTeamV2Ledger(file)
    assert.deepEqual(board.list().map(row => row.phase), ['received', 'failed'])
    assert.deepEqual(board.attempts(a.id).map(run => [run.phase, run.artifact, run.evidence]), [
      ['rejected', 'sha:old', 'reconnect regression'], ['accepted', 'sha:new', '3 checks passed'],
    ])
    assert.deepEqual(board.runningMembers(), [])
  } finally {
    board.close()
    rmSync(root, { recursive: true, force: true })
  }
  assert.throws(() => openTeamV2Ledger(join(root, 'missing.sqlite')))
})

test('durable member report and submitted state commit together and are verifiable after reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'nis-team-v2-report-'))
  const file = join(root, 'ledger.sqlite')
  let board = openTeamV2Ledger(file)
  try {
    const request = board.receive(first)
    const attempt = board.assign(request.id, request.revision, 'm1')
    board.start(request.id, attempt.id)
    const text = '成员提交原文\n包含换行与原样空格。 '
    const artifact = memberReportArtifact('member-session', 'member-turn', text)
    assert.throws(() => board.submit(request.id, attempt.id, artifact), /Invalid durable member report/)
    assert.throws(() => board.submit(request.id, attempt.id, artifact, text.trim()), /Invalid durable member report/)
    assert.equal(board.reviewCandidate(request.id).phase, 'running')
    assert.equal(board.readDurableReport(attempt.id, artifact), null)
    board.submit(request.id, attempt.id, artifact, text)
    board.close()
    board = openTeamV2Ledger(file)
    assert.equal(board.reviewCandidate(request.id).phase, 'submitted')
    assert.equal(board.readDurableReport(attempt.id, artifact), text)
    assert.equal(board.readDurableReport(attempt.id, memberReportArtifact('member-session', 'another-turn', text)), null)
    assert.equal(board.readDurableReport(attempt.id + 1, artifact), null)
  } finally {
    board.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage report counts all current phases and excludes reviews bound to superseded evidence', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const requests = Array.from({ length: 8 }, (_, i) => board.receive({ ...first, partKey: 'stage-' + i }))
    const [submitted, accepted, running, queued, failed, interrupted] = requests.slice(0, 6).map(r => board.assign(r.id, r.revision, 'm' + r.id))
    const receipt = { requestId: submitted.requestId, attemptId: submitted.id, artifact: 'submitted' }
    board.start(submitted.requestId, submitted.id, 'C:/fixture')
    board.submit(submitted.requestId, submitted.id, receipt.artifact)
    board.recordReview(receipt, null, { status: 'opinion', providerId: 'fixture', model: 'review', opinion: { status: 'supported', summary: 'not part of stage report' }, usage: null })
    assert.equal(board.stageReport().items[0].independentReview, 'supported')
    board.start(accepted.requestId, accepted.id)
    board.submit(accepted.requestId, accepted.id, 'accepted')
    board.verify(accepted.requestId, accepted.id, 'accepted', true, 'Report checked')
    board.start(running.requestId, running.id)
    board.start(failed.requestId, failed.id)
    board.fail(failed.requestId, failed.id, 'Run failed')
    board.interrupt(interrupted.requestId, interrupted.id, 'queued', 'Stopped')
    board.checkFile(receipt.requestId, receipt.attemptId, receipt.artifact, () => ({ kind: 'file-sha256', relativePath: 'a.txt', expected: 'x', actual: 'y', bytes: 1, outcome: 'mismatch' }))
    const one = board.stageReport()
    assert.deepEqual(Object.fromEntries(one.counts.map(row => [row.phase, row.count])), { accepted: 1, failed: 1, interrupted: 1, queued: 1, received: 2, running: 1, submitted: 1 })
    assert.deepEqual(one.items.map(r => r.phase), ['submitted', 'accepted', 'running', 'queued', 'failed', 'interrupted'])
    assert.equal(one.items[0].independentReview, null)
    assert.equal(one.items[0].lastFileCheck?.outcome, 'mismatch')
    assert.ok(!JSON.stringify(one).includes('not part of stage report'))
    assert.equal(one.items[3].requestId, queued.requestId)
    assert.equal(one.nextAfterId, requests[5].id)
    /* ★1124（老板拍板）：status 要带「每个成员最近一单」——主 agent 判断"新任务跟这成员上次有没有关联"靠它，
       rounds=3 且没过 ⇒ 下次派单前该换段。 */
    assert.deepEqual(one.members.map(m => m.memberId), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    assert.deepEqual(one.members.map(m => m.rounds), [1, 1, 1, 1, 1, 1])
    assert.equal(one.members[0].title, 'Fix sidebar')
    assert.equal(one.members[0].phase, 'submitted')
    const two = board.stageReport(one.nextAfterId!)
    assert.deepEqual(two.counts, one.counts)
    assert.deepEqual(two.items.map(r => r.requestId), requests.slice(6).map(r => r.id))
    assert.equal(two.nextAfterId, null)
    assert.throws(() => board.stageReport(-1), /cursor/)
    board.reviseAcceptance(accepted.requestId, accepted.revision, 'New criteria', { messageId: 'msg-revise', quote: 'new criteria please' })
    assert.equal(board.stageReport().items[1].phase, 'received')
    assert.equal(board.stageReport().counts.find(row => row.phase === 'received')?.count, 3)
  } finally { board.close() }
})

test('fence_hold persists OS process facts (pid + start stamp) and clears them on release', () => {
  const root = mkdtempSync(join(tmpdir(), 'nis-team-v2-fence-pid-'))
  const file = join(root, 'ledger.sqlite')
  let board = openTeamV2Ledger(file)
  try {
    const req = board.receive(first)
    const attempt = board.assign(req.id, req.revision, 'jo')
    board.start(req.id, attempt.id)
    /* 围栏拒绝时把"后端拉起过的进程"（pid + 启动戳）一起落库 —— 这是重启后唯一的 OS 事实来源。 */
    board.holdFence(req.id, attempt.id, '工具进程(pid 4242) 仍未交还工作区', [
      { pid: 4242, startStamp: '20261123-101500' },
      { pid: 4243, startStamp: null },
    ])
    const held = board.fenceHolds()
    assert.equal(held.length, 1)
    assert.equal(held[0].attempt.phase, 'interrupted')
    assert.deepEqual(held[0].pids, [
      { pid: 4242, startStamp: '20261123-101500' },
      { pid: 4243, startStamp: null },
    ], 'pid 与启动戳必须随围栏持久化（重启后靠它探活）')
    board.releaseFence(attempt.id, '围栏探针：OS 里已无该 pid')
    assert.equal(board.fenceHolds().length, 0)
  } finally { board.close() }
  /* 重开账本文件：解除后不许残留旧 pid（否则下次围栏会拿过期 pid 误判"还活着"）。 */
  board = openTeamV2Ledger(file)
  try {
    assert.equal(board.fenceHolds().length, 0, '重开后不该有围栏')
  } finally {
    board.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('acknowledge recovery must not close a fenced attempt (fence settles first)', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const req = board.receive(second)
    const attempt = board.assign(req.id, req.revision, 'lin')
    board.start(req.id, attempt.id)
    /* 围栏：副作用未确认 ⇒ interrupted + fence_hold */
    board.holdFence(req.id, attempt.id, '工具进程(pid 4242) 仍未交还工作区', [{ pid: 4242, startStamp: 'x' }])
    assert.equal(board.fenceHolds().length, 1)
    /* 人工确认恢复：这条**不进人工核对阶段** —— 仍待在待核列表里，状态也不许转 failed */
    board.acknowledgeRecovery(board.pendingRecoveryAttempts(), '老板', '人工看过，报告没交付')
    const row = board.list().find(r => r.request.id === req.id)
    assert.equal(row.phase, 'interrupted', '有围栏时不得转 failed：' + row.phase)
    assert.equal(board.fenceHolds().length, 1, '围栏不许被人工确认消掉')
    assert.deepEqual(board.pendingRecoveryAttempts(), [attempt.id], '围栏未解除 ⇒ 仍必须留在待核列表')
    /* 围栏按 OS 事实解除（fence_release 留证）→ **只**解除围栏；人工还没核对，所以仍待核 */
    board.releaseFence(attempt.id, '围栏探针：OS 里已无该 pid')
    assert.equal(board.fenceHolds().length, 0)
    assert.deepEqual(board.pendingRecoveryAttempts(), [attempt.id], '★OS 退出不等于人工已核对：围栏解除后仍必须待在核列表')
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'interrupted', '★围栏解除后不许自动转 failed（人工还没核）')
    assert.equal(board.fenceReleases().length, 1, '必须留下"副作用已按 OS 事实清理"的证据')
    /* 人工核对之后才允许落成"失败、可重派" */
    const reviewed = board.acknowledgeRecovery(board.pendingRecoveryAttempts(), '老板', '人工核对：报告未交付、副作用已清理')
    assert.equal(reviewed, 1, '人工核对应如实报出核了几条')
    assert.deepEqual(board.pendingRecoveryAttempts(), [], '人工核对后才不该再待核')
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'failed', '人工核对后应为可重派的 failed')
  } finally { board.close() }
})

test('submitWithNotes is atomic: report + settlement + note consumption all-or-nothing', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const req = board.receive(first)
    const attempt = board.assign(req.id, req.revision, 'jo')
    board.start(req.id, attempt.id)
    const n1 = board.addNote({ requestId: req.id, messageId: 'n1', quote: '补充', text: '第一条补充' })
    const n2 = board.addNote({ requestId: req.id, messageId: 'n2', quote: '补充', text: '第二条补充' })
    assert.equal(board.pendingNotes(req.id, attempt.id).length, 2)

    /* 正常交付：报告 + 结算 + 两条收件，一个事务全成立 */
    const artifact = memberReportArtifact('child', attempt.id + '', '最终报告正文')
    board.submitWithNotes(req.id, attempt.id, artifact, '最终报告正文', [n1.id, n2.id])
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'submitted')
    assert.equal(board.pendingNotes(req.id, attempt.id).length, 0, '交付后收件必须已消费')
    assert.equal(board.readDurableReport(attempt.id, artifact), '最终报告正文', '报告必须已落库')

    /* 原子性：传一条**不属于本 attempt** 的收件 ⇒ 整个事务回滚（报告也不许落） */
    const req2 = board.receive(second)
    const a2 = board.assign(req2.id, req2.revision, 'lin')
    board.start(req2.id, a2.id)
    const own = board.addNote({ requestId: req2.id, messageId: 'x', quote: '补充', text: '第二单自己的补充' })
    const artifact2 = memberReportArtifact('child', a2.id + '', '第二单报告')
    assert.throws(() => board.submitWithNotes(req2.id, a2.id, artifact2, '第二单报告', [n1.id]), /does not belong/)
    assert.equal(board.list().find(r => r.request.id === req2.id).phase, 'running', '失败后第二单仍 running（没被结算）')
    assert.equal(board.pendingNotes(req2.id, a2.id).length, 1, '失败后收件仍 pending（没被吃掉）')
    assert.equal(board.readDurableReport(a2.id, artifact2), null, '失败后报告不许落库')
  } finally { board.close() }
})

test('holdFenceOnInterrupted puts a persistent fence on an already-interrupted attempt', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const req = board.receive(first)
    const attempt = board.assign(req.id, req.revision, 'jo')
    board.start(req.id, attempt.id)
    /* 先模拟"工具启动即预登记"，再模拟后端退出把它变 interrupted */
    board.noteAttemptPid(attempt.id, 4242, 'ft-a')
    board.noteAttemptPid(attempt.id, 4243, 'ft-b')
    assert.equal(board.attemptPids(attempt.id).length, 2, '预登记必须落在 attempt 名下')
    board.recoverAfterOwnerExit()
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'interrupted')
    assert.equal(board.fenceHolds().length, 0, '普通重启不该自动挂围栏（默认语义不变）')

    /* 重启复核发现"还有活的" ⇒ 补登记围栏，且只留活的那些 */
    const ok = board.holdFenceOnInterrupted(attempt.id, '重启复核：仍有进程存活', [{ pid: 4242, startStamp: 'ft-a' }])
    assert.equal(ok, true)
    const held = board.fenceHolds()
    assert.equal(held.length, 1)
    assert.deepEqual(held[0].pids, [{ pid: 4242, startStamp: 'ft-a' }], '死掉的 pid 不该继续挂在围栏上')
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'interrupted', '补登记不改 phase')
    assert.equal(board.needsRestartReview(), true, '有围栏时仍在待对账')
  } finally { board.close() }
})

test('proc intent: spawn-before-pid fact survives a crash and is cleared by review', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const req = board.receive(first)
    const attempt = board.assign(req.id, req.revision, 'jo')
    board.start(req.id, attempt.id)

    /* ★1124：spawn 之前先落意图 —— pid 还不存在，但账本已经有这件事 */
    const token = 'host#intent-1'
    assert.ok(board.beginProcIntent(attempt.id, token, 'run_command') !== null, '在跑的单必须能落意图')
    assert.deepEqual(board.unboundProcIntents(attempt.id).map(i => i.tool), ['run_command'], 'pid 未知的意图必须留痕')
    assert.equal(board.procIntents(attempt.id).length, 1)
    assert.equal(board.procIntents(attempt.id)[0].pid, null, '还没拿到 pid 就是 null（不伪造）')

    /* 后端在"进程已起、pid 还没落库"之间被 SIGKILL ⇒ 意图仍是 pid 未知 */
    board.recoverAfterOwnerExit()
    assert.equal(board.list().find(r => r.request.id === req.id).phase, 'interrupted')
    assert.equal(board.unboundProcIntents(attempt.id).length, 1, '崩溃后这条"未知副作用"必须还在（这是堵口的事实来源）')

    /* 人工核对放行 ⇒ 意图随之结清（否则这单永远算未确认） */
    assert.equal(board.clearProcIntents(attempt.id), 1)
    assert.equal(board.unboundProcIntents(attempt.id).length, 0)
  } finally { board.close() }
})

test('proc intent: pid binding, end, and no intent for a settled attempt', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const req = board.receive(first)
    const attempt = board.assign(req.id, req.revision, 'jo')
    board.start(req.id, attempt.id)

    const token = 'host#intent-2'
    board.beginProcIntent(attempt.id, token, 'run_command')
    assert.equal(board.bindProcIntent(attempt.id, token, 5150), true, '拿到 pid 必须能补回同一行')
    assert.equal(board.unboundProcIntents(attempt.id).length, 0, '补过 pid 就不再是"未知"')
    assert.deepEqual(board.procIntents(attempt.id).map(i => i.pid), [5150])
    assert.equal(board.bindProcIntent(attempt.id, token, 5151), false, '同一行不许被改写（第二个 pid 不是它的）')
    assert.equal(board.endProcIntent(token), true, '进程结束要能删掉意图')
    assert.equal(board.procIntents(attempt.id).length, 0)

    /* 单已交付（终态）⇒ 不再落意图，也不伪造 */
    board.submit(req.id, attempt.id, 'sha:done')
    assert.equal(board.beginProcIntent(attempt.id, 'host#intent-3', 'run_command'), null, '终态单不许再落意图')
    assert.equal(board.procIntents(attempt.id).length, 0)
  } finally { board.close() }
})

test('the work panel page is newest-first and pages back towards older requests', () => {
  const board = openTeamV2Ledger(':memory:')
  try {
    const a = board.receive({ ...first, partKey: 'p1', title: 'one' })
    const b = board.receive({ ...first, partKey: 'p2', title: 'two' })
    const c = board.receive({ ...first, partKey: 'p3', title: 'three' })
    /* 第一页（没有游标）= 最新那批，顺序就是后端给的顺序，前端不再自己倒序。 */
    const page1 = board.page(null, 2)
    assert.deepEqual(page1.items.map(row => row.request.id), [c.id, b.id])
    assert.equal(page1.nextBeforeId, b.id, '游标是本页最小 id')
    /* 往回翻 = 更老的一批；到头了就没有游标（前端据此收起「加载更多」）。 */
    const page2 = board.page(page1.nextBeforeId, 2)
    assert.deepEqual(page2.items.map(row => row.request.id), [a.id])
    assert.equal(page2.nextBeforeId, null)
    /* 游标非法要当场拒，不能悄悄当成第一页。 */
    assert.throws(() => board.page(0, 2), /Invalid team work page cursor/)
    assert.throws(() => board.page(1.5, 2), /Invalid team work page cursor/)
  } finally { board.close() }
})

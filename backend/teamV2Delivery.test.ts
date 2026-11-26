import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { buildStageBrief, STAGE_PHASE_LABEL } from './teamV2Delivery.ts'

const task = (title: string, memberId: string) => ({ messageId: 'msg-' + title, partKey: 'task:' + title, title, quote: '需求：' + title, acceptance: '验收：' + title, memberId })

test('a brief states what each attempt did and never upgrades it to acceptance', () => {
  const brief = buildStageBrief({
    settlementId: 7,
    authorizingMessageId: 'msg-1',
    standing: 'awaiting_review',
    items: [
      { title: '左栏状态', memberId: 'm1', phase: 'submitted', recoveryChecked: false },
      { title: '用量口径', memberId: 'm2', phase: 'failed', recoveryChecked: false },
    ],
  })
  assert.match(brief.text, /阶段 7/)
  assert.match(brief.text, /左栏状态（m1）：已提交 · 待验收/)
  assert.match(brief.text, /用量口径（m2）：执行失败/)
  assert.match(brief.text, /提交不等于验收通过/)
  assert.match(brief.text, /未自动重派/)
  assert.equal(brief.needsRecovery, false)
  assert.deepEqual(brief.touched, ['submitted', 'failed'])
  // 报告已通过只能是报告层面
  const accepted = buildStageBrief({ settlementId: 8, authorizingMessageId: 'msg-2', standing: 'accepted', items: [{ title: 'A', memberId: 'm1', phase: 'accepted', recoveryChecked: false }] })
  assert.match(accepted.text, /报告层面的验收，不代表功能验收通过/)
  assert.match(accepted.text, /· A（m1）：报告已通过/)
  assert.doesNotMatch(accepted.text, /功能已通过|功能验收已通过/)
  // 中断未核对必须点出来，核对过的不算待办
  const interrupted = buildStageBrief({
    settlementId: 9, authorizingMessageId: 'msg-3', standing: 'interrupted',
    items: [
      { title: '被中断', memberId: 'm1', phase: 'interrupted', recoveryChecked: false },
      { title: '已核对', memberId: 'm2', phase: 'interrupted', recoveryChecked: true },
    ],
  })
  assert.match(interrupted.text, /待人工对账：1 项中断尚未核对（被中断）/)
  assert.equal(interrupted.needsRecovery, true)
  assert.match(interrupted.text, /被中断（m1）：中断 · 待人工核对/)
  assert.match(interrupted.text, /已核对（m2）：中断$|已核对（m2）：中断\n/)
  // 四种 phase 的标签都在，且没有把 submitted 说成通过
  for (const [phase, label] of Object.entries(STAGE_PHASE_LABEL)) {
    if (phase === 'submitted') assert.equal(label, '已提交 · 待验收')
    assert.ok(label.length > 0)
  }
  assert.throws(() => buildStageBrief({ settlementId: 0, authorizingMessageId: 'x', standing: 'failed', items: [{ title: 'a', memberId: 'm', phase: 'failed', recoveryChecked: false }] }), /identity/)
  assert.throws(() => buildStageBrief({ settlementId: 1, authorizingMessageId: 'x', standing: 'failed', items: [] }), /at least one item/)
})

test('pending reports are ordered, exclude delivered ones, and respect the settlement watermark', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const [a] = ledger.receiveAndAssign('msg-a', [task('A', 'm1')])
    ledger.start(a.request.id, a.attempt.id); ledger.submit(a.request.id, a.attempt.id, 'artifact:a')
    assert.equal(ledger.settleStages(), 1)
    const first = ledger.stageSettlements(0, 10).items[0]
    const [b] = ledger.receiveAndAssign('msg-b', [task('B', 'm1')])
    ledger.start(b.request.id, b.attempt.id); ledger.fail(b.request.id, b.attempt.id, '模型报错')
    assert.equal(ledger.settleStages(), 1)
    assert.equal(ledger.latestSettlementId(), first.settlementId + 1)

    assert.deepEqual(ledger.pendingStageReports(0, 10).map(view => [view.settlementId, view.authorizingMessageId, view.standing]), [
      [first.settlementId, 'msg-a', 'awaiting_review'],
      [first.settlementId + 1, 'msg-b', 'failed'],
    ])
    // 开关开启时记下的水位 = 当时最新结算：已结算的都在水位内 ⇒ 一条都不合格（同毫秒也一样）
    const watermarkAtSwitchOn = ledger.latestSettlementId()
    assert.deepEqual(ledger.pendingStageReports(watermarkAtSwitchOn, 10), [])
    // 之后新结算的才合格，且按 id 升序
    const [c] = ledger.receiveAndAssign('msg-c', [task('C', 'm1')])
    ledger.start(c.request.id, c.attempt.id); ledger.submit(c.request.id, c.attempt.id, 'artifact:c')
    assert.equal(ledger.settleStages(), 1)
    assert.deepEqual(ledger.pendingStageReports(watermarkAtSwitchOn, 10).map(view => view.authorizingMessageId), ['msg-c'])
    // 投过的不再入选
    ledger.markStageReportDelivered(first.settlementId, 'msg-target')
    assert.deepEqual(ledger.pendingStageReports(0, 10).map(view => view.authorizingMessageId), ['msg-b', 'msg-c'])
    assert.throws(() => ledger.pendingStageReports(-1), /watermark/)
    assert.throws(() => ledger.pendingStageReports(0, 0), /limit/)
  } finally { ledger.close() }
})

test('C opinion rides along in the brief but never changes the phase', () => {
  /* ★1124（老板选 A）：C 只出意见 —— 简报里多一行「AI 复验：…」，条目相位仍是「待验收」。 */
  const brief = buildStageBrief({
    settlementId: 9, authorizingMessageId: 'msg-x', standing: 'awaiting_review',
    items: [
      { title: '改圆角', memberId: 'm1', phase: 'submitted', recoveryChecked: false, review: { status: 'supported', summary: '代码里有 border-radius' } },
      { title: '写文档', memberId: 'm2', phase: 'submitted', recoveryChecked: false, review: { status: 'concerns', summary: '只改了注释' } },
    ],
  })
  assert.match(brief.text, /AI 复验：证据支持 · 代码里有 border-radius/)
  assert.match(brief.text, /AI 复验：有疑虑 · 只改了注释/)
  assert.match(brief.text, /改圆角（m1）：已提交 · 待验收/, '相位不能说成通过')
  assert.match(brief.text, /小结：2 项待验收/)
  assert.doesNotMatch(brief.text, /已通过/)
})

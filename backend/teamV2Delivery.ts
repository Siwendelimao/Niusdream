import type { StagePhase, StageStanding } from './teamV2Stage.ts'

/** One settled attempt as the brief renders it. Facts only — the brief never invents a verdict. */
export type StageBriefItem = { title: string; memberId: string; phase: StagePhase; recoveryChecked: boolean; autoVerified?: boolean; review?: { status: 'supported' | 'concerns' | 'insufficient'; summary: string } | null }
export type StageBriefInput = {
  settlementId: number
  authorizingMessageId: string
  standing: StageStanding
  items: ReadonlyArray<StageBriefItem>
}

export const STAGE_PHASE_LABEL: Record<StagePhase, string> = {
  queued: '排队中', running: '执行中', submitted: '已提交 · 待验收',
  accepted: '报告已通过', rejected: '报告被驳回', failed: '执行失败', interrupted: '中断',
}

/** Items that still need a human decision, so the brief can say so instead of implying closure. */
function pendingRecovery(items: ReadonlyArray<StageBriefItem>): StageBriefItem[] {
  return items.filter(item => item.phase === 'interrupted' && !item.recoveryChecked)
}

/** A stage brief is one message about one settled batch: execution facts, never acceptance.
 * Same batch → same brief → one message; failures and interrupts ride along, never a second round. */
export function buildStageBrief(input: StageBriefInput): { text: string; needsRecovery: boolean; touched: StagePhase[] } {
  if (!input.items.length) throw new Error('A stage brief needs at least one item')
  if (!Number.isSafeInteger(input.settlementId) || input.settlementId < 1) throw new Error('Invalid stage brief identity')
  const lines: string[] = []
  lines.push(`【团队阶段汇报】阶段 ${input.settlementId}：本批 ${input.items.length} 项已全部结束执行（授权消息 ${input.authorizingMessageId}）`)
  for (const item of input.items) {
    /* ★1124：自动验收（硬判据）通过 ≠ 报告层面通过 —— 前者是真读过工作区产物，措辞不能混。 */
    const state = item.phase === 'accepted' && item.autoVerified ? '已通过（自动验收 · 硬判据）' : STAGE_PHASE_LABEL[item.phase]
    if (state === undefined) throw new Error('Unknown team attempt phase in brief')
    lines.push(`· ${item.title}（${item.memberId}）：${state}${item.phase === 'interrupted' && !item.recoveryChecked ? ' · 待人工核对' : ''}`)
    /* ★1124（老板选 A）：C 的意见只**附带**给人看，绝不改相位 —— 也别把它写成"结论"。 */
    if (item.review) {
      const label = { supported: 'AI 复验：证据支持', concerns: 'AI 复验：有疑虑', insufficient: 'AI 复验：证据不足' }[item.review.status]
      lines.push(`   ↳ ${label}${item.review.summary ? ' · ' + item.review.summary : ''}`)
    }
  }
  const recovery = pendingRecovery(input.items)
  /* ★1124（老板要"最后汇报 5 个都验收过了的结论"）：一句总账 —— 几项通过、几项待定、几项没过。
     只报**账本里的相位**，绝不把"待验收"说成"通过"。 */
  const tally = {
    accepted: input.items.filter(item => item.phase === 'accepted').length,
    submitted: input.items.filter(item => item.phase === 'submitted').length,
    rejected: input.items.filter(item => item.phase === 'rejected').length,
    failed: input.items.filter(item => item.phase === 'failed').length,
    interrupted: recovery.length,
    queued: input.items.filter(item => item.phase === 'queued' || item.phase === 'running').length,
  }
  const tallyParts = [
    tally.accepted ? `${tally.accepted} 项已通过` : '',
    tally.submitted ? `${tally.submitted} 项待验收` : '',
    tally.rejected ? `${tally.rejected} 项被驳回` : '',
    tally.failed ? `${tally.failed} 项执行失败` : '',
    tally.interrupted ? `${tally.interrupted} 项中断待核对` : '',
    tally.queued ? `${tally.queued} 项未结束` : '',
  ].filter(Boolean)
  lines.push(`小结：${tallyParts.join(' · ') || '（无）'}`)
  lines.push(recovery.length
    ? `待人工对账：${recovery.length} 项中断尚未核对（${recovery.map(item => item.title).join('、')}）——外部副作用未确认，需人工核对后再处理。`
    : '待人工对账：无中断待核对。')
  if (input.items.some(item => item.phase === 'accepted' && !item.autoVerified)) {
    lines.push('说明：报告已通过只代表报告层面的验收，不代表功能验收通过。')
  } else if (input.items.some(item => item.phase === 'submitted')) {
    lines.push('说明：提交不等于验收通过，仍需人工验收。')
  }
  if (input.items.some(item => item.phase === 'failed' || item.phase === 'rejected')) {
    lines.push('失败的尝试保留在历史里，未自动重派。')
  }
  return { text: lines.join('\n'), needsRecovery: recovery.length > 0, touched: input.items.map(item => item.phase) }
}

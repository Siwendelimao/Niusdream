import { createHash } from 'node:crypto'

/** A stage is one dispatch batch whose current attempts have all stopped executing.
 * Standing is *derived* from attempt rows on every read — this module never stores a second truth. */
export type StagePhase = 'queued' | 'running' | 'submitted' | 'accepted' | 'rejected' | 'failed' | 'interrupted' | 'cancelled'

/** executing > awaiting_review > interrupted > rejected > failed > **cancelled** > accepted.
 * `executing` wins because a batch that went back to work is no longer a finished stage (rework).
 * `submitted` stays awaiting_review: a committed report is not acceptance.
 * `cancelled` 优先于 `accepted`：一个阶段里只要有人被取消，就不能对外说"整批通过"。 */
export type StageStanding = 'executing' | 'awaiting_review' | 'interrupted' | 'rejected' | 'failed' | 'cancelled' | 'accepted'

export function deriveStageStanding(phases: ReadonlyArray<StagePhase>): StageStanding {
  if (!Array.isArray(phases) || phases.length === 0) throw new Error('A stage needs at least one attempt')
  if (phases.some(phase => phase === 'queued' || phase === 'running')) return 'executing'
  if (phases.some(phase => phase === 'submitted')) return 'awaiting_review'
  if (phases.some(phase => phase === 'interrupted')) return 'interrupted'
  if (phases.some(phase => phase === 'rejected')) return 'rejected'
  if (phases.some(phase => phase === 'failed')) return 'failed'
  if (phases.some(phase => phase === 'cancelled')) return 'cancelled'
  return 'accepted'
}

/** Stage identity is the settled attempt set itself (request + version + attempt).
 * Same set re-observed → same key → no second settlement; rework creates new attempts → new stage. */
export function stageAttemptKey(items: ReadonlyArray<{ requestId: number; revision: number; attemptId: number }>): string {
  if (!Array.isArray(items) || items.length === 0) throw new Error('A stage needs at least one attempt')
  const rows = items.map(item => {
    if (![item.requestId, item.revision, item.attemptId].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('Invalid team stage attempt identity')
    }
    return `${item.requestId}:${item.revision}:${item.attemptId}`
  }).sort()
  if (new Set(rows).size !== rows.length) throw new Error('Duplicate team stage attempt identity')
  return createHash('sha256').update(rows.join('|')).digest('hex')
}

import type { openTeamV2Ledger } from './teamV2Ledger.ts'

type Ledger = ReturnType<typeof openTeamV2Ledger>
export type ReviewReceipt = { requestId: number; attemptId: number; artifact: string }
const MAX_EVIDENCE_BYTES = 24 * 1024

/** Shared preparation for manual and scheduled review. Read-only; no verdict or model invocation. */
export function prepareTeamV2Review(ledger: Ledger, receipt: ReviewReceipt, readVerifiedReport: (receipt: ReviewReceipt, memberId: string) => string | null) {
  const { request, attempt, fileCheck } = ledger.reviewCandidate(receipt.requestId)
  if (!attempt || attempt.phase !== 'submitted' || attempt.id !== receipt.attemptId || attempt.artifact !== receipt.artifact) {
    return { status: 'blocked', reason: 'stale-receipt' } as const
  }
  const report = readVerifiedReport(receipt, attempt.memberId)
  if (report === null) return { status: 'blocked', reason: 'report-unverified' } as const
  const packet = {
    receipt, revision: request.revision, quote: request.quote, title: request.title,
    acceptance: request.acceptance, report, fileCheck,
  }
  // This is a size limit on evidence, not a tokenizer or a claim that a model window fits.
  const bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8')
  if (bytes > MAX_EVIDENCE_BYTES) return { status: 'blocked', reason: 'evidence-too-large', bytes, limit: MAX_EVIDENCE_BYTES } as const
  return { status: 'prepared', packet, bytes } as const
}

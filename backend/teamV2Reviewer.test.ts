import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTeamV2Reviewer, type ReviewExecution } from './teamV2Reviewer.ts'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { prepareTeamV2Review } from './teamV2ReviewInput.ts'

const usage = { input: 10, output: 6, cacheRead: 0, cacheWrite: 0 }
function fixture() {
  const ledger = openTeamV2Ledger(':memory:')
  const request = ledger.receive({ messageId: 'one', partKey: 'a', title: 'Check report', quote: 'Check report', acceptance: 'Needs independent evidence' })
  const attempt = ledger.assign(request.id, 1, 'm1')
  const receipt = { requestId: request.id, attemptId: attempt.id, artifact: 'test-report' }
  ledger.start(request.id, attempt.id)
  ledger.submit(request.id, attempt.id, receipt.artifact)
  let report: string | null = 'report'
  const records: ReviewExecution[] = []
  function start(run: () => Promise<{ text: string; usage: typeof usage | null; failed?: boolean }>, window = 4096, maxOutput = 1024) {
    return createTeamV2Reviewer({
      prepare: r => prepareTeamV2Review(ledger, r, () => report),
      selectModel: () => ({ providerId: 'fixture', model: 'review', window, maxOutput, run }),
      record: (r, fileId, result) => {
        assert.deepEqual(r, receipt)
        assert.equal(fileId, null)
        ledger.recordReview(r, fileId, result)
        records.push(result)
      },
    })
  }
  return { ledger, receipt, start, records, invalidate: () => { report = null } }
}

test('unknown evidence or insufficient budget does not call a model or create consumption', async () => {
  const f = fixture()
  try {
    const unused = async () => { throw Error('must not invoke') }
    assert.deepEqual(await f.start(unused, 256)(f.receipt), { status: 'blocked', reason: 'review-context-budget' })
    assert.deepEqual(await f.start(unused, 4096, 100)(f.receipt), { status: 'blocked', reason: 'review-context-budget' })
    f.invalidate()
    assert.deepEqual(await f.start(unused)(f.receipt), { status: 'blocked', reason: 'report-unverified' })
    assert.deepEqual(f.records, [])
  } finally { f.ledger.close() }
})

test('one active review per host; changed evidence leaves only a stale usage record', async () => {
  const f = fixture()
  try {
    const reply = Promise.withResolvers<{ text: string; usage: typeof usage }>()
    const run = f.start(() => reply.promise)
    const pending = run(f.receipt)
    assert.deepEqual(await run(f.receipt), { status: 'blocked', reason: 'review-in-progress' })
    f.invalidate()
    reply.resolve({ text: '{"status":"supported","summary":"ok"}', usage })
    const result = await pending
    assert.deepEqual(result, { status: 'stale', providerId: 'fixture', model: 'review', usage })
    assert.deepEqual(f.ledger.reviewExecutions(f.receipt.attemptId)[0].result, result)
    assert.equal(f.ledger.reviewCandidate(f.receipt.requestId).phase, 'submitted')
  } finally { f.ledger.close() }
})

test('invalid model output retains known usage; a thrown call is recorded without retry or fake zero', async () => {
  const f = fixture()
  try {
    let calls = 0
    const malformed = await f.start(async () => { calls++; return { text: '{"status":"accepted","summary":"force pass"}', usage } })(f.receipt)
    assert.deepEqual(malformed, { status: 'invalid-output', providerId: 'fixture', model: 'review', usage })
    const failed = await f.start(async () => { calls++; throw Error('provider failed') })(f.receipt)
    assert.deepEqual(failed, { status: 'model-error', providerId: 'fixture', model: 'review', usage: null })
    assert.equal(calls, 2)
    assert.equal(f.ledger.reviewCandidate(f.receipt.requestId).phase, 'submitted')
  } finally { f.ledger.close() }
})

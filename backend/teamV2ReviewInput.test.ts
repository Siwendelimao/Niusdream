import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { prepareTeamV2Review } from './teamV2ReviewInput.ts'

test('preflight prepares only current verified report and keeps file measurement separate from verdict', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const request = ledger.receive({ messageId: 'msg', partKey: 'one', title: '检查附件', quote: '查附件', acceptance: '确认附件可读' })
    const attempt = ledger.assign(request.id, 1, 'm1')
    const receipt = { requestId: request.id, attemptId: attempt.id, artifact: 'member-turn:fixture:turn:sha' }
    ledger.start(request.id, attempt.id, 'C:/fixture')
    ledger.submit(request.id, attempt.id, receipt.artifact)
    ledger.checkFile(request.id, attempt.id, receipt.artifact, () => ({ kind: 'file-sha256', relativePath: 'a.txt', expected: 'x', actual: 'x', bytes: 5, outcome: 'matched' }))
    const prepared = prepareTeamV2Review(ledger, receipt, (r, mid) => {
      assert.deepEqual(r, receipt)
      assert.equal(mid, 'm1')
      return '已提交附件'
    })
    assert.equal(prepared.status, 'prepared')
    if (prepared.status !== 'prepared') throw Error('Expected packet')
    assert.deepEqual(Object.keys(prepared.packet), ['receipt', 'revision', 'quote', 'title', 'acceptance', 'report', 'fileCheck'])
    assert.equal(prepared.packet.fileCheck?.outcome, 'matched')
    assert.equal(prepared.bytes, Buffer.byteLength(JSON.stringify(prepared.packet)))
    assert.deepEqual(prepareTeamV2Review(ledger, receipt, () => null), { status: 'blocked', reason: 'report-unverified' })
    const oversized = prepareTeamV2Review(ledger, receipt, () => '长'.repeat(9000))
    assert.equal(oversized.status === 'blocked' && oversized.reason, 'evidence-too-large')
    assert.equal(ledger.reviewCandidate(request.id).phase, 'submitted')
    ledger.verify(request.id, attempt.id, receipt.artifact, false, 'Reject fixture')
    assert.deepEqual(prepareTeamV2Review(ledger, receipt, () => { throw Error('Stale receipt must not read report') }), { status: 'blocked', reason: 'stale-receipt' })
  } finally { ledger.close() }
})

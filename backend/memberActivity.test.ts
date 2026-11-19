import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemberActivity, type MemberSegmentKey, type MemberTurn } from './memberActivity.ts'

const old = { parentSessionId: 'parent', memberId: 'm3', childSessionId: 'old' }
const current = { ...old, childSessionId: 'new' }
const other = { parentSessionId: 'other', memberId: 'm3', childSessionId: 'other-child' }
const turn = (turnId: string, kind: MemberTurn['kind'] = 'private') => ({ turnId, kind })

function fixture(logEpoch = 'process-A') {
  const revs = new Map<string, number>()
  const frames: ReturnType<ReturnType<typeof createMemberActivity>['snapshot']>[] = []
  const currentStateRev = (id: string) => revs.get(id) ?? 0
  const activity = createMemberActivity({ logEpoch, currentStateRev, publish(id) {
    revs.set(id, currentStateRev(id) + 1)
    frames.push(activity.snapshot(id, ['m3', 'm4']))
  } })
  const snapshot = (id = old.parentSessionId) => activity.snapshot(id, ['m3', 'm4'])
  function bind(key: MemberSegmentKey, observedIdle = true) {
    activity.bind(key, { observedIdle })
    assert.equal(activity.selectCurrent(key, null, true), true)
  }
  return { activity, bind, frames, snapshot }
}

test('queue is not execution; dispatch transfers the same turn ID from lane to child to execution', () => {
  const { activity, bind, snapshot, frames } = fixture()
  assert.equal(snapshot().members[0].phase, 'unknown')
  activity.enqueueDispatch(old.parentSessionId, old.memberId, 'assigned')
  assert.equal(snapshot().members[0].phase, 'queued')
  assert.equal(snapshot().runningMembers, 0)
  assert.equal(snapshot().members[0].current.childSessionId, null)
  bind(old)
  activity.enqueue(old, turn('assigned', 'dispatch'))
  assert.deepEqual(snapshot().members[0].lane, [])
  assert.equal(activity.segmentSnapshot(old).phase, 'queued')
  const token = activity.start(old, turn('assigned', 'dispatch'))
  assert.equal(snapshot().runningMembers, 1)
  assert.deepEqual(activity.segmentSnapshot(old).queued, [])
  assert.deepEqual(snapshot(), frames.at(-1))
  assert.equal(activity.finish(token), true)
  assert.equal(snapshot().members[0].phase, 'idle')
  activity.enqueueDispatch(old.parentSessionId, old.memberId, 'rejected-before-start')
  activity.discardDispatch(old.parentSessionId, old.memberId, 'rejected-before-start')
  assert.equal(snapshot().members[0].phase, 'idle')
  activity.enqueue(old, turn('private-removed'))
  activity.discardQueued(old, 'private-removed')
  assert.equal(activity.segmentSnapshot(old).phase, 'idle')
  assert.ok(frames.every((frame, i) => frame.stateRev === i + 1))
})

test('exact token closes only its execution, including a retried turn with the same turn ID', () => {
  const { activity, bind, snapshot, frames } = fixture()
  bind(old)
  const first = activity.start(old, turn('same'))
  activity.enqueue(old, turn('waiting'))
  assert.equal(activity.segmentSnapshot(old).phase, 'running')
  assert.equal(activity.finish(first), true)
  assert.equal(activity.segmentSnapshot(old).phase, 'queued')
  const second = activity.start(old, turn('same'))
  assert.notEqual(first.executionId, second.executionId)
  const overlap = activity.start(old, turn('replaced-agent-overlap'))
  assert.equal(activity.finish(overlap), true)
  const before = frames.length
  assert.equal(activity.finish(first), false)
  assert.equal(activity.finish({ ...second }), false)
  assert.equal(frames.length, before)
  assert.equal(activity.segmentSnapshot(old).execution, second)
  assert.equal(snapshot().runningMembers, 1)
  assert.equal(activity.finish(second), true)
})

test('selected child and current child are distinct; two live child segments count one member', () => {
  const { activity, bind, snapshot } = fixture()
  bind(old)
  const first = activity.start(old, turn('old-run', 'dispatch'))
  activity.bind(current, { observedIdle: true })
  assert.equal(activity.selectCurrent(current, old.childSessionId, true), true)
  assert.equal(activity.selectCurrent(old, null, true), false)
  assert.equal(snapshot().members[0].current.phase, 'idle')
  assert.equal(snapshot().members[0].phase, 'running')
  assert.equal(activity.segmentSnapshot(old).execution, first)
  const second = activity.start(current, turn('new-private'))
  assert.equal(snapshot().runningMembers, 1)
  assert.equal(snapshot().members[0].executions.length, 2)
  assert.throws(() => activity.unbind(old))
  activity.finish(first)
  activity.unbind(old)
  assert.equal(activity.segmentSnapshot(old).phase, 'unknown')
  assert.equal(activity.segmentSnapshot(current).execution, second)
})

test('no guessed binding, no cross-parent bleed and no cross-process idle inference', () => {
  const { activity, bind, snapshot } = fixture()
  bind(old, false)
  assert.equal(activity.segmentSnapshot(old).phase, 'unknown')
  bind(other)
  assert.throws(() => activity.bind({ ...old, parentSessionId: other.parentSessionId }, { observedIdle: true }))
  assert.throws(() => activity.start({ ...old, memberId: 'm4' }, turn('invalid')))
  const second = activity.start(other, turn('other-private'))
  assert.equal(snapshot().runningMembers, 0)
  assert.equal(snapshot(other.parentSessionId).runningMembers, 1)
  const reboot = fixture('process-B')
  assert.notEqual(snapshot().logEpoch, reboot.snapshot().logEpoch)
  assert.equal(reboot.snapshot(other.parentSessionId).stateRev, 0)
  assert.equal(reboot.activity.segmentSnapshot(other).phase, 'unknown')
  assert.equal(reboot.activity.finish(second), false)
  reboot.bind(other)
  assert.equal(reboot.activity.segmentSnapshot(other).phase, 'idle')
})

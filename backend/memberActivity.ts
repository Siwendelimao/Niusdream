import { randomUUID } from 'node:crypto'

export const MEMBER_ROSTER_ID = Symbol('member-roster-id')
export type MemberSegmentKey = Readonly<{ parentSessionId: string; memberId: string; childSessionId: string; [MEMBER_ROSTER_ID]?: object }>
export type MemberTurnKind = 'dispatch' | 'private' | 'unknown'
export type MemberTurn = Readonly<{ turnId: string; kind: MemberTurnKind; [MEMBER_ROSTER_ID]?: object }>
export type MemberExecution = Readonly<MemberSegmentKey & MemberTurn & { executionId: string }>
export type MemberActivityPhase = 'unknown' | 'idle' | 'queued' | 'running'

type Segment = {
  key: MemberSegmentKey
  observed: boolean
  queued: Map<string, MemberTurn>
  active: Set<MemberExecution>
  retired?: boolean
}
type Member = { current: Segment | null; segments: Map<string, Segment>; lane: Map<string, MemberTurn> }

type StateDomain = {
  logEpoch: string
  currentStateRev: (parentSessionId: string) => number
  /** Synchronously advance stateRev through the existing parent status frame constructor and publish it.
   * Transport failures are handled by the publisher, not thrown into the execution lifecycle. */
  publish: (parentSessionId: string) => void
}

/** Process-local projection input: only authoritative session binding, queue and execution edges. */
export function createMemberActivity({ logEpoch, currentStateRev, publish }: StateDomain) {
  const parents = new Map<string, Map<string, Member>>()
  const segments = new Map<string, Segment>()

  function memberFor(parentSessionId: string, memberId: string): Member {
    let members = parents.get(parentSessionId)
    if (!members) parents.set(parentSessionId, members = new Map())
    let member = members.get(memberId)
    if (!member) members.set(memberId, member = { current: null, segments: new Map(), lane: new Map() })
    return member
  }

  function bound(key: MemberSegmentKey): Segment {
    const segment = segments.get(key.childSessionId)
    if (!segment || segment.key.parentSessionId !== key.parentSessionId || segment.key.memberId !== key.memberId) {
      throw new Error('Member activity requires an exact, registered child session binding')
    }
    return segment
  }

  function checkTurn(turn: MemberTurn): void {
    if (!turn.turnId || !['dispatch', 'private', 'unknown'].includes(turn.kind)) throw new Error('Invalid member turn identity')
  }

  function bind(key: MemberSegmentKey, { observedIdle }: { observedIdle: boolean }): void {
    if (!key.parentSessionId || !key.memberId || !key.childSessionId || key.parentSessionId === key.childSessionId) {
      throw new Error('Invalid member child session binding')
    }
    let segment = segments.get(key.childSessionId)
    if (segment) segment = bound(key)
    const member = memberFor(key.parentSessionId, key.memberId)
    let changed = false
    if (segment) {
      if (segment.key[MEMBER_ROSTER_ID] !== key[MEMBER_ROSTER_ID]) {
        segment.key = Object.freeze({ ...key })
        segment.observed = observedIdle
        changed = true
      }
      if (observedIdle && !segment.observed) { segment.observed = true; changed = true }
    } else {
      segment = { key: Object.freeze({ ...key }), observed: observedIdle, queued: new Map(), active: new Set() }
      segments.set(key.childSessionId, segment)
      member.segments.set(key.childSessionId, segment)
      changed = true
    }
    if (changed) publish(key.parentSessionId)
  }

  /** Apply only the authoritative segment switch, not a window open or an execution callback. */
  function selectCurrent(key: MemberSegmentKey, expectedChildSessionId: string | null, current: boolean): boolean {
    const segment = bound(key)
    const member = parents.get(key.parentSessionId)!.get(key.memberId)!
    if ((member.current?.key.childSessionId ?? null) !== expectedChildSessionId) return false
    if (!current && member.current !== segment) return false
    const next = current ? segment : null
    if (member.current !== next) { member.current = next; publish(key.parentSessionId) }
    return true
  }

  /** A lane item has no child binding yet: a fresh segment may be chosen on dequeue. */
  function enqueueDispatch(parentSessionId: string, memberId: string, turnId: string, rosterId?: object): void {
    const turn = Object.freeze({ turnId, kind: 'dispatch' as const, [MEMBER_ROSTER_ID]: rosterId })
    checkTurn(turn)
    const member = memberFor(parentSessionId, memberId)
    if (member.lane.has(turnId)) return
    member.lane.set(turnId, turn)
    publish(parentSessionId)
  }

  function discardDispatch(parentSessionId: string, memberId: string, turnId: string): void {
    if (parents.get(parentSessionId)?.get(memberId)?.lane.delete(turnId)) publish(parentSessionId)
  }

  function membershipOf(key: MemberSegmentKey, turn: MemberTurn): object | undefined {
    const laneTurn = turn.kind === 'dispatch' ? parents.get(key.parentSessionId)?.get(key.memberId)?.lane.get(turn.turnId) : undefined
    return laneTurn ? laneTurn[MEMBER_ROSTER_ID] : MEMBER_ROSTER_ID in turn ? turn[MEMBER_ROSTER_ID] : key[MEMBER_ROSTER_ID]
  }

  function enqueue(key: MemberSegmentKey, turn: MemberTurn): void {
    const segment = bound(key)
    checkTurn(turn)
    const previous = segment.queued.get(turn.turnId)
    if (previous) {
      if (previous.kind !== turn.kind) throw new Error('Member queue identity changed kind')
      return
    }
    if (Array.from(segment.active).some(e => e.turnId === turn.turnId)) throw new Error('Cannot queue a running member turn')
    segment.queued.set(turn.turnId, Object.freeze({ ...turn, [MEMBER_ROSTER_ID]: membershipOf(key, turn) }))
    if (turn.kind === 'dispatch') parents.get(key.parentSessionId)!.get(key.memberId)!.lane.delete(turn.turnId)
    publish(key.parentSessionId)
  }

  function discardQueued(key: MemberSegmentKey, turnId: string): void {
    const segment = segments.get(key.childSessionId)
    if (segment && bound(key).queued.delete(turnId)) {
      if (segment.retired && !segment.active.size && !segment.queued.size) unbind(key)
      else publish(key.parentSessionId)
    }
  }

  /** Call only on actual start, never when accepted by a lane or dequeued for an attempt. */
  function start(key: MemberSegmentKey, turn: MemberTurn): MemberExecution {
    const segment = bound(key)
    checkTurn(turn)
    const queued = segment.queued.get(turn.turnId)
    if (queued && queued.kind !== turn.kind) throw new Error('Member execution changed queued turn kind')
    const token = Object.freeze({ ...key, ...turn, [MEMBER_ROSTER_ID]: queued ? queued[MEMBER_ROSTER_ID] : membershipOf(key, turn), executionId: randomUUID() })
    segment.queued.delete(turn.turnId)
    if (turn.kind === 'dispatch') parents.get(key.parentSessionId)!.get(key.memberId)!.lane.delete(turn.turnId)
    segment.active.add(token)
    if (segment.key[MEMBER_ROSTER_ID] === token[MEMBER_ROSTER_ID]) segment.observed = true
    publish(key.parentSessionId)
    return token
  }

  /** Use the token captured by that execution, not whichever turn the session now owns. */
  function finish(token: MemberExecution): boolean {
    const segment = segments.get(token.childSessionId)
    if (!segment?.active.delete(token)) return false
    if (segment.retired && !segment.active.size && !segment.queued.size) unbind(token)
    else publish(token.parentSessionId)
    return true
  }

  /** For explicit session deletion, or retiring an inactive archived segment. */
  function unbind(key: MemberSegmentKey): void {
    const segment = bound(key)
    if (segment.active.size || segment.queued.size) throw new Error('Cannot discard live member session activity')
    const members = parents.get(key.parentSessionId)!
    const member = members.get(key.memberId)!
    member.segments.delete(key.childSessionId)
    if (member.current === segment) member.current = null
    segments.delete(key.childSessionId)
    if (!member.segments.size && !member.lane.size) members.delete(key.memberId)
    if (!members.size) parents.delete(key.parentSessionId)
    publish(key.parentSessionId)
  }

  function retire(key: MemberSegmentKey): void {
    const segment = segments.get(key.childSessionId)
    if (!segment) return
    const member = parents.get(key.parentSessionId)?.get(key.memberId)
    if (member?.current === segment) selectCurrent(key, key.childSessionId, false)
    if (!segment.active.size && !segment.queued.size) unbind(key)
    else segment.retired = true
  }

  function segmentView(segment: Segment | undefined | null, rosterId?: object) {
    const accepts = (item: MemberTurn) => !rosterId || item[MEMBER_ROSTER_ID] === rosterId
    const queued = segment ? [...segment.queued.values()].filter(accepts) : []
    const executions = [...(segment?.active ?? [])].filter(accepts)
    const observed = segment?.observed === true && (!rosterId || segment.key[MEMBER_ROSTER_ID] === rosterId)
    const execution = executions.at(-1) ?? null
    const phase: MemberActivityPhase = execution ? 'running' : queued.length ? 'queued' : observed ? 'idle' : 'unknown'
    return { childSessionId: segment && (!rosterId || observed || execution || queued.length || segment.key[MEMBER_ROSTER_ID] === rosterId) ? segment.key.childSessionId : null, phase, queued, execution, executions,
      executionKnown: observed || !!execution }
  }

  /** requestedMemberIds comes from the existing roster, only where already available. */
  function snapshot(parentSessionId: string, requestedMemberIds: Iterable<string> = []) {
    const members = parents.get(parentSessionId)
    const ids = new Set([...(members?.keys() ?? []), ...requestedMemberIds])
    const rows = Array.from(ids, memberId => {
      const member = members?.get(memberId)
      const current = segmentView(member?.current)
      const executions = Array.from(member?.segments.values() ?? []).flatMap(s => [...s.active])
      const lane = Array.from(member?.lane.values() ?? [])
      const phase: MemberActivityPhase = executions.length ? 'running' : lane.length ? 'queued' : current.phase
      const segments = Array.from(member?.segments.values() ?? [], s => segmentView(s))
      return { memberId, phase, current, executions, lane, segments }
    })
    return { parentSessionId, logEpoch, stateRev: currentStateRev(parentSessionId),
      runningMembers: rows.filter(row => row.phase === 'running').length, members: rows }
  }

  function rosterSnapshot(parentSessionId: string, roster: ReadonlyMap<string, object> | undefined) {
    const view = snapshot(parentSessionId)
    const recorded = parents.get(parentSessionId)
    const members = Array.from(roster ?? [], ([memberId, rosterId]) => {
      const member = recorded?.get(memberId)
      const current = segmentView(member?.current, rosterId)
      const segments = Array.from(member?.segments.values() ?? [], segment => segmentView(segment, rosterId)).filter(segment => segment.childSessionId !== null)
      const executions = segments.flatMap(segment => segment.executions)
      const lane = Array.from(member?.lane.values() ?? []).filter(turn => turn[MEMBER_ROSTER_ID] === rosterId)
      const phase: MemberActivityPhase = executions.length ? 'running' : lane.length || segments.some(segment => segment.queued.length) ? 'queued' : current.phase
      return { memberId, current, segments, executions, lane, phase }
    })
    const outsideRoster = view.members.flatMap(row => {
      const rosterId = roster?.get(row.memberId)
      const executions = row.executions.filter(execution => !rosterId || execution[MEMBER_ROSTER_ID] !== rosterId)
      return executions.length ? [{ memberId: row.memberId, executions }] : []
    })
    return { ...view, members, outsideRoster,
      configuredRunningMembers: roster ? members.filter(row => row.phase === 'running').length : null }
  }

  /** A selected chat window must use its actual child ID, not today's current segment. */
  function segmentSnapshot(key: MemberSegmentKey) {
    const segment = segments.get(key.childSessionId)
    const view = segment && segment.key.parentSessionId === key.parentSessionId && segment.key.memberId === key.memberId ? segment : undefined
    return { ...segmentView(view), ...key, logEpoch, stateRev: currentStateRev(key.parentSessionId) }
  }

  return { bind, selectCurrent, enqueueDispatch, discardDispatch, enqueue, discardQueued, start, finish, unbind, retire, snapshot, rosterSnapshot, segmentSnapshot }
}

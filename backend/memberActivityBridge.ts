import type { createMemberActivity, MemberExecution, MemberSegmentKey, MemberTurn } from './memberActivity.ts'

export type MemberInput = Readonly<{ key: MemberSegmentKey; turn: MemberTurn }>
type NativeAgent = { readonly signal?: AbortSignal; subscribe(listener: (event: { type: string }) => void): () => void }

export function createMemberActivityBridge(activity: ReturnType<typeof createMemberActivity>) {
  const queued = new WeakMap<object, MemberInput>()
  return {
    queuedInput: (item: object) => queued.get(item),
    admitQueue(item: object, input?: MemberInput) {
      if (!input) return
      queued.set(item, input)
      activity.enqueue(input.key, input.turn)
    },
    discardQueue(item: object) {
      const input = queued.get(item)
      if (!input) return
      queued.delete(item)
      activity.discardQueued(input.key, input.turn.turnId)
    },
    async native<T>(agent: NativeAgent, input: MemberInput | undefined, invoke: () => Promise<T>): Promise<T> {
      if (!input || agent.signal) return invoke()
      let token: MemberExecution | undefined
      let signal: AbortSignal | undefined
      let invoking = true
      const off = agent.subscribe(event => {
        const owner = agent.signal
        if (event.type === 'agent_start' && !token && owner && (invoking || owner === signal)) {
          token = activity.start(input.key, input.turn)
        }
      })
      try {
        const result = invoke()
        signal = agent.signal
        invoking = false
        return await result
      } finally {
        off()
        if (token) activity.finish(token)
      }
    },
    async external<T>(input: MemberInput | undefined, invoke: (started: () => void) => Promise<T>): Promise<T> {
      let token: MemberExecution | undefined
      try {
        return await invoke(() => { if (input && !token) token = activity.start(input.key, input.turn) })
      } finally {
        if (token) activity.finish(token)
      }
    },
  }
}

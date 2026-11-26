/** Temporary read-only agents are awaited tools of the current parent turn.
 * No TeamCtx, member session, blackboard, detached dispatch or return notification.
 * Only the model transport, tool implementations and immutable run verdict are shared.
 *
 * 契约（老板第7项）：一次 spawn_clone 调用里，每个子任务**只执行一次**，全部真实状态一次返回；
 * 工具不重派、也没有"每个分身最多 N 次模型轮"这类步数上限（跑完为止，停下只由取消负责）。
 * 要重派，由主助手拿到结果后**新发一次** spawn_clone（新 callId/新 runId，可只带失败的那一个）。
 * 模型层瞬时重试（限流/断连）是传输层语义，与这里的"是否重派子任务"无关。
 */
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { Agent, toFinishTurn, type AgentTool } from './agentCompat.ts'
import { judgeRunOutcome } from './runVerdict.ts'

export interface CloneContext {
  sessionId: string
  name: string
  presetId: string
  model: string
  workDir: string
  tools: AgentTool<any>[]
  createStream: (system: string, signal: AbortSignal, actor: string, onNote: (note: any) => void, tools: () => AgentTool<any>[]) => any
  publish: (callId: string, runs: CloneRun[]) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}
export interface CloneRun {
  runId: string
  callId: string
  memberId: string
  memberName: string
  memberPreset: string
  task: string
  model: string
  attempt: number
  status: 'running' | 'done' | 'error' | 'interrupted'
  startedAt: number
  endedAt?: number
  stopReason?: string
  text: string
  reasoning: string
  error?: string
  finalized: boolean
  segments: any[]
  tools: any[]
  usage?: any
  timing: { llmMs: number }
  retrying?: { attempt: number; reason: string }
}
const MAX_CLONES = Math.max(1, Math.min(20, Number(process.env.NIS_MAX_CLONES) || 3))
const slots = new Map<string, Set<number>>()
const active = new Map<string, Map<string, () => void>>()
export function isCloneRunActive(runId: string): boolean {
  for (const runs of active.values()) if (runs.has(runId)) return true
  return false
}
export function cancelClones(sessionId: string): void {
  for (const stop of active.get(sessionId)?.values() || []) stop()
}

// The safety boundary is enforced here, independently of member presets/tools.
/* ★1124：导出只为一个原因 —— 让单测能锁住"分身工具集里不许出现拉进程/写盘类工具"。
   这条边界原先只能靠人读这行代码保证；将来谁往白名单里加 run_command，没有东西会拦。 */
export const CLONE_READ_TOOLS = ['fs_read', 'fs_grep', 'list_dir', 'web_search', 'web_fetch', 'github_search', 'use_skill'] as const
const READ_TOOLS = new Set<string>(CLONE_READ_TOOLS)
const READ_ACTIONS: Record<string, string[]> = { repo: ['map', 'search'], memory: ['search'], knowledge: ['query'] }
export const CLONE_READ_ACTIONS: Readonly<Record<string, readonly string[]>> = READ_ACTIONS
export function readTools(tools: AgentTool<any>[]): AgentTool<any>[] {
  return tools.filter(t => READ_TOOLS.has(t.name) || t.name in READ_ACTIONS).map(t => {
    const allowed = READ_ACTIONS[t.name]
    if (!allowed) return t
    // Narrow both the schema and execution boundary: no hidden write actions.
    const parameters: any = structuredClone(t.parameters)
    parameters.properties.action = Type.Union(allowed.map(action => Type.Literal(action)))
    return { ...t, parameters, async execute(id: string, args: any, signal?: AbortSignal, update?: any) {
      if (!allowed.includes(args.action)) throw new Error(`${t.name}: 分身只允许 ${allowed.join('/')}`)
      return t.execute(id, args, signal, update)
    } }
  })
}

/** Ordered segments have backend-issued stable identities; the UI never assigns turn ownership. */
function capture(run: CloneRun, messages: any[]): void {
  const segments: any[] = []
  const calls = new Map<string, any>()
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]
    if (m.role === 'assistant') {
      for (const [bi, b] of (m.content || []).entries()) {
        const id = `${run.runId}:${mi}:${bi}`
        if (b.type === 'thinking') segments.push({ id, type: 'thinking', text: b.thinking })
        if (b.type === 'text') segments.push({ id, type: 'text', text: b.text })
        if (b.type === 'toolCall') {
          const s = { id: b.id, type: 'tool', toolCallId: b.id, name: b.name, args: b.arguments, status: 'running', result: '' }
          segments.push(s); calls.set(b.id, s)
        }
      }
      if (m.usage) {
        usage.input += Number(m.usage.input) || 0
        usage.output += Number(m.usage.output) || 0
        usage.cacheRead += Number(m.usage.cacheRead) || 0
        usage.cacheWrite += Number(m.usage.cacheWrite) || 0
      }
    } else if (m.role === 'toolResult') {
      const s = calls.get(m.toolCallId)
      if (s) {
        s.status = m.isError ? 'error' : 'done'
        s.result = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      }
    }
  }
  if (run.status !== 'running') for (const s of segments) if (s.type === 'tool' && s.status === 'running') s.status = 'error'
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  run.segments = segments
  run.tools = segments.filter(s => s.type === 'tool')
  run.reasoning = segments.filter(s => s.type === 'thinking').map(s => s.text).join('\n')
  run.usage = usage
  run.timing = { llmMs: (run.endedAt ?? Date.now()) - run.startedAt }
}

/** 一次工具调用内每个子任务只执行一次：本函数没有内部重跑，attempt 恒为 1。
 *  重派 = 主助手拿到结果后新发一次 spawn_clone（新 callId + 新 runId，天然可区分）。 */
async function runOnce(ctx: CloneContext, callId: string, slot: number, task: string, signal: AbortSignal | undefined, batch: CloneRun[]): Promise<CloneRun> {
  const run: CloneRun = {
    runId: randomUUID(), callId, memberId: `clone${slot}`, memberName: `${ctx.name} 分身`, memberPreset: ctx.presetId,
    task, model: ctx.model, attempt: 1, status: 'running', startedAt: Date.now(), text: '', reasoning: '', finalized: false,
    segments: [], tools: [], timing: { llmMs: 0 },
  }
  batch.push(run)
  const ac = new AbortController()
  let report = '', failure = '', partial: any = null, lastPublish = 0
  const findings: string[] = []
  const system = `你是「${ctx.name} 分身 #${slot}」，本次任务的一次性只读调研员，不是团队成员。\n工作目录：${ctx.workDir}\n只处理任务单；只能使用实际提供的只读工具，不能改文件、跑命令、派活或询问用户。\n中途发现可用 bb_write(finding=...) 保存；完成后用 bb_write(result=完整结论, finish=true) 交回主 agent。\n没有文件写入能力，不要声称已落盘。汇报必须包含证据位置或来源，遇阻如实报告。\n大文件先搜索再按行读，不要整份读取。`
  const reportTool: AgentTool<any> = {
    name: 'bb_write', label: '分身汇报', description: '本次分身的本地汇报（不是团队黑板）。finding 记录中途发现；result + finish:true 提交最终结果。',
    parameters: Type.Object({ finding: Type.Optional(Type.String()), result: Type.Optional(Type.String()), finish: Type.Optional(Type.Boolean()) }),
    async execute(_id, args: { finding?: string; result?: string; finish?: boolean }) {
      if (ac.signal.aborted) throw new Error('分身已停止')
      if (args.finding) findings.push(String(args.finding))
      if (args.result) report = String(args.result)
      if (args.finish) {
        if (!report.trim()) throw new Error('finish:true 必须带非空 result')
        run.finalized = true
      }
      return { content: [{ type: 'text', text: args.finish ? '已提交结果，本次分身结束。' : '已记录本次发现。' }], details: { finalized: run.finalized } }
    },
  }
  const agent = new Agent({
    streamFn: ctx.createStream(system, ac.signal, `${ctx.name} 分身 #${slot}`, note => {
      if (note.kind === 'retry') run.retrying = { attempt: note.attempt, reason: note.reason }
      else delete run.retrying
      if (note.kind === 'failed') failure = String(note.reason)
      ctx.publish(callId, batch)
    }, () => agent.state.tools),
    initialState: { systemPrompt: system, tools: [...readTools(ctx.tools), reportTool] },
    sessionId: run.runId,
    finishTurn: toFinishTurn(st => {
      /* 结束条件只有两种事实：模型自己不再要工具（自然 stop），或汇报里 finish:true 交卷。
         **没有轮数/步数上限** —— 分身读证据要用几轮就几轮，跑到完成；中途停下由取消（abort）负责。 */
      if (run.finalized) return true
      return String(st.message?.stopReason || '') !== 'toolUse'
    }),
    beforeToolCall: async tool => {
      ctx.log('info', `[分身 #${slot}] ${tool.toolCall.name}`)
      return undefined
    },
  })
  const messages = () => {
    const list: any[] = [...agent.state.messages]
    if (partial && !list.includes(partial)) list.push(partial)
    return list
  }
  const publish = () => { capture(run, messages()); ctx.publish(callId, batch) }
  const stop = () => {
    if (ac.signal.aborted) return
    run.status = 'interrupted'; run.stopReason = 'user'; run.endedAt = Date.now()
    ac.abort(); agent.abort(); publish()
  }
  let runs = active.get(ctx.sessionId)
  if (!runs) { runs = new Map(); active.set(ctx.sessionId, runs) }
  runs.set(run.runId, stop)
  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'message_start' || event.type === 'message_update') partial = event.message
    if (event.type === 'message_end') partial = null
    if (event.type === 'message_update' || event.type === 'message_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const now = Date.now()
      if (event.type !== 'message_update' || now - lastPublish >= 250) { lastPublish = now; publish() }
    }
  })
  signal?.addEventListener('abort', stop, { once: true })
  try {
    publish()
    if (signal?.aborted) stop()
    if (!ac.signal.aborted) await agent.prompt(task)
    const msgs = messages()
    const last: any = msgs.filter(m => m.role === 'assistant').at(-1)
    if (last?.stopReason === 'error') failure = String(last.errorMessage || '分身模型调用失败')
    run.text = report || msgs.filter(m => m.role === 'assistant').flatMap(m => m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    if (findings.length) run.text += '\n\n发现：\n' + findings.join('\n')
    const verdict = judgeRunOutcome({ output: run.text, llmFailed: failure, aborted: ac.signal.aborted, task, checkArtifactClaims: true, finalized: run.finalized })
    if (run.status === 'running') {
      run.status = verdict.ok ? 'done' : 'error'
      if (!verdict.ok) run.error = verdict.detail
    }
  } catch (error: any) {
    if (run.status === 'running') { run.status = 'error'; run.error = String(error.message || error) }
  } finally {
    signal?.removeEventListener('abort', stop)
    unsubscribe()
    run.endedAt ??= Date.now()
    delete run.retrying
    runs.delete(run.runId)
    if (!runs.size) active.delete(ctx.sessionId)
    publish()
  }
  return run
}

export function buildCloneTools(ctx: CloneContext): AgentTool<any>[] {
  return [{
    name: 'spawn_clone', label: '派出分身',
    description: `在当前用户轮内并行执行 1~${MAX_CLONES} 个互相独立的只读子任务。不是团队成员派活。工具会等全部分身结束，把每个分身的真实状态（完成/失败及原因）一次返回；主 agent 随后在同一轮汇总，不收轮、不发回归通知。每次调用对每个子任务**只执行一次**：失败的如实返回，工具不会自动重派。需要重派时，主 agent 收到结果后自己再发一次新的工具调用，可以只派失败的那一个（新调用=新 callId/新 runId，可区分）。分身不能改文件或跑命令，任务单须写清目标、边界、证据要求。模型层的瞬时重试（限流/断连）由传输层负责，与本工具无关。`,
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ task: Type.String({ description: '目标、边界与证据要求' }) }), { minItems: 1, maxItems: MAX_CLONES }) }),
    async execute(callId, params: { tasks: Array<{ task: string }> }, signal) {
      const tasks: Array<{ task: string }> = params.tasks
      if (!tasks.length || tasks.length > MAX_CLONES || tasks.some(t => !t.task.trim())) throw new Error(`分身必须是 1~${MAX_CLONES} 个非空只读任务`)
      signal?.throwIfAborted()
      const used = slots.get(ctx.sessionId) || new Set<number>()
      const free = Array.from({ length: MAX_CLONES }, (_, i) => i + 1).filter(n => !used.has(n))
      if (free.length < tasks.length) throw new Error('当前分身槽位不足，请等待当前调用结束')
      const own = free.slice(0, tasks.length)
      own.forEach(n => used.add(n)); slots.set(ctx.sessionId, used)
      const batch: CloneRun[] = []
      try {
        /* 只跑一次：不在这里重派任何失败。真实状态原样回给主助手，重派由它的下一次显式调用决定。 */
        const result = await Promise.all(tasks.map((t, i) => runOnce(ctx, callId, own[i], t.task, signal, batch)))
        const text = result.map(r => `[${r.memberName} #${r.memberId.slice(5)}] ${r.status}\n${r.error || ''}\n${r.text}`).join('\n\n')
        return { content: [{ type: 'text', text }], details: { spawned: tasks.length, completed: result.filter(r => r.status === 'done').length, aborted: result.some(r => r.status === 'interrupted') } }
      } finally {
        own.forEach(n => used.delete(n))
        if (!used.size) slots.delete(ctx.sessionId)
      }
    },
  }]
}

import { aggregateMemberUsage, type MemberUsageSegmentRow } from './memberUsageAggregate.ts'

type ParentTotals = { uncached: number; cacheRead: number; cacheWrite: number; output: number }

function counters(uncached: number, cacheRead: number, cacheWrite: number, output: number) {
  const input = uncached + cacheRead + cacheWrite
  return { input, output, cacheRead, cacheWrite, hitRate: input > 0 ? Math.round(cacheRead / input * 100) : null }
}

/** One row of the existing C ledger (`review_execution`), joined to the work item it belongs to.
 * `usage` is whatever the provider actually returned for that call — null means "no receipt".
 * ⚠ 这里是**四桶互斥**形态：`input` 是**未命中**输入（pi-ai 的 `openai-completions.js` 在解析回执时
 * 已经扣掉 cacheRead/cacheWrite 或从 details 里拆开），`cacheRead`/`cacheWrite` 各自独立。
 * 投影出来的 `known.input` 才是**完整输入** = 未命中 + 缓存读 + 缓存写，不要在这里再扣一次。 */
export type VerificationRecord = {
  requestId: number
  providerId: string
  model: string
  status: 'opinion' | 'stale' | 'invalid-output' | 'model-error'
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
}

type Bucket = { uncached: number; cacheRead: number; cacheWrite: number; output: number }

/** C's own ledger, aggregated once. Every recorded row is one real model call — a stale opinion,
 * an unparseable output or a provider error still cost tokens, so they are counted; a call that was
 * blocked before the request never wrote a row and therefore never appears here.
 * Missing usage is reported as incomplete, never folded into a zero. */
export function projectVerificationUsage(records: readonly VerificationRecord[]) {
  const empty: Bucket = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const add = (b: Bucket, u: VerificationRecord['usage']) => {
    // The executor reports `input` as the uncached prompt tokens and the cache buckets separately.
    b.uncached += u!.input
    b.cacheRead += u!.cacheRead
    b.cacheWrite += u!.cacheWrite
    b.output += u!.output
  }
  const usable = (u: VerificationRecord['usage']) => !!u &&
    [u.input, u.output, u.cacheRead, u.cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)

  const total = { ...empty }
  const models = new Map<string, { providerId: string; model: string; calls: number; withUsage: number; unknownUsage: number; bucket: Bucket }>()
  const byRequest = new Map<number, { calls: number; withUsage: number; unknownUsage: number; bucket: Bucket }>()
  let withUsage = 0
  let unknownUsage = 0
  for (const record of records) {
    if (!Number.isSafeInteger(record.requestId) || record.requestId < 1) throw new Error('Invalid verification record owner')
    if (!record.providerId || !record.model) throw new Error('Invalid verification record model identity')
    const known = usable(record.usage)
    if (known) { add(total, record.usage); withUsage++ } else unknownUsage++
    const modelKey = record.providerId + '\u0000' + record.model
    let model = models.get(modelKey)
    if (!model) {
      /* 模型身份来自该次实际执行记录，不读当前配置 —— 换模型后旧执行仍显示旧模型。 */
      model = { providerId: record.providerId, model: record.model, calls: 0, withUsage: 0, unknownUsage: 0, bucket: { ...empty } }
      models.set(modelKey, model)
    }
    model.calls++
    if (known) { add(model.bucket, record.usage); model.withUsage++ } else model.unknownUsage++
    let owner = byRequest.get(record.requestId)
    if (!owner) { owner = { calls: 0, withUsage: 0, unknownUsage: 0, bucket: { ...empty } }; byRequest.set(record.requestId, owner) }
    owner.calls++
    if (known) { add(owner.bucket, record.usage); owner.withUsage++ } else owner.unknownUsage++
  }
  const shape = (b: Bucket) => counters(b.uncached, b.cacheRead, b.cacheWrite, b.output)
  const calls = records.length
  return {
    // `partial` = called but at least one call has no usage receipt; `recorded` = every call has one.
    status: calls === 0 ? 'no-records' as const : unknownUsage > 0 ? 'partial' as const : 'recorded' as const,
    calls,
    withUsage,
    unknownUsage,
    known: calls > 0 && withUsage > 0 ? shape(total) : null,
    models: [...models.values()].map(m => ({
      providerId: m.providerId, model: m.model, calls: m.calls, withUsage: m.withUsage, unknownUsage: m.unknownUsage,
      known: m.withUsage > 0 ? shape(m.bucket) : null,
    })),
    /* 需求级归属契约（同一份账本，按工单切开）：界面本轮没有需求详情入口，这里先给出口径。 */
    byRequest: Object.fromEntries([...byRequest.entries()].map(([requestId, v]) => [requestId, {
      calls: v.calls, withUsage: v.withUsage, unknownUsage: v.unknownUsage,
      known: v.withUsage > 0 ? shape(v.bucket) : null,
    }])),
  }
}

/** ★1124（老板要"主 agent 的消耗结合这三个看才准确"）：把主会话消耗里**后台协调**那部分拆出来。
 *
 *  归因口径（写死，不许含糊）：
 *   · **按轮归因**——一轮里只要出现过 `team_v2_*` 工具调用，该轮 assistant 消息的 usage **整轮**计入"协调"
 *     （同轮既协调又干了别的，也整轮算协调；这条口径比"按比例拆"诚实，因为 token 本来就是整轮一次的请求）。
 *   · usage 来源 = **每条 assistant 消息自带的 `usage`**（`message_end` 的权威值），
 *     不是拿会话累计值去估算 —— 累计值没法拆轮，估算就是编数。
 *   · 没调用过团队工具 / 消息上没有 usage ⇒ 如实返回 `no-records` 或 `unavailable`，不补 0 冒充。 */
export function projectCoordinationUsage(messages: readonly any[]) {
  let turns = 0
  let calls = 0
  let withUsage = 0
  const bucket = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let inCoordinationTurn = false
  for (const m of messages) {
    if (!m) continue
    if (m.role === 'user') { inCoordinationTurn = false; continue }
    if (m.role !== 'assistant') continue
    const blocks: any[] = Array.isArray(m.content) ? m.content : []
    const toolCalls = blocks.filter(b => b && b.type === 'toolCall')
    const teamCalls = toolCalls.filter(b => String(b.name || '').startsWith('team_v2_'))
    if (teamCalls.length) {
      if (!inCoordinationTurn) { inCoordinationTurn = true; turns++ }
      calls += teamCalls.length
    }
    if (!inCoordinationTurn) continue
    const u = m.usage
    if (!u || typeof u !== 'object') continue
    const output = Number(u.output ?? u.output_tokens ?? 0)
    const cacheRead = Number(u.cacheRead ?? u.cache_read_tokens ?? 0)
    const cacheWrite = Number(u.cacheWrite ?? u.cache_write_tokens ?? 0)
    const prompt = Number(u.input ?? u.prompt_tokens ?? 0)
    if (![output, cacheRead, cacheWrite, prompt].every(Number.isFinite)) continue
    /* 未命中 = prompt 里没被缓存吃掉的部分（与服务端其它口径一致：net = prompt - cacheRead） */
    bucket.uncached += Math.max(0, prompt - cacheRead)
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    bucket.output += output
    withUsage++
  }
  if (!calls) return { status: 'no-records' as const, turns: 0, calls: 0, withUsage: 0, known: null }
  if (!withUsage) return { status: 'unavailable' as const, turns, calls, withUsage: 0, known: null }
  return {
    status: (withUsage < turns ? 'partial' : 'recorded') as 'partial' | 'recorded',
    turns, calls, withUsage,
    known: counters(bucket.uncached, bucket.cacheRead, bucket.cacheWrite, bucket.output),
  }
}

/** Views of existing ledgers, not extra charges and not an estimate of model cost. */
export function projectTeamV2Usage(
  parent: ParentTotals | undefined,
  rows: readonly MemberUsageSegmentRow[],
  parentId: string,
  verification: readonly VerificationRecord[] = [],
  coordination: ReturnType<typeof projectCoordinationUsage> | null = null,
) {
  // The parent ledger may be initialized by timing alone; all-zero does not prove a provider receipt.
  const values = parent ? [parent.uncached, parent.cacheRead, parent.cacheWrite, parent.output] as const : undefined
  const main = values && values.every(n => Number.isSafeInteger(n) && n >= 0) && values.some(n => n > 0)
    ? { status: 'recorded' as const, ...counters(...values) }
    : { status: 'unavailable' as const }
  const member = aggregateMemberUsage(rows.filter(r => r.parentSessionId === parentId && !/^clone\d+$/i.test(r.memberId)))
  const members = {
    status: member.status === 'none' || member.status === 'empty' ? 'no-records' as const : member.status,
    missingSegments: member.missingSegments,
    known: member.readableSegments > 0
      ? counters(member.promptTokens, member.cacheReadTokens, member.cacheWriteTokens, member.completionTokens)
      : null,
  }
  /* C 的账本只在这里汇总一次：不并入 main / members（那是另外两次真实的模型调用），
     也不因为意见过期或输出非法而抹掉已经发生的消耗。
     ★1124：coordination 从常量 'included-in-main' 改成**按轮归因的真实数值**（老板要真实数值）；
     没有可归因的轮次时如实说 no-records，不填 0 冒充。 */
  return {
    main, members,
    coordination: coordination ?? { status: 'no-records' as const, turns: 0, calls: 0, withUsage: 0, known: null },
    inclusionNote: 'included-in-main' as const,
    verification: projectVerificationUsage(verification),
  }
}

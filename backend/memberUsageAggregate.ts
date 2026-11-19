/** 成员用量**纯聚合**（唯一口径）—— 无 IO、无会话依赖、可单测。
 *
 *  ## 为什么单独一个文件
 *  账本读数原来散在 `server.ts` 的三个函数里（`buildMemberUsageLedgerTotal` /
 *  `readMemberCurrentSegmentTotal` / `readMemberSegmentUsages`），每个都各自 `findMemberSession`
 *  ⇒ 出现"所谓全历史其实只读未归档段"的病灶。聚合一收口到这里，server 只负责
 *  "把会话对象映射成 SegmentRow"（IO），"怎么加、怎么算命中率"只有这一份。
 *
 *  ## 口径（拍板过的，别再各算一套）
 *  · **三个互斥输入桶** = `uncached`（未命中普通输入）+ `cacheRead`（缓存读）+ `cacheWrite`（缓存写），
 *    三者互斥、相加 = 完整 prompt（证据见 pi-ai：openai-completions.js:1178 `input = prompt - read - write`、
 *    openai-responses-shared.js:446、google-generative-ai.js:171；Anthropic/Bedrock 由供应商语义保证
 *    `input_tokens` 不含 cache_read/cache_creation，pi-ai anthropic-messages.js:464-466 三桶并列）。
 *  · **全历史累计** = 同一 `(parentSessionId, memberId)` 的**全部段**（当前未归档 + 已归档），
 *    每段读自己的 `usageTotals` 再相加。⚠️ 不读 `bb.runs`（60 条封顶，且私聊根本没有 run 记录）。
 *  · **当前段** = 未归档段里 `memberSessionSeq` 最大者（同号再比 `updatedAt`）——
 *    不再依赖 Map 迭代顺序（原来 `findMemberSession` 是"第一个碰上的"，多段异常时不稳）。
 *  · **命中率** = ΣcacheRead ÷ (Σuncached + ΣcacheRead + ΣcacheWrite)，**先求和再相除**。
 *    分母就是"完整输入量"（三桶互斥相加，见上一条的证据），也就是供应商账单里的输入总量 —— 老板已确认这个公式。
 *    ⛔ 不要把 cacheWrite 从分母里摘出去（那会把首次长 prompt 的写入当成"没发生过"，得到虚高的命中率）；
 *    ⛔ 禁止对每段百分比取平均（段长差异可以让 90% 与 10% 平均成 50%，与真实 10% 差 40pp）。
 *
 *  ## 缺 / 零 / 未知 必须分开（不允许把部分和冒充全量）
 *  · `hasLedger` = 该段有 `usageTotals` 对象（账本写到了，含真 0）；
 *  · `!hasLedger && hasAssistant` = **账本没写但有对话** ⇒ 该段数字不可信，计入 `missingSegments`；
 *  · `!hasLedger && !hasAssistant` = 新段一次都没跑过 ⇒ 真 0（计入 `emptySegments`）；
 *  · `status`：`none`（没有任何段）/ `complete`（每段都可读）/ `partial`（有缺账段，合计是部分和）/ `empty`（全是真空段）。
 */

/** 一段的读取结果（server 侧的 IO 产物；纯函数只认这个形状） */
export interface MemberUsageSegmentRow {
  /** 父团队会话 id（归属键之一；跨父会话**绝不**混算） */
  parentSessionId: string
  /** 成员身份（`m1`/`clone1`…；同一父会话内稳定） */
  memberId: string
  /** 这一段自己的会话 id（去重键：同一段被遍历两次只算一次） */
  sessionId: string
  /** 段号（`memberSessionSeq`，归档也占号；0 = 未知/老数据） */
  seq: number
  archived: boolean
  updatedAt?: number
  /** 账本对象存在（`usageTotals` 是对象，哪怕是全 0） */
  hasLedger: boolean
  /** 有 assistant 消息（用来区分"真 0"与"账本没写"） */
  hasAssistant: boolean
  /** ★重启骨架：正文还没升级上来 ⇒ 既不能当"有账本"，也不能当"没跑过" */
  skeleton?: boolean
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  turns: number
  llmMs: number
}

/** 累计可信度：完整 / 部分（有缺账段）/ 真空段 / 没有任何段 */
export type MemberUsageStatus = 'complete' | 'partial' | 'empty' | 'none'
/** 缓存信号的**可证明边界**（不猜"供应商支不支持"，只说看到了什么） */
export type MemberCacheSignal = 'hit' | 'write-only' | 'never' | 'none'

export interface MemberUsageTotalsView {
  /** 全历史 token（= uncached + cacheRead + cacheWrite + output，只含可读段） */
  tokens: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmMs: number
  runs: number
  /** 全历史命中率（整数百分比）= ΣcacheRead ÷ (Σuncached + ΣcacheRead + ΣcacheWrite)；
   *  分母 0 ⇒ null（不可计算，显示「—」；注意"只写未命中"不是 null，是真实的 0%）。 */
  hitRate: number | null
  /** 命中率分母 = Σ(uncached + cacheRead + cacheWrite)（= 完整输入量），让调用方/排查看得见"怎么算出来的" */
  hitDenominator: number
  status: MemberUsageStatus
  cacheSignal: MemberCacheSignal
  /** 段数（全部）/ 可读段（账本在）/ 真空段 / 缺账段 / 重复未归档段（>1 个未归档 = 数据异常，不静默） */
  segments: number
  readableSegments: number
  emptySegments: number
  missingSegments: number
  duplicateActive: number
  /** 当前段（未归档里 seq 最大）的 id 与合计；没有未归档段 ⇒ ''/null */
  currentSessionId: string
  currentSeq: number
  currentTokens: number | null
}

/** 段选择：未归档里 `seq` 最大（同号再比 `updatedAt`，再比 sessionId 保证确定性） */
export function pickCurrentRow<T extends { archived: boolean; seq: number; updatedAt?: number; sessionId: string }>(segs: readonly T[]): T | null {
  let best: T | null = null
  for (const s of segs) {
    if (s.archived) continue
    if (!best) { best = s; continue }
    if (s.seq !== best.seq) { if (s.seq > best.seq) best = s; continue }
    if ((s.updatedAt || 0) !== (best.updatedAt || 0)) { if ((s.updatedAt || 0) > (best.updatedAt || 0)) best = s; continue }
    if (s.sessionId > best.sessionId) best = s
  }
  return best
}

const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/** server 侧会话对象的最小形状（只列聚合要用到的字段，避免把 SessionStore 的类型拖进纯模块） */
export interface SessionLike {
  id?: string
  parentSessionId?: string
  memberId?: string
  memberSessionSeq?: number
  archived?: boolean
  updatedAt?: number
  usageTotals?: { uncached?: number; cacheRead?: number; cacheWrite?: number; output?: number; turns?: number; llmMs?: number } | null
  messages?: Array<{ role?: string }> | null
  /** ★重启骨架标记：启动走索引快路径时放的是"只有元数据"的骨架（既没有 usageTotals 也没有 messages）。
   *  ⚠️ 它**不等于"这段没跑过"** —— 正文还没升级上来而已，必须按"读不到"处理，不许算成真 0。 */
  _skeleton?: boolean
}

/** **会话对象 → 段行**（纯映射，唯一一份）。
 *  为什么抽出来：字段名映射（`uncached → uncached`、`messages 里有没有 assistant`、`archived`）
 *  原来散在 server 的读函数里，测试只能"复制一份逻辑"去验 —— 复制出来的一定会漂。
 *  现在 server 只负责"遍历 + 骨架升级"，映射规则在这里被单测覆盖（含重启骨架：没有 usageTotals）。 */
export function sessionToSegmentRow(s: SessionLike | null | undefined, parentSessionId: string): MemberUsageSegmentRow | null {
  if (!s || !parentSessionId) return null
  if (String(s.parentSessionId || '') !== parentSessionId) return null
  const memberId = String(s.memberId || '')
  if (!memberId) return null
  const ut = s.usageTotals
  const hasLedger = !!ut && typeof ut === 'object'
  const hasAssistant = Array.isArray(s.messages) && s.messages.some((m) => String(m?.role || '') === 'assistant')
  return {
    parentSessionId,
    memberId,
    sessionId: String(s.id || ''),
    seq: num(s.memberSessionSeq),
    archived: s.archived === true,
    updatedAt: num(s.updatedAt),
    hasLedger,
    hasAssistant,
    skeleton: s._skeleton === true,
    /* 没有账本的段：**所有桶都给 0 但 hasLedger=false** —— 下游据此判"不可信"，不会把 0 当真值。 */
    uncached: hasLedger ? num(ut!.uncached) : 0,
    cacheRead: hasLedger ? num(ut!.cacheRead) : 0,
    cacheWrite: hasLedger ? num(ut!.cacheWrite) : 0,
    output: hasLedger ? num(ut!.output) : 0,
    turns: hasLedger ? num(ut!.turns) : 0,
    llmMs: hasLedger ? num(ut!.llmMs) : 0,
  }
}

/** 单成员聚合（输入是**已经按父会话过滤好**的该成员全部段） */
export function aggregateMemberUsage(segs: readonly MemberUsageSegmentRow[]): MemberUsageTotalsView {
  /* 同一 sessionId 只算一次 —— 防"同一段被遍历两次"或调用方传了重复行导致双计。
     同一 (parent, member) 下若真的存在两条不同 sessionId 的未归档段，那是**数据异常**：
     都计入累计（都是真账本），但 `duplicateActive` 明确报数，由展示层决定怎么提示。 */
  const uniq = new Map<string, MemberUsageSegmentRow>()
  for (const s of segs) if (!uniq.has(s.sessionId)) uniq.set(s.sessionId, s)
  const list = [...uniq.values()]

  let tokens = 0, uncached = 0, cacheRead = 0, cacheWrite = 0, output = 0, llmMs = 0, runs = 0
  let readable = 0, empty = 0, missing = 0
  for (const s of list) {
    if (!s.hasLedger) {
      /* 不可读的段：**一个字节都不加**（加 0 就是拿"没账"冒充"用了 0"）。
         有 assistant 或"重启骨架（正文还没升级）" ⇒ 缺账（partial，数字不完整）；
         两者都不是 ⇒ 这段确实一次都没跑（真空段，真 0）。 */
      if (s.hasAssistant || s.skeleton) missing += 1
      else empty += 1
      continue
    }
    readable += 1
    uncached += num(s.uncached)
    cacheRead += num(s.cacheRead)
    cacheWrite += num(s.cacheWrite)
    output += num(s.output)
    llmMs += num(s.llmMs)
    runs += num(s.turns)
  }
  tokens = uncached + cacheRead + cacheWrite + output

  /* ★公式（老板已确认）：命中率 = Σ缓存读 ÷ (Σ未命中 + Σ缓存读 + Σ缓存写)，分母 = 完整输入量。
     三个互斥输入桶相加就是供应商账单的输入总量；把缓存写摘出去会得到虚高的命中率
     （例：普通 100 / 读 100 / 写 800 ⇒ 正确 10%，摘掉写就成了 50%）。 */
  const hitDenominator = uncached + cacheRead + cacheWrite
  const hitRate = hitDenominator > 0 ? Math.round((cacheRead / hitDenominator) * 100) : null
  const cacheSignal: MemberCacheSignal = readable === 0
    ? 'none'
    : cacheRead > 0 ? 'hit'
      : cacheWrite > 0 ? 'write-only'
        : 'never'

  const status: MemberUsageStatus = list.length === 0
    ? 'none'
    : missing > 0 ? 'partial'
      : readable === 0 ? 'empty'
        : 'complete'

  const activeCount = list.filter(s => !s.archived).length
  const cur = pickCurrentRow(list)
  const curRow = cur && cur.hasLedger ? cur : null

  return {
    tokens,
    promptTokens: uncached,
    completionTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    llmMs,
    runs,
    hitRate,
    hitDenominator,
    status,
    cacheSignal,
    segments: list.length,
    readableSegments: readable,
    emptySegments: empty,
    missingSegments: missing,
    duplicateActive: activeCount > 1 ? activeCount - 1 : 0,
    currentSessionId: cur ? cur.sessionId : '',
    currentSeq: cur ? num(cur.seq) : 0,
    currentTokens: curRow ? num(curRow.uncached) + num(curRow.cacheRead) + num(curRow.cacheWrite) + num(curRow.output) : null,
  }
}

/** `session.memberUsageDetail` 的 `totals` 字段形状（详情出口与黑板出口必须同源，所以构造也放这里） */
export interface MemberUsageDetailTotals {
  tokens: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmMs: number
  runs: number
  hitRate: number | null
  hitDenominator: number
  status: MemberUsageStatus
  cacheSignal: MemberCacheSignal
  segments: number
  readableSegments: number
  emptySegments: number
  missingSegments: number
  duplicateActive: number
}

/** 视图 → 详情 RPC 的 totals（`none` ⇒ null：没有任何段就不该有"合计"） */
export function detailTotalsFromView(v: MemberUsageTotalsView | null | undefined): MemberUsageDetailTotals | null {
  if (!v || v.status === 'none') return null
  return {
    tokens: v.tokens,
    promptTokens: v.promptTokens,
    completionTokens: v.completionTokens,
    cacheReadTokens: v.cacheReadTokens,
    cacheWriteTokens: v.cacheWriteTokens,
    llmMs: v.llmMs,
    runs: v.runs,
    hitRate: v.hitRate,
    hitDenominator: v.hitDenominator,
    status: v.status,
    cacheSignal: v.cacheSignal,
    segments: v.segments,
    readableSegments: v.readableSegments,
    emptySegments: v.emptySegments,
    missingSegments: v.missingSegments,
    duplicateActive: v.duplicateActive,
  }
}

/** 把聚合结果写到 `memberTotals[memberId]` 那种记录上（server 与 teamRuntime **共用这一份映射**，
 *  避免"黑板 RPC 写一套、广播帧写另一套"）。只写派生的展示字段，不碰任何持久事实。 */
export function applyUsageViewToRecord(rec: Record<string, any>, v: MemberUsageTotalsView): void {
  rec.promptTokens = Math.round(v.promptTokens)
  rec.completionTokens = Math.round(v.completionTokens)
  rec.cacheReadTokens = Math.round(v.cacheReadTokens)
  rec.cacheWriteTokens = Math.round(v.cacheWriteTokens)
  rec.tokens = Math.round(v.tokens)
  rec.llmMs = Math.round(v.llmMs)
  /* turns 为 0（老会话没记轮数）时**保留原 runs 条数** —— 不拿 0 覆盖真实条数 */
  if (v.runs > 0) rec.runs = Math.round(v.runs)
  /* ★统一命中率：分子分母都来自后端（前端只显示，不再各除一次） */
  rec.hitRate = v.hitRate
  rec.hitDenominator = Math.round(v.hitDenominator)
  /* ★完整度：complete / partial（有缺账段，合计是部分和）/ empty（全是未跑过的新段）/ none */
  rec.usageStatus = v.status
  rec.cacheSignal = v.cacheSignal
  rec.segments = v.segments
  rec.readableSegments = v.readableSegments
  rec.missingSegments = v.missingSegments
  rec.duplicateActive = v.duplicateActive
  if (v.currentSessionId) rec.usageCurrentSessionId = v.currentSessionId
  else delete rec.usageCurrentSessionId
  rec.source = v.status === 'empty' ? 'empty' : 'ledger'
}

/** **把整张视图并入 `memberTotals`**（补键 + 覆盖 + 残值标记）——
 *  广播帧（`mergeMemberUsageLedger`）与黑板 RPC（`blackboard.read`）共用这一份，杜绝两条路径写出两套字段。
 *
 *  两条规则：
 *   ① 视图里有、记录里没有的成员 ⇒ **补键**（"只私聊过、没有 run 记录"的成员靠这一步才出现）；
 *   ② 记录里有、视图里没有的成员（成员会话被删/回收）⇒ 保留 runs 残值，但标 `source:'runs'` +
 *      `usageStatus:'none'` 并删掉命中率（那些是从没人算过的字段，留着会被当成账本值）。 */
export function mergeViewsIntoMemberTotals(totals: Record<string, any>, views: Map<string, MemberUsageTotalsView>): void {
  const seen = new Set<string>()
  for (const [mid, v] of views) {
    seen.add(mid)
    if (!totals[mid] || typeof totals[mid] !== 'object') totals[mid] = {}
    applyUsageViewToRecord(totals[mid], v)
  }
  for (const mid of Object.keys(totals)) {
    if (seen.has(mid)) continue
    const rec: any = totals[mid]
    if (!rec || typeof rec !== 'object') continue
    rec.source = 'runs'
    rec.usageStatus = 'none'
    delete rec.hitRate
    delete rec.hitDenominator
    delete rec.cacheSignal
  }
}

/** 读取层 → 视图：先按**父会话**过滤（跨父同名成员绝不混算），再按 memberId 分组聚合。
 *  返回值键 = 该父会话下**真实存在成员会话**的 memberId —— 包含"只私聊过、从没被派活"的成员
 *  （它们的消耗在账本里，但 `bb.runs` 里没有记录；原来这种成员连一行都不出现）。 */
export function collectMemberUsageViews(rows: readonly MemberUsageSegmentRow[], parentSessionId: string): Map<string, MemberUsageTotalsView> {
  const byMember = new Map<string, MemberUsageSegmentRow[]>()
  for (const r of rows) {
    if (r.parentSessionId !== parentSessionId) continue
    if (!r.memberId) continue
    const arr = byMember.get(r.memberId)
    if (arr) arr.push(r)
    else byMember.set(r.memberId, [r])
  }
  const out = new Map<string, MemberUsageTotalsView>()
  for (const [mid, segs] of byMember) out.set(mid, aggregateMemberUsage(segs))
  return out
}

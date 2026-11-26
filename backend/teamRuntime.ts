/**
 * 团队运行时（P2）—— 黑板 + 子 agent（同步阻塞式，Claude Code Task 模式）
 *
 * 心智（docs/team-mode-plan.md 定稿）：
 *  - 黑板是唯一事实源：goal/plan/findings/final 全落 backend/data/blackboard/<sessionId>.json（按会话键控隔离）
 *    · 计划带**代次 planRev**：bb_goal 每次全量重写 +1，落盘只认更高代次（旧计划步骤随之作废）
 *  - 派活不阻塞：team_dispatch 立即回执，成员在**每人一条串行车道**里跑，跑完按 callId 结算、
 *    以「团队回归」通知叫回主 agent（同一个成员同一时刻只干一件事，多派给他的排队）
 *  - 派发硬校验（**逐项**判定）：step 必须属于当前计划、owner 必须与成员一致、deps 必须 done；
 *    非法项单独拒绝并列名回报，合法项照派；同一 step 不得重复派
 *  - 打回 ≤2：同一步骤累计派发 3 次后拒绝再派，主 agent 必须把产出对比上抛用户
 *  - 子 agent 权限：不走权限卡（工作目录限会话工作区，主 agent 结果审核制）；工具 = 成员预设 tools
 *    白名单 + bb_write（只能汇报自己的步骤）；无派发权/无黑板管理权
 *  - 成员上下文精准打包（防爆窗）：团队清单 + 黑板快照 + 任务单，不共享主对话历史、不共享彼此上下文
 */
import fs from 'node:fs'
import path from 'node:path'
import { Agent } from './agentCompat.ts'
import type { AgentTool } from './agentCompat.ts'
import { toFinishTurn } from './agentCompat.ts'
import { Type } from 'typebox'
import { matchIndiscriminateKillCommand } from './processGuard.ts'
import { releaseRun as releaseFileLocks, detectDispatchOverlap } from './fileLocks.ts'
import { DATA_ROOT } from './paths.ts'
import { readAgentPreset } from './agentPresetsStore.ts'
import { writeJsonAtomic } from './jsonStore.ts'
import { swallowed } from './swallowed.ts'
/* ★f1b（P0-3）：run 终态判决的唯一口径（团队路径与分身路径共用同一个函数） */
import { judgeRunOutcome } from './runVerdict.ts'
import type { TeamDef, TeamMember } from './teamsStore.ts'
/* ★member-lifetime：成员用量**唯一口径**（纯聚合 + 唯一的字段映射）—— 
   广播帧与 `blackboard.read` 必须写同一套字段，所以映射函数也共用这一份。 */
import { mergeViewsIntoMemberTotals, type MemberUsageTotalsView } from './memberUsageAggregate.ts'

// ============================================================================
// 黑板存储（backend/data/blackboard/<sessionId>.json，按会话键控）
// ============================================================================

type StepStatus = 'pending' | 'running' | 'review' | 'done' | 'rejected' | 'failed' | 'interrupted'

/** ★t1x：**执行证据**的终态集合 —— 这些状态都代表"这条 run 真的跑过"。
 *  刻意含 `interrupted`：用户点停止 / 看门狗 / **后端重启自愈**都会把它写成 interrupted，
 *  而成员其实已经跑完并上报了（step.result 有产出、步骤停在 review）。
 *  刻意不含 `running`（还在跑 = 还没有结果，不能审核）与 `error`（这趟没跑完，产物只是半截）。
 *  审核闸门（bb_write step done）/黑板自愈/封顶固化**共用这一份口径**，不再各写一套。 */
const EXEC_EVIDENCE_STATUS = new Set(['done', 'timeout', 'interrupted'])

/** ★f1b（P1）：**未收尾**步骤的口径 —— 原只数 pending/running/review，漏掉 failed/interrupted/rejected
 *  （三者都有真实写入口）⇒ 一批活跑完但其中有失败/被中断/被打回的步骤时，回归通知照样写
 *  "（全队计划已全部收尾）"，主 agent 当场就信了（a3x 报的 P0）。 */
const UNFINISHED_STEP_STATUS = new Set(['pending', 'running', 'review', 'failed', 'interrupted', 'rejected'])
export function countPendingLeft(steps: any[] | undefined): number {
  /* ★hint1：**已被取代的僵尸步骤不计入未收尾** —— 否则回归通知永远说"全队还有 N 项未收尾"，
     而那个 N 就是 dk11/dk12/ds1b 这种早被取代的旧步骤（与「需重派」误报同一个根因）。 */
  return (steps || []).filter((st: any) => UNFINISHED_STEP_STATUS.has(String(st?.status || '')) && !String((st as any)?.supersededBy || '').trim()).length
}

/** ★t1x：审核闸门的**唯一判据**（导出以便直接测真代码，不在测试里抄一份逻辑）。
 *  「步骤真的被执行过」= 下列任一：
 *   a) runs 里有该步的终态记录（interrupted 也算；running 不算）；
 *   b) 步骤停在 review —— `runStepTask` 在成员跑完后亲手写的；
 *   c) `step.executedAt` —— 执行路径落的持久证据（runs 被 60 条封顶裁掉、被重启自愈覆盖也查得到）。
 *  三条全都只有执行路径（team_dispatch → 车道 → runStepTask / runSubAgent）能写，
 *  `bb_goal`（重写计划只会得到新对象）/ `bb_write` 都伪造不出来 ⇒ 防假完成的原意不变。 */
/** ★f1b（P0-2）：步骤有没有**产出证据**（成员经 bb_write 落进 step.result 的汇报正文）。 */
export function stepHasOutput(step: any): boolean {
  return String((step as any)?.result ?? '').trim().length > 0
}

/** ★f1b（P0-2）：**某条 run 能不能算「这步真的执行过」** —— 闸门与自愈固化共用这一份口径。
 *   · done / timeout ⇒ 算（这趟跑到了终态）；
 *   · interrupted   ⇒ **必须有产出证据**才算 —— 它可能只是"跑到一半被杀"（用户点停止 / 后端重启自愈 /
 *     看门狗），那时产物是半截的、甚至零产出；t1x 为修"永久卡死"把它一律放行，等于让零产出混过审核闸门；
 *   · running / error ⇒ 不算。 */
export function runCountsAsExecuted(run: any, step: any): boolean {
  const st = String(run?.status || '')
  if (!EXEC_EVIDENCE_STATUS.has(st)) return false      // running / error / 空 ⇒ 不算
  if (st === 'interrupted') return stepHasOutput(step) // 半路被打断 ⇒ 必须有产出才算
  return true                                          // done / timeout ⇒ 跑到终态了
}

function runMatchesStep(run: any, step: any): boolean {
  return !!step?.runId && step.runId === (run?.runId || run?.id) && step.id === run?.stepId && step.owner === run?.memberId
}



export interface BlackboardStep {
  id: string
  text: string
  deps: string[]
  owner: string
  status: StepStatus
  attempts: number
  result?: string
  artifacts?: string[]
  feedback?: string
  runId?: string
  executedAt?: number
  /** ★nb1：**派发留痕**（team_dispatch 通过全部硬校验后写入的毫秒时间戳）。
   *  病因：step.status 在"已派出、但还在成员车道上排队"期间仍是 `pending`（车道是内存态、黑板看不出来）
   *  ⇒ 回归通知里的「下一步建议」只能把她当成"从没派过"，于是把**排队中**误报成**待派发**（实测）。
   *  只有这个**持久**字段能区分两者 —— 派发侧必须落盘（见 team_dispatch 里的 `_dispatched`）。
   *  刻意不加 `status='queued'`：StepStatus 被未收尾口径/审核闸门/计划卡/前端共用，
   *  多一个值要改十几处、还要防旧数据不认识它；一个时间戳字段能表达同一件事且零兼容成本。 */
  dispatchedAt?: number
  /** ★hint1：**被谁取代**（派发侧 `team_dispatch(supersedes:['旧id'])` 写到旧步骤上，值＝新步骤 id）。
   *  与 `dispatchedAt` 同性质：**事实字段**，不靠 stepId 命名规律猜。
   *  status 刻意不动（未收尾口径/审核闸门/计划卡/前端都认 status）—— 它只用来让「下一步建议」剔除僵尸。 */
  supersededBy?: string
  updatedAt?: number
}

/** ★bd1：**待确认（decision）** —— 老板 1105 拍板：**只有 open 一种状态**，不加 answered。
 *  答"做" ⇒ 变成一条计划步骤（进 steps）并从本清单删掉；答"不做" ⇒ 直接从本清单删掉。
 *  ⇒ 口径极简：清单里剩下的**永远都是"还没人拍板"的**，前端不需要任何状态判断。
 *  ⚠️ 它**绝不阻塞**：只是"记下来等你以后说"，计划卡照常推进/派发。 */
export interface BlackboardDecision {
  /** dec1/dec2…（新增时自动生成；删除后号不复用，靠墓碑挡） */
  id: string
  /** 一句话问清要拍板的事 */
  question: string
  /** 影响/代价（为什么需要拍板） */
  context?: string
  /** 候选答案（可省，如 ['现在做','排后面','不做']） */
  options?: string[]
  createdAt: number
}

export interface Blackboard {
  sessionId: string
  teamId: string
  goal: string
  acceptance?: string
  steps: BlackboardStep[]
  findings: Array<{ t: number; by: string; text: string }>
  finalResult?: string
  createdAt: number
  updatedAt: number
  /** ★1005 补类型：黑板上的**成员运行记录**（派发/收尾/看板去重都读写它，键含 runId/stepId/memberId/status）。
   *  带索引签名：实现里还会塞别的时间戳/文本字段，避免为它反复改类型。 */
  runs?: Array<{ runId?: string; id?: string; stepId?: string; memberId?: string; status?: string; [k: string]: any }>
  /** ★1104-I 计划代次：每次 `bb_goal` 全量重写 +1，`saveBlackboard` 只认更高代次。
   *  修的病（实测 be4a425f 会话）：`bb_goal` 标称"全量替换"，落盘却按 step id 求**并集**
   *  ⇒ 45 次 bb_goal 里 36 次把上一版计划的步骤留在板上，新计划平均 3.9 步而盘上平均 11 步、
   *  最高 24 步。主 agent 按自己刚写的计划派 s1→m1，盘上的 s1 还是旧计划的 m4
   *  ⇒ owner 硬校验必挂 —— 这就是"第一次派活基本都失败、报错后重写计划再派就成功"的成因。 */
  planRev?: number
  /** ★h5：**成员 token 累计**（唯一权威口径）= memberRetired + 板上现存 runs，每次落盘重算。
   *  键 = memberId；tokens = prompt + cacheRead + cacheWrite + completion（与前端第 6 胶囊同口径）。
   *  前端**只读这个字段**，不许再对 bb.runs 求和 —— runs 有 60 条封顶，求和必然回退。 */
  memberTotals?: Record<string, MemberTokenTotal>
  /** ★tw1s：成员 token 的**口径切换点**（落盘一次）—— 从此以后 `run.usage` = 会话账本差值（run 增量法，含全部跳）；
   *  此前的历史 runs 是旧口径（只算最后一跳，偏小），**不重算**。排查看"从哪一刻开始可信"读它。 */
  usageAccounting?: { scheme: string; since: number }
  /** ★h5：已被 60 条封顶裁掉那部分 run 的累计（只增不减、落盘持久；foldedRunIds 防"复活"重复计入）。 */
  memberRetired?: Record<string, MemberRetiredTotal>
  /** ★bd1：**待确认清单**（只存 open 的；答完即删 —— 见 BlackboardDecision）。
   *  bb_write 增/答/删它，bb_read 与前端展开卡读它；语义是"还没人拍板的事"，不是任务。 */
  decisions?: BlackboardDecision[]
  /** ★bd1：**被删掉的 decision id 墓碑**（append-only，封顶 50）。
   *  为什么需要：saveBlackboard 是「盘上 fresh ∪ 本地 local」合并落盘，删掉的条目会被盘上那份"复活"
   *  （删了又冒出来＝用户被反复问同一件事）。墓碑让**删除在合并里赢**；只存 id、体积可忽略。 */
  decisionTombstones?: string[]
}

const BB_DIR = path.join(DATA_ROOT, 'blackboard')

function bbPath(sessionId: string): string {
  return path.join(BB_DIR, `${sessionId}.json`)
}

/* ══════════ h5-member-totals:begin —— 成员 token 累计（后端唯一源，免疫 runs 60 条封顶） ══════════
 *  病根：前端第 6 胶囊是把 `bb.runs` 纯求和；而 `bb.runs` 有 60 条封顶（裁旧的）⇒ 裁一次数字掉一截。
 *  解法（铁律：后端是唯一源）：累计量在后端维护，裁 runs 时**先折进 memberRetired 再裁**。
 *  ⚠️ 前端不许自己维护累计（刷新即丢、多窗口不一致）—— 只读 `bb.memberTotals`。 */
/** 单个成员的 token 累计（口径与前端第 6 胶囊完全一致：promptTokens 只含未命中部分，
 *  总 token = prompt + cacheRead + cacheWrite + completion）。 */
export interface MemberTokenTotal {
  tokens: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  runs: number
  llmMs: number
  /** ★tw1s：**口径切换点**（该成员从这一刻起按"会话账本差值"计 token；之前是只算最后一跳的旧口径）。
   *  缺省 = 该成员目前只有旧口径的 run（历史不重算）。 */
  since?: number
  /** ★r3：该成员**当前上下文占用**（token）。来自它自己那个成员会话的真实用量，
   *  与主会话圆环同一口径（`ctxUsedTokens`：lastUsage 三项之和，无实报时用同源估算）。
   *  ⚠️ **可选**：拿不到就**不写这个键**（前端整块不渲染），绝不写 0 冒充"用了 0"。
   *  拿不到的情形见 server 侧 `memberCtxUsage` 的三种解释（成员没跑过 / 会话已回收 / 模型解析不出窗口）。 */
  ctxUsed?: number
  /** ★r3：该成员**实际生效模型**的窗口大小（token）。按成员的模型解析结果取 ——
   *  独立模型模式用它自己配的，跟随会话模式用会话的；解析不出窗口就**不写**（不猜一个默认值）。 */
  ctxWindow?: number
  /** ★d1/★member-lifetime：**这个数字从哪来的**（诊断字段，不参与任何运算/显示口径计算）。
   *  · `'ledger'` = 成员会话账本（`usageTotals`，**含私聊消耗**，且不受 runs 封顶影响）—— 主源
   *  · `'runs'`   = 回退到板上 runs 累计（该成员没有任何成员会话可读时的残值）
   *  · `'empty'`  = 成员有会话但一段都没跑过（真 0，不是"未知"）
   *  为什么要这个字段：改了数据源之后，"为什么这个成员的数字和我预期不一样"必须能一眼查清；
   *  没有它就只能靠猜是账本值还是 runs 残值。**只读不写进前端文案**，前端零改动。 */
  source?: 'ledger' | 'runs' | 'empty'
  /** ★f1：**当前（未归档）那一段的 token 合计** —— 卡片上显示的那个数（老板：新开对话就清 0）。
   *  ⚠️ 与上面 `tokens`（**全历史**：当前段 + 归档段 + 其中私聊）**不是一个口径**，两者都保留：
   *     · `tokens`    = 该成员全部段的账本累计（图表/统计用；★member-lifetime 起真的是全历史）
   *     · `segTokens` = 当前段的累计（卡片显示用；开新段天然从 0 起）
   *  拿不到就是 `undefined`（**前端显示「—」，不许写 0 冒充"这一段用了 0"**）。 */
  segTokens?: number
  /** ★f1：当前是**第几段**（`memberSessionSeq`）。缺失/未知 = `undefined`（前端显示「—」）。 */
  segSeq?: number
  /** ★member-lifetime：存在 >1 个未归档段（数据异常）⇒ `segTokens` 按 seq 最大取，此处明确标出 */
  segAmbiguous?: boolean
  /** ★member-lifetime：**累计命中率**（整数百分比）—— 唯一口径，由后端算好。
   *  公式 = Σ缓存读 ÷ (Σ未命中 + Σ缓存读 + Σ缓存写)，**先求和再相除**；分母 = 完整输入量。
   *  `null` = 分母为 0（三桶全 0，不可计算，显示「—」）。⛔ 前端不要再自己除一遍。 */
  hitRate?: number | null
  /** 命中率分母（= Σ未命中 + Σ缓存读 + Σ缓存写 = 完整输入量），让"怎么算出来的"可查 */
  hitDenominator?: number
  /** ★member-lifetime：累计的**完整度**：
   *  · `complete` = 每一段都有账本（数字完整可信）
   *  · `partial`  = 有段缺账本（`missingSegments > 0`）⇒ `tokens` 是**部分和**，不许当全量展示
   *  · `empty`    = 有段但一段都没跑过（真 0）
   *  · `none`     = 该成员没有任何成员会话（数字是 runs 残值） */
  usageStatus?: 'complete' | 'partial' | 'empty' | 'none'
  /** 缓存信号的可证明边界：hit（有过命中）/ write-only（只写未读）/ never（读写都 0）/ none（无账本段） */
  cacheSignal?: 'hit' | 'write-only' | 'never' | 'none'
  /** 段数 / 可读段 / 缺账段 / 重复未归档段数（排障与展示"部分数据"提示用） */
  segments?: number
  readableSegments?: number
  missingSegments?: number
  duplicateActive?: number
  /** 当前段会话 id（与 `session.memberUsageDetail.currentSessionId` 同源） */
  usageCurrentSessionId?: string
}
/** 已「退休」（被 60 条封顶裁掉）的那部分累计 —— 只增不减，随板子落盘。
 *  foldedRunIds = 已经计过的 runId：长跑成员手里的旧副本可能把已裁的 run 带回板上，
 *  再被裁一次时靠它跳过（可复活的最大批量 = 封顶条数 60，这里留 400 条余量后按 FIFO 裁剪）。 */
export interface MemberRetiredTotal extends MemberTokenTotal { foldedRunIds?: string[] }

const MEMBER_FOLDED_IDS_KEEP = 400

export function emptyMemberTotal(): MemberTokenTotal {
  return { tokens: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 0, llmMs: 0 }
}

/** 取某个 run 的 token 账（字段名与 run.usage 一致；runs=1 便于数「跑了几次」） */
export function runTokenUsage(r: any): MemberTokenTotal {
  const u = (r && r.usage) || {}
  const promptTokens = Number(u.promptTokens) || 0
  const completionTokens = Number(u.completionTokens) || 0
  const cacheReadTokens = Number(u.cacheReadTokens) || 0
  const cacheWriteTokens = Number(u.cacheWriteTokens) || 0
  const llmMs = Number((r && r.timing && r.timing.llmMs) || 0) || 0
  return {
    tokens: promptTokens + completionTokens + cacheReadTokens + cacheWriteTokens,
    promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens,
    runs: 1,
    llmMs: Math.max(0, llmMs),
  }
}

function addIntoTotal(dst: MemberTokenTotal, add: MemberTokenTotal): void {
  dst.tokens += add.tokens
  dst.promptTokens += add.promptTokens
  dst.completionTokens += add.completionTokens
  dst.cacheReadTokens += add.cacheReadTokens
  dst.cacheWriteTokens += add.cacheWriteTokens
  dst.runs += add.runs
  dst.llmMs += add.llmMs
}

/** 只挑累计字段（丢掉 foldedRunIds 之类内部字段，保证落盘的 memberTotals 是干净的只读汇总） */
function pickTotal(src: any): MemberTokenTotal {
  const out = emptyMemberTotal()
  if (!src || typeof src !== 'object') return out
  out.tokens = Number(src.tokens) || 0
  out.promptTokens = Number(src.promptTokens) || 0
  out.completionTokens = Number(src.completionTokens) || 0
  out.cacheReadTokens = Number(src.cacheReadTokens) || 0
  out.cacheWriteTokens = Number(src.cacheWriteTokens) || 0
  out.runs = Number(src.runs) || 0
  out.llmMs = Number(src.llmMs) || 0
  return out
}

/** ★核心：把一批「即将被 60 条封顶裁掉」的 run 折进 board.memberRetired —— **裁之前调用，一条都不能丢**。
 *  同一 runId 只计一次（旧副本把 run 复活回板上、再被裁时不会重复计）。无 runId 的不折（宁少计不错计）。 */
export function foldRetiredRuns(board: any, dropped: any[]): void {
  if (!board || !Array.isArray(dropped) || !dropped.length) return
  if (!board.memberRetired || typeof board.memberRetired !== 'object') board.memberRetired = {}
  for (const r of dropped) {
    const mid = String((r && r.memberId) || '')
    const rid = String((r && (r.runId || r.id)) || '')
    if (!mid || !rid) continue
    let rec: any = board.memberRetired[mid]
    if (!rec || typeof rec !== 'object') rec = board.memberRetired[mid] = { ...emptyMemberTotal(), foldedRunIds: [] }
    const ids: string[] = Array.isArray(rec.foldedRunIds) ? rec.foldedRunIds : (rec.foldedRunIds = [])
    if (ids.indexOf(rid) >= 0) continue
    addIntoTotal(rec, runTokenUsage(r))
    ids.push(rid)
    if (ids.length > MEMBER_FOLDED_IDS_KEEP) rec.foldedRunIds = ids.slice(-MEMBER_FOLDED_IDS_KEEP)
  }
}

/** 成员累计的**唯一口径** = memberRetired（已被裁掉的）+ 板上现存 runs。
 *  runs 里若出现「已经计进 retired 的 runId」（旧副本复活），跳过不算 —— 否则会重复计。 */
export function computeMemberTotals(board: any): Record<string, MemberTokenTotal> {
  const out: Record<string, MemberTokenTotal> = {}
  const retired: any = (board && board.memberRetired && typeof board.memberRetired === 'object') ? board.memberRetired : {}
  for (const mid of Object.keys(retired)) {
    const rec = retired[mid]
    if (!rec || typeof rec !== 'object') continue
    out[mid] = pickTotal(rec)
  }
  const runs: any[] = (board && Array.isArray(board.runs)) ? board.runs : []
  for (const r of runs) {
    const mid = String((r && r.memberId) || '')
    if (!mid) continue
    const rid = String((r && (r.runId || r.id)) || '')
    const folded: string[] = Array.isArray(retired[mid] && retired[mid].foldedRunIds) ? retired[mid].foldedRunIds : []
    if (rid && folded.indexOf(rid) >= 0) continue
    if (!out[mid]) out[mid] = emptyMemberTotal()
    addIntoTotal(out[mid], runTokenUsage(r))
    /* ★tw1s：口径切换点 = 该成员**最早一条按账本差值记账**的 run 的开始时间。
       之前的 run 是旧口径（只算最后一跳，偏小），历史不重算 —— 这个时间戳就是"从哪一刻起数字可信"。 */
    if (String((r as any).usageSource || '') === 'ledger') {
      const t = Number((r as any).startedAt || (r as any).t || 0) || 0
      if (t > 0) out[mid].since = out[mid].since && out[mid].since > 0 ? Math.min(out[mid].since, t) : t
    }
  }
  return out
}

/** bb_read 摘要里的一行：成员累计 token（空则 ''） */
export function memberTotalsLine(board: any): string {
  const t: any = (board && board.memberTotals && typeof board.memberTotals === 'object')
    ? board.memberTotals
    : computeMemberTotals(board || {})
  const ids = Object.keys(t)
  if (!ids.length) return ''
  const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
  const parts = ids.map((id) => {
    const m: any = t[id] || {}
    return `${id} ${fmt(Number(m.tokens) || 0)}（${Number(m.runs) || 0} 次）`
  })
  return `\n成员累计 token（含被 60 条封顶裁掉的 run）：${parts.join(' · ')}`
}
/* ══════════ h5-member-totals:end ══════════ */

type BoardRun = NonNullable<Blackboard['runs']>[number]

// 恢复只检查刚读到的记录。车道从领取步骤到终态落盘始终持有 runId；
// 不存在该持有者才能认定残留，不用时间戳推断，也不知道实际中断时刻。
function recoverBlackboard(bb: Blackboard): void {
  for (const step of bb.steps || []) {
    if (step.status === 'running' && step.runId && !activeRunIds.has(step.runId)) step.status = 'interrupted'
  }
  for (const run of bb.runs || []) {
    const runId = run?.runId || run?.id
    if (run?.status === 'running' && runId && !activeRunIds.has(runId)) {
      run.status = 'interrupted'
      run.error ||= '执行已中断：此运行没有存活的执行者'
    }
  }
  recordExecutionEvidence(bb.steps || [], bb.runs || [])
}

function recordExecutionEvidence(steps: BlackboardStep[], runs: BoardRun[]): void {
  for (const run of runs) {
    const step = steps.find(s => runMatchesStep(run, s))
    if (step && !step.executedAt && runCountsAsExecuted(run, step)) step.executedAt = run.startedAt || run.t
  }
}

export function loadBlackboard(sessionId: string): Blackboard | null {
  try {
    const bb = readBlackboardRaw(sessionId)
    if (!bb) return null
    recoverBlackboard(bb)
    bb.memberRetired ??= {}
    bb.decisions ??= []
    bb.decisionTombstones ??= []
    bb.memberTotals = computeMemberTotals(bb)
    return bb
  } catch (e) {
    console.error('[team] blackboard read failed:', e)
    return null
  }
}

function saveBlackboard(local: Blackboard, run?: BoardRun): void {
  // 同一进程的同步读-改-原子换名是唯一提交点；旧快照中的 runs/retired 没有写权限。
  const scope = laneWrites.get(local)
  if (scope && !activeRunIds.has(scope.runId)) throw new Error('blackboard lane owner already released')
  if (run && (!scope || run.runId !== scope.runId || !runMatchesStep(run, scope.step))) {
    throw new Error('blackboard run write without matching lane owner')
  }
  const stored = readBlackboardRaw(local.sessionId)
  if (scope && !stored) throw new Error('blackboard removed during team execution')
  if (stored) recoverBlackboard(stored)
  const fresh: Partial<Blackboard> = stored || {}
  const all = fresh.runs || []
  if (run) {
    const i = all.findIndex(r => r?.runId === run.runId)
    if (i < 0) all.push(run)
    else all[i] = run
    // 时间戳只用于既有展示及裁剪顺序，不决定写权限。
    all.sort((a, b) => (a?.t || 0) - (b?.t || 0))
  }
  const dropped: BoardRun[] = []
  const runs = all.filter(r => {
    if (all.length - dropped.length <= 60 || activeRunIds.has(r?.runId || r?.id || '')) return true
    dropped.push(r)
    return false
  })
  const freshRev = Number(fresh.planRev || 0)
  const localRev = Number(local.planRev || 0)
  const steps: BlackboardStep[] = (() => {
    if (scope) {
      return (fresh.steps || []).map(step => {
        if (step.id !== scope.step.id || step.owner !== scope.step.owner) return step
        // 认领前校验原代次和原 run；认领后只改仍归本 run 的步骤（含换计划时保留的活步骤）。
        const claim = scope.base.runId !== scope.runId && freshRev === scope.planRev && step.runId === scope.base.runId
        if (!claim && step.runId !== scope.runId) return step
        const delta = Object.fromEntries(Object.entries(scope.step).filter(([key, value]) =>
          !Object.is(value, scope.base[key as keyof BlackboardStep])))
        return { ...step, ...delta }
      })
    }
    if (localRev > freshRev) {
      const ids = new Set(local.steps.map(s => s.id))
      const live = (fresh.steps || []).filter(s => !ids.has(s.id) && s.status === 'running')
      return [...local.steps, ...live]
    }
    return localRev < freshRev ? (fresh.steps || []) : local.steps
  })()
  recordExecutionEvidence(steps, dropped)
  const seen = new Set<string>()
  const findings = [...(fresh.findings || []), ...(local.findings || [])]
    .filter(f => { const k = JSON.stringify(f); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.t - b.t)
  const plan = (scope || localRev < freshRev) ? stored! : local
  const merged: Blackboard = { ...fresh, ...plan,
    runs, steps, findings, createdAt: fresh.createdAt ?? local.createdAt, updatedAt: Date.now(),
    memberRetired: fresh.memberRetired ?? {},
  }
  if (run) merged.usageAccounting ??= { scheme: 'run-ledger-delta', since: Date.now() }
  foldRetiredRuns(merged, dropped)
  merged.decisionTombstones = mergeDecisionTombstones(fresh.decisionTombstones, plan.decisionTombstones)
  merged.decisions = mergeDecisions(fresh.decisions, plan.decisions, merged.decisionTombstones)
  delete merged.memberTotals // 派生值只给调用方，不作为持久事实。
  writeJsonAtomic(bbPath(local.sessionId), merged)
  if (scope) {
    const i = steps.findIndex(step => step.runId === scope.runId && step.id === scope.step.id && step.owner === scope.step.owner)
    if (i >= 0) {
      Object.assign(scope.step, steps[i])
      scope.base = { ...scope.step }
      steps[i] = scope.step // 成员工具/收尾仍持有同一个自己的步骤引用。
    }
  }
  Object.assign(local, merged, { acceptance: merged.acceptance, memberTotals: computeMemberTotals(merged) })
}

function persistBoardRuns(bb: Blackboard, run: BoardRun): void {
  saveBlackboard(bb, run)
}

/** 会话删除时清理黑板落盘 */
export function clearBlackboard(sessionId: string): void {
  try {
    fs.rmSync(bbPath(sessionId), { force: true })
  } catch { /* ignore */ }
}

// 读失败不能变成空板参与提交，只有 ENOENT 是不存在。
function readBlackboardRaw(sessionId: string): Blackboard | null {
  try {
    const bb = JSON.parse(fs.readFileSync(bbPath(sessionId), 'utf-8'))
    if (bb?.sessionId !== sessionId || (bb.steps != null && !Array.isArray(bb.steps)) || (bb.runs != null && !Array.isArray(bb.runs))) {
      throw new Error('invalid blackboard: ' + sessionId)
    }
    return bb
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

const activeRunIds = new Set<string>()
// 非持久写权限，不保留整板镜像；base 仅用来识别本步骤的变更字段。
const laneWrites = new WeakMap<Blackboard, { runId: string; step: BlackboardStep; base: BlackboardStep; planRev: number }>()

// ============================================================================
// 子 agent 生命周期跟踪（session.cancel / session.delete 时中止）+ 看门狗
// ============================================================================

/** ★0930：会话「用户中止」时间戳 —— abortSubAgents 打点，调用方用 abortedSince 判定
 *  「这批 run 是不是被用户停掉的」（失败链严禁把用户中止当失败重派，见 cloneRuntime）。 */
const abortStamps = new Map<string, number>()

export function abortedSince(sessionId: string, sinceMs: number): boolean {
  return (abortStamps.get(sessionId) || 0) > sinceMs
}

/** ★1032-TM（P5）：按 memberId 停**单个成员**（右侧面板的「停止」按钮）。
 *  只停它的 run —— 主 agent 继续跑、同批其它成员不受影响（DSH 的 interrupt(targetSessionId) 同理）。
 *  判据：session.subRuns 里该成员 status==='running' 的 runId。
 *  实现走**权威登记表** watchdogs（runId → agent），不是遍历 subAgents 猜。
 *  找不到 ⇒ 返回 false，调用方如实告诉用户"它没在跑"，不假装停了。 */
export function abortSubAgentByMember(sessionId: string, memberId: string, runsById: Record<string, any>): boolean {
  const ids: string[] = []
  for (const cid of Object.keys(runsById || {})) {
    const arr = Array.isArray(runsById[cid]) ? runsById[cid] : []
    for (const r of arr) {
      if (String(r?.memberId || '') === memberId && String(r?.status || '') === 'running') ids.push(String(r.runId || ''))
    }
  }
  if (!ids.length) return false
  const wm = watchdogs.get(sessionId)
  let aborted = 0
  for (const rid of ids) {
    /* ★1032（P18 **真根因**）：watchdog 表的 key **不是裸 runId** ——
       `armWatchdog(ctx, \`\${ctx.sessionId}/\${runId}\`, ...)` 传的是拼好的串
       ⇒ 原来 `wm.get(rid)` 永远 miss ⇒ **一个 run 都没停，却 return true**（谎报"已停止"）。
       实测：点了停止，系统监控里成员进程还在跑。 */
    let ent: any = wm?.get(rid)
    let hitKey: string | null = null
    if (!ent && wm) {
      for (const [k, v] of wm) {
        if (k === rid || String(k).endsWith('/' + rid)) { ent = v; hitKey = String(k); break }
      }
    }
    if (!ent) continue
    /* 两件事都要做：agent.abort() 停 LLM 流；ac.abort() 让 runSubAgent 认出"这是用户停的"
       ⇒ 走 killed 分支（标 interrupted + 写【未完成】），而不是当正常完成标 done。 */
    try { ent.agent?.abort?.() } catch { /* 单个失败不拦其它 */ }
    try { ent.ac?.abort?.() } catch { /* 同上 */ }
    if (ent.timer) clearTimeout(ent.timer)
    if (hitKey) wm.delete(hitKey)
    aborted++
  }
  /* 一个都没真停 ⇒ 如实返回 false，绝不谎报成功。 */
  if (!aborted) return false
  abortStamps.set(sessionId, Date.now())
  return true
}

export function abortSubAgents(sessionId: string): void {
  abortStamps.set(sessionId, Date.now())
  /* 唯一登记表 = `watchdogs`（runId → { agent, ac, timer }）：全停 = 把里面每一个都停掉。
     原来还要额外遍历 subAgents / subControllers 两张表 —— 已删（同一事实的另两份副本）。 */
  const runMap = watchdogs.get(sessionId)
  if (!runMap) return
  for (const [, entry] of runMap) {
    try { entry.agent?.abort?.() } catch { /* 单个失败不拦其它 */ }
    try { entry.ac?.abort?.() } catch { /* 同上 */ }
    if (entry?.timer) clearTimeout(entry.timer)
  }
  watchdogs.delete(sessionId)
}

/** 看门狗：runId → (最后活动时间, timer)。派发超过 MAX_RUN_MS 无活动 → abort 子 agent（主 agent 收到超时产出，自行调整）
 *  ⚠️ 类型里原来漏了 `ac`（`armWatchdog` 明明往 state 里塞了它，`abortSubAgents` 也要用它）——
 *     tsc 一直报 `Property 'ac' does not exist`，运行时却没问题（对象是字面量）。纯类型缺口，补上。 */
const watchdogs = new Map<string, Map<string, {
  last: number; timer: NodeJS.Timeout | null; agent: Agent; ac?: AbortController
  memberId?: string; stepId?: string
  /** ★s1：**成员显示名**（`memberName(team, id)` 的结果，如「后端工程师」）。
   *  为什么需要它：LLM 在途打点（`installMemberStreamOpHook`）只能从 `createStreamFn` 的
   *  `opts.actor` 拿到**成员名**，而 watchdogs 的 key 是**主会话 id**（多成员并行时一个会话下有 N 条）。
   *  没有名字就只能"size===1 才敢打点" ⇒ **并行时全部失效**（实测 r2+r3 同时跑，r3 被误杀）。
   *  ⚠️ 用**名字**而不是 memberId 归属：actor 传过来的就是名字（见 createSubStreamFn 的 actor 参数）；
   *     两者要能对上，就必须在这里存一份名字。归属错了比不打点更糟（A 的心跳刷到 B 头上）。 */
  memberName?: string
  /** ★p1：在途操作计数（等 LLM / 跑工具时 >0）。看门狗判死的必要条件见 WATCHDOG_IDLE_MS 注释。
   *  和当年漏 `ac` 是同一类缺口 —— state 字面量里有、类型里没有 ⇒ tsc 报错而运行正常。所以这里必须登记。 */
  suspended?: boolean
  pendingOps?: number
  pendingLabels?: string[]
}>>()

/* ★1005（已定案"分身还在跑 ⇒ 会话就是进行中"，且**必须是真实后端状态**）：
   watchdogs 就是权威登记表 —— run 开始时登记（runSubAgent）、disarm/看门狗击杀/abort 时注销。
   ① runningSubAgentCount：给 server.ts 在收轮时判断"还有没有在跑的成员/分身"；
   ② setSubAgentsIdleHook：**最后一个 run 收尾**时通知 server.ts 把会话置 idle 并广播
      （server.ts 接线；不设=不通知）。此前后端根本没有这份"运行中"名单可查 ⇒ 前端只能瞎猜。 */
export function runningSubAgentCount(sessionId: string): number {
  return watchdogs.get(String(sessionId || ''))?.size || 0
}
let onSubAgentsIdle: ((sessionId: string) => void) | null = null
export function setSubAgentsIdleHook(fn: (sessionId: string) => void): void { onSubAgentsIdle = fn }
function notifySubAgentsIdleIfEmpty(sessionId: string): void {
  if (watchdogs.get(sessionId)?.size) return
  try { onSubAgentsIdle?.(sessionId) } catch (e) { console.warn('[subagent] 空闲回调失败:', e) }
}
/** ★p1d：把 **server 侧的成员子流 LLM 在途钩子**接到本模块的看门狗上。
 *
 *  为什么要有这层桥：默认派发路径 `runMemberTurn` 的 streamFn 在 server 内部创建
 *  （`createStreamFn`，`opts.sub=true`），teamRuntime 拿不到流句柄 ⇒ 没法在那边直接包 begin/end。
 *  server 在每次成员子流请求时回调这里，我们按 `sid` 找到对应的看门狗打点。
 *
 *  为什么不按 runId 索引：一次 LLM 请求只带 sessionId（server 不知道 runId）。
 *  但一个成员会话同一时刻只跑一件事（同成员串行车道保证），所以"该会话当前唯一的 running run"
 *  就是这次请求的归属 —— 用 `watchdogs.get(sid)` 里唯一那条即可。
 *  找不到（比如用户在成员窗口里直接私聊，没有派活）⇒ 不打点，这是正确的：
 *  那种情况本来就没有看门狗在盯。 */
export function installMemberStreamOpHook(register: (h: { begin: (sid: string, actor?: string) => void; end: (sid: string, actor?: string) => void }) => void): void {
  /* ★s1（根因修复）：**归属改成"按成员名精确匹配"，不再因 size!==1 放弃**。
     病（实测）：原来写的是 `if (!m || m.size !== 1) return null` —— 单成员跑时 size=1 能找到，
     但**两个成员并行时 size=2 ⇒ 直接返回 null ⇒ 所有 LLM 打点全部失效**。
     实测后果：r2(m1)+r3(m4) 同时跑，两人都在"等 LLM 首 token"（这期间没有任何 agent 事件刷新心跳）
     ⇒ 5 分钟后 r3 被当成挂死杀掉，而它当时 segs=76、text=4447 字，一直在正常干活。
     并行恰恰是老板要的用法，所以这不是边角情况，是主路径失效。

     修法：`watchdogs` 的 key 是**主会话 id**，一个会话下可能有 N 条 run（每成员一条）。
     每条 run 的 state 现在带 `memberName`（见 armWatchdog 的 owner.memberName 与两个调用点）。
     `createStreamFn` 的 `opts.actor` 传的**就是成员名**（createSubStreamFn 已经在传）
     ⇒ 用 (会话id, 成员名) 就能精确归属到那一条。

     为什么用成员名而不是 memberId：actor 那头给的就是名字，没有 id。
     为什么不按 runId：server 侧一次 LLM 请求只有 sessionId + actor，拿不到 runId。

     **归属判据（f1 定稿）**：
       · 给了 actor ⇒ **一律按成员名精确匹配**（单跑也一样）：私聊与派活共用同一个成员会话，
         单跑时若不校验，另一个成员的私聊心跳会刷到这条 run 上（错配比不打点更糟）；
       · 没给 actor ⇒ 只有"确实只有一个 run"才归属（那种调用方不带归属信息，只能按唯一那条算），
         并行时状态不明 ⇒ 不打点。 */
  const findWd = (sid: string, actor?: string) => {
    const m = watchdogs.get(String(sid || ''))
    if (!m || m.size === 0) return null            // 没在跑任何 run（没派活 / 已收尾）
    const who = String(actor || '').trim()
    if (!who) {
      /* 没给 actor：只有"确实只有一个 run"才敢归属；并行时状态不明 ⇒ 不打点。 */
      return m.size === 1 ? (() => { for (const st of m.values()) return st })() : null
    }
    for (const st of m.values()) {
      if (String((st as any).memberName || '') === who) return st   // 按成员名精确归属（单跑/并行同一判据）
    }
    return null                                    // 名字对不上 —— 不打点（不错配）
  }
  register({
    begin: (sid: string, actor?: string) => {
      const st = findWd(sid, actor)
      if (!st) return
      st.pendingOps = (st.pendingOps || 0) + 1
      st.pendingLabels = Array.isArray(st.pendingLabels) ? st.pendingLabels : []
      st.pendingLabels.push('llm')
      if (!st.suspended) {
        st.last = Date.now()
        /* ★c1：刷心跳的同时**重排 timer** —— 否则 timer 还按上一次排的时刻触发（见 state.reschedule 注释）。 */
        try { (st as any).reschedule?.() } catch { /* ignore */ }
      }
    },
    end: (sid: string, actor?: string) => {
      const st = findWd(sid, actor)
      if (!st) return
      st.pendingOps = Math.max(0, (st.pendingOps || 0) - 1)
      st.pendingLabels = Array.isArray(st.pendingLabels) ? st.pendingLabels : []
      st.pendingLabels.pop()
      if (!st.suspended) {
        st.last = Date.now()
        try { (st as any).reschedule?.() } catch { /* ignore */ }
      }
    },
  })
}

/** 无活动超时（成员可能陷入死循环/网关挂死）：**5 分钟**。
 *
 *  ★p1（老板批准方案 A）：原来是 10 分钟，注释写"不可调/最后一道兜底"。现在**改成可依赖的一档**：
 *  它不再独自承担"杀挂死"的职责 —— 真正的判据变成「空闲 ≥ 阈值 **且** 无在途操作」，
 *  同时硬上限（MAX_RUN_MS / MAX_RUN_WALL_MS）照样无条件生效。所以：
 *    · 阈值可以降（有在途操作时不会误杀长思考/长工具）；
 *    · 也不再是"唯一兵底"（硬上限才是最后一道闸，见 armWatchdog 的 pendingOps 说明）。
 *
 *  为什么必须加"无在途操作"这个条件（病根 A，实测）：
 *  旧判据只看"多久没有事件"。而成员**等 LLM 首 token（长思考/慢网关）**和**跑长工具**时，
 *  天然没有事件可发 ⇒ 被判"10 分钟无活动 = 挂死"⇒ 实测 n1（前端改样式）就这样被杀，
 *  它既没死循环也没挂起，活干完了却被标成"已中断/打回"。
 *  加 pendingOps 后：有在途操作就不因"没事件"判死（交给操作自己的超时 + 硬上限）。 */
const WATCHDOG_IDLE_MS = 5 * 60 * 1000
/** 单次派发硬上限默认值：30 分钟（到点强杀，防无限占用并行预算；挂起时长不计入） */
const MAX_RUN_MS = 30 * 60 * 1000
/** 绝对墙钟上限默认值：60 分钟，**不受挂起顺延影响**。挂起顺延本为"人不在权限卡前"设计，
 *  但每次工具授权都会 suspend/resume，授权间隙的 LLM 慢/429 重试会把 started 不断推走，
 *  30 分钟硬上限可能永远到不了（0911 商城实验实锤：agnes 429 风暴把测试 run 挂了 35 分钟+）。
 *  墙钟上限是无条件兜底：真需要长任务的成员，60 分钟也该到头了。 */
const MAX_RUN_WALL_MS = 60 * 60 * 1000

/** 0911：成员单次运行上限可调（设置·通用「成员单次运行上限」，0=不设限）——
 *  server.ts 注入热读函数（activeMs=连续工作硬上限（挂起不计）；wallMs=绝对墙钟（含权限等待）；
 *  Infinity=不设限）。默认值=旧行为（30/60 分钟），改动即时生效、无需重启。 */
let memberRunCaps: () => { activeMs: number; wallMs: number } = () => ({ activeMs: MAX_RUN_MS, wallMs: MAX_RUN_WALL_MS })
export function setMemberRunLimitProvider(fn: () => { activeMs: number; wallMs: number }): void { memberRunCaps = fn }

// ============================================================================
// 成员巡检官（0911 三批，需求「完整版」）
//  看门狗管「死活」（无活动/超时→击杀）；巡检官管「方向」（偏离主线/陷入循环→纠偏→击杀）。
//  三件套：规则预筛（零模型成本，每次工具调用后评估）→ 疑似才轻量模型复审（短上下文直调）
//  → 动作阶梯：先 steer 纠偏一次；再犯 abort 击杀（原因沿既有失败路径回报主 agent，主 agent 逻辑零改动）。
//  边界：只管 team_dispatch 派发的成员 run（成员单聊有人盯着，不巡检）；复审失败静默跳过；
//  阈值保守（宁可漏抓不可误杀）；开关走设置（默认开）。
// ============================================================================

/** 复审结果（server.ts 实现 reviewer 并注入，teamRuntime 不反向依赖 server） */
interface InspectorVerdict { verdict: 'ok' | 'drift' | 'loop'; reason: string; fix?: string }
interface InspectorReviewInput {
  memberName: string; roleText: string; stepText: string; taskText: string; acceptance: string
  suspicion: string; trajectory: string
}
let inspectorEnabled: () => boolean = () => true
export function setMemberInspectorProvider(fn: () => boolean): void { inspectorEnabled = fn }
let inspectorReviewer: ((input: InspectorReviewInput) => Promise<InspectorVerdict>) | null = null
export function setInspectorReviewer(fn: (input: InspectorReviewInput) => Promise<InspectorVerdict>): void { inspectorReviewer = fn }

/** 成员只读类工具（连续只读=空转嫌疑；与 server.ts READONLY_TOOL_RE 同源 + 成员常见记忆/技能读类） */
const INSPECTOR_READONLY_RE = /^(fs_read|fs_grep|search_files|list_dir|web_search|web_fetch|memory_search|use_skill|read_preset|scan_skill|list_installed|snapshotFile|wb_get_text|wb_snapshot|wb_screenshot|wb_read_console)$/i
/** 成员写入类工具（成功执行=真实进展信号） */
const INSPECTOR_WRITE_RE = /^(fs_write|fs_delete|run_command|memory_store|memory_delete|project_note)$/i
/* ★ 0929 工具瘦身·刀①：家族工具按 (name, action) 判读写；未识别的家族调用**从严按"写"**（不误放空转） */
const FAM_READONLY = new Set(['memory:search', 'knowledge:query', 'notebook:list', 'bg:list', 'bg:read', 'history:list', 'history:stat', 'schedule:list', 'git:status', 'git:diff', 'git:log', 'repo:map', 'repo:search', 'repo:build'])
const FAM_WRITE = new Set(['memory:store', 'memory:delete', 'memory:distill', 'knowledge:add', 'knowledge:delete', 'notebook:add', 'notebook:update', 'notebook:delete', 'bg:start', 'bg:stop', 'bg:note', 'bg:watch', 'history:restore', 'schedule:create', 'schedule:update', 'schedule:remove', 'schedule:run_now', 'git:commit'])
function famClassify(name: string, argsStr: string): 'readonly' | 'write' | null {
  let action = ''
  try { action = String((argsStr && JSON.parse(argsStr))?.action || '') } catch { /* args 非 JSON 就落名字判 */ }
  const key = action ? `${name}:${action}` : ''
  if (FAM_READONLY.has(key)) return 'readonly'
  if (FAM_WRITE.has(key)) return 'write'
  if (/^(bg|memory|knowledge|notebook|history|schedule)$/.test(name)) return 'write'
  return null
}

interface InspectorCall { name: string; args: string; result: string; isError: boolean; readonly: boolean; progress: boolean; ts: number }

/** 规则预筛（纯函数，可单测）：命中返回嫌疑标记，未命中返回 null。
 *  阈值取保守值——巡检官的价值在"疑似才升级复审"，宁可漏抓不可误杀。 */
function inspectorSuspect(calls: InspectorCall[]): string | null {
  // A. 只读空转：最近 18 次调用全是只读（读文件/搜索/抓网页）——探索过头或空转
  const w18 = calls.slice(-18)
  if (w18.length >= 18 && w18.every(c => c.readonly)) return 'readonly-spin'
  // B. 变体重复：最近 10 次里同一工具出现 ≥8 次，且多为失败或结果高度雷同
  //    （同指纹熔断抓不到"参数每次微变"的变体循环，这里补位）
  const w10 = calls.slice(-10)
  if (w10.length >= 10) {
    const byName = new Map<string, InspectorCall[]>()
    for (const c of w10) { const g = byName.get(c.name) || []; g.push(c); byName.set(c.name, g) }
    for (const [nm, g] of byName) {
      if (g.length >= 8) {
        const errs = g.filter(c => c.isError).length
        const distinct = new Set(g.map(c => c.result)).size
        if (errs >= 6 || distinct <= 2) return `variant-repeat:${nm}`
      }
    }
  }
  // C. 无进展：最近 30 次调用无任何进展信号（成功写/命令/汇报/子计划推进）——在动，但什么都没产出
  if (calls.length >= 30 && !calls.slice(-30).some(c => c.progress)) return 'no-progress'
  return null
}

const INSPECTOR_REVIEW_COOLDOWN_MS = 90_000
const INSPECTOR_MAX_REVIEWS_PER_RUN = 6
const INSPECTOR_MAX_CORRECTIONS = 1

function inspectorSuspectLabel(suspect: string): string {
  if (suspect === 'readonly-spin') return '连续只读（空转迹象）'
  if (suspect === 'no-progress') return '长时间无进展'
  if (suspect.startsWith('variant-repeat:')) return `重复调用 ${suspect.split(':')[1]}`
  return suspect
}

/** 巡检官挂载（随 run 生命周期；noteCall 每次工具调用后调用，disarm 在 run 收尾 finally 调用） */
function armInspector(p: {
  agent: Agent
  memberName: string
  roleText: string
  stepText: string
  taskText: string
  acceptance: string
  log: (message: string) => void
  note: (text: string) => void
  onKill: (reason: string) => void
}): { noteCall: (c: { name: string; args: string; result: string; isError: boolean; progressOverride?: boolean }) => void; disarm: () => void } {
  const calls: InspectorCall[] = []
  const flagTimes = new Map<string, number>()
  let disarmed = false
  let inFlight = false
  let reviews = 0
  let corrections = 0
  let lastReviewAt = 0
  const trigger = (suspect: string) => {
    void (async () => {
      if (disarmed || inFlight) return
      if (reviews >= INSPECTOR_MAX_REVIEWS_PER_RUN) return
      if (Date.now() - lastReviewAt < INSPECTOR_REVIEW_COOLDOWN_MS) return
      const reviewer = inspectorReviewer
      if (!reviewer) return
      inFlight = true
      reviews++
      lastReviewAt = Date.now()
      try {
        const trajectory = calls.slice(-14).map((c, i) =>
          `${i + 1}. ${c.name}(${truncate(c.args, 90)}) → ${c.isError ? '[失败] ' : ''}${truncate(c.result, 120)}`).join('\n')
        const verdict = await reviewer({
          memberName: p.memberName, roleText: p.roleText, stepText: p.stepText,
          taskText: p.taskText, acceptance: p.acceptance, suspicion: suspect, trajectory,
        })
        if (disarmed) return
        try { if (p.agent.signal?.aborted) return } catch { /* ignore */ }
        const label = verdict.verdict === 'drift' ? '偏离任务单' : verdict.verdict === 'loop' ? '陷入循环' : '正常'
        if (verdict.verdict === 'ok') {
          p.note(`巡检：检测到「${inspectorSuspectLabel(suspect)}」，复审判定正常（${truncate(verdict.reason, 80) || '继续观察'}）`)
          return
        }
        if (corrections < INSPECTOR_MAX_CORRECTIONS) {
          corrections++
          const fix = String(verdict.fix || '').trim() || '回到任务单范围，聚焦本步骤的产出本身。'
          try {
            p.agent.steer({
              role: 'user',
              content: [{ type: 'text', text: `【巡检纠偏】你被判定${label}（${truncate(verdict.reason, 120)}）。${fix}\n若任务已完成，立即用 bb_write 汇报后结束；若被阻塞，在 bb_write 的 result 里写明阻塞点，不要继续无效尝试。` }],
              timestamp: Date.now(),
            } as any)
          } catch { /* ignore */ }
          p.note(`巡检：复审判定${label}（${truncate(verdict.reason, 100)}）→ 已注入纠偏指令，再犯将中止`)
          p.log(`${p.memberName} 被判定${label}，已纠偏一次：${truncate(verdict.reason, 140)}`)
        } else {
          const reason = `巡检官中止：${label}，纠偏后仍无改善（${truncate(verdict.reason, 140)}）`
          p.note(`巡检：${label}且纠偏无效 → 已中止本次运行（${truncate(verdict.reason, 100)}）`)
          p.log(`${p.memberName} ${reason}`)
          p.onKill(reason)
          try { p.agent.abort() } catch { /* ignore */ }
        }
      } catch { /* 复审失败（网关/解析）静默：巡检是增益，不是依赖 */ }
      finally { inFlight = false }
    })()
  }
  return {
    noteCall: (c) => {
      if (disarmed || !inspectorEnabled()) return
      const fam = famClassify(c.name, c.args)
      const readonly = fam ? fam === 'readonly' : INSPECTOR_READONLY_RE.test(c.name)
      const progress = typeof c.progressOverride === 'boolean'
        ? c.progressOverride
        : ((fam ? fam === 'write' : INSPECTOR_WRITE_RE.test(c.name)) && !c.isError)
      calls.push({ name: c.name, args: c.args, result: c.result, isError: c.isError, readonly, progress, ts: Date.now() })
      if (calls.length > 60) calls.splice(0, calls.length - 60)
      if (calls.length < 10) return
      const suspect = inspectorSuspect(calls)
      if (!suspect) return
      // 同一嫌疑 2 个复审周期内不重复触发（轨迹仍在变时的自然去抖）
      const prev = flagTimes.get(suspect) || 0
      if (Date.now() - prev < INSPECTOR_REVIEW_COOLDOWN_MS * 2) return
      flagTimes.set(suspect, Date.now())
      trigger(suspect)
    },
    disarm: () => { disarmed = true },
  }
}

/* ★1005 修类型：原声明 `): () => void` —— 但实现返回的是**对象字面量**（键见下方 return），
   于是三处调用「.suspend()/.resume()/.disarm()」全被 TS 判"属性不存在"。
   运行时一直是好的（团队会话能跑）⇒ 纯类型缺口。返回类型按**实际字面量的键**生成（补丁脚本自校验过）。 */
function armWatchdog(ctx: TeamCtx, runId: string, agent: Agent, onTimeout: (reason: string) => void, ac?: AbortController, owner?: { memberId?: string; memberName?: string; stepId?: string; /** ★c1：**心跳订阅的动态解析口** —— 见下方 rebindTo 的注释。不传 = 沿用旧行为（绑死这一个 agent）。 */ resolveAgent?: () => any }): { disarm: () => void; suspend: () => void; resume: () => void; beginOp: (label: string) => void; endOp: () => void; rebindTo: (a: any) => void } {
  const started = Date.now()
  const state = {
    last: Date.now(), timer: null as NodeJS.Timeout | null, agent,
    /* ★1032（P18）：**记住 ac** —— runSubAgent 的三条收尾分支靠 `ac.signal.aborted` 判定
       "是不是用户停的"；只调 agent.abort() 不会置位 ac ⇒ 停了也当"正常完成"（标 done 而不是 interrupted）。 */
    ac,
    /* ★1104-K：这条 run 是"哪个成员的哪一步" —— member_tell（补充插话）要靠它把话送到
       正确的那一个 agent 上。看门狗本来就是运行中 run 的权威登记表，不另建一份。 */
    memberId: String(owner?.memberId || ''),
    stepId: String(owner?.stepId || ''),
    /* ★s1：成员名 —— LLM 在途打点按它归属（多成员并行时 watchdogs 里有多条，靠名字精确对上）。
       调用方手边都有 `mName`（`memberName(ctx.team, member.id)` 的结果），直接传进来即可。 */
    memberName: String(owner?.memberName || ''),
    /** 权限卡等待期间挂起（用户可能几小时不在线）：不计时、不击杀，恢复后重新起算 */
    suspended: false,
    /** 硬上限：只计非挂起时段（suspend 累积的时长在 resume 时顺延 started） */
    started,
    /* ★p1（病根 A · 方案 A）：**在途操作计数**。
       "没有事件"不等于"卡死"：等 LLM 首 token（长思考/慢网关）、跑长工具时，天然不发事件。
       旧判据只看空闲时长 ⇒ 实测把干得好好的 n1 杀了（标成"已中断"，活其实干完了）。
       现在判定 = `idle >= 阈值 && pendingOps === 0`：有东西在做就不因"没事件"判死。
       ⚠️ 但**硬上限不看在途**（见 check 里的顺序）—— 工具彻底卡死时 pendingOps 永远是 1，
       只有硬上限能回收。在途操作不是免死金牌，只是把"判死"的判断权交给操作自身超时。 */
    pendingOps: 0,
    /** 在途操作的名字（诊断用：超时时能说清卡在哪，而不是只有"无活动"三个字） */
    pendingLabels: [] as string[],
    /** ★c1：**重排 timer 的回调**（由下面 `schedule` 赋值）。
     *  为什么需要：`memberStreamOpHook`（server 侧的 LLM 在途打点）会刷 `st.last`，
     *  但**拿不到 schedule** ⇒ 只刷时间不重排 ⇒ timer 仍按"上一次排的那个时刻"触发。
     *  虽然 `check()` 里会重算 `idleMs = Date.now() - state.last` 所以不会误杀，
     *  但"刷了心跳却没重排"是隐患（一旦将来 check 改成用排程时的快照就会退化成误杀）。
     *  暴露出来让打点方把 timer 一起重排，语义才完整。 */
    reschedule: null as null | (() => void),
  }
  let runMap = watchdogs.get(ctx.sessionId)
  if (!runMap) { runMap = new Map(); watchdogs.set(ctx.sessionId, runMap) }
  runMap.set(runId, state)
  // 0911：绝对墙钟起点（不随 suspend 顺延）——无条件兜底
  const wallStarted = Date.now()
  // 排程：取「无活动余量」与「硬上限余量」的较小者——硬上限到期前即使心跳不断也会触发
  const schedule = () => {
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    if (state.suspended) return
    const caps = memberRunCaps()
    const idleIn = WATCHDOG_IDLE_MS - (Date.now() - state.last)
    const hardIn = caps.activeMs - (Date.now() - state.started)
    const wallIn = caps.wallMs - (Date.now() - wallStarted)
    state.timer = setTimeout(check, Math.max(1000, Math.min(idleIn, hardIn, wallIn)))
  }
  /* ★c1：把 schedule 挂到 state 上，供 `memberStreamOpHook`（LLM 在途打点）重排 timer。
     schedule 是 const 箭头函数，赋值发生在这里、而钩子只会在之后被调用 —— 没有 TDZ 问题。 */
  state.reschedule = schedule
  const check = () => {
    state.timer = null
    if (state.suspended) return
    /* ★c1：**判定前先确认心跳绑在"当前真正在跑"的那个 agent 上**。
       为什么必须在 check 里做、而不是只在 runPromptCore 返回后做一次：
       `getOrCreateAgent` 的重建发生在 `agent.prompt()` 之前那一瞬间，而误杀是在**跑的过程中**满 5 分钟才触发
       ⇒ 只在返回后重绑来不及（那时可能已经判死了）。这里每次判定前解析一次，成本是一次 Map.get。 */
    try {
      const cur = (owner as any)?.resolveAgent?.()
      if (cur && cur !== boundAgent) bindHeartbeat(cur)
    } catch { /* 解析失败沿用当前绑定 */ }
    // 触发时校验：已被清理（disarm/abortSubAgents）或 agent 已中止 → 跳过，不写"看门狗击杀"假日志
    if (runMap!.get(runId) !== state) return
    /* ★c1：判"是否已中止"要看**当前绑定**的 agent，不能看 armWatchdog 那一刻的旧实例：
       `getOrCreateAgent` 重建时会先 `oldAgent.abort()`（server.ts:9570）—— 旧实例**恒为 aborted**，
       拿它判会让看门狗在这一轮里永远跳过判定（既杀不掉真挂死的，也掩盖了重绑是否成功）。
       用 boundAgent（= 每次 check 前刚解析并绑定过的那个）才是"现在到底是谁在跑"。 */
    try { if ((boundAgent || agent)?.signal?.aborted) return } catch { /* ignore */ }
    const caps = memberRunCaps()
    const idleMs = Date.now() - state.last
    const totalMs = Date.now() - state.started
    const wallMs = Date.now() - wallStarted
    /* ★p1（病根 A · 方案 A）：判定拆成**两个独立层次**，顺序不能换 ——
       ① **硬上限优先、无条件生效**（activeMs / wallMs），不看在途操作。
          任务单专门强调：某个工具彻底卡死时 pendingOps 会永远是 1，若把在途操作也排除在
          硬上限之外，看门狗就永不触发、run 永远挂着。硬上限才是最后一道闸。
          Infinity = 用户选了"不设限"，那是明确选择，此处照旧尊重。
       ② **空闲判死必须 pendingOps === 0**。有在途操作时不因"没事件"判死 ——
          等 LLM 首 token（长思考/慢网关）、跑长工具本来就没事件可发，
          它们的超时由各自机制负责（工具自身 timeout / LLM 请求超时）。
       旧写法只看 idleMs（①②混在一起、且没有在途判断），实测把干完活儿的 n1 杀了。 */
    const _hardHit = (caps.activeMs !== Infinity && totalMs >= caps.activeMs)
      ? `子 agent 运行超过 ${Math.round(caps.activeMs / 60000)} 分钟上限，已被强制中止`
      : (caps.wallMs !== Infinity && wallMs >= caps.wallMs)
        ? `子 agent 运行超过 ${Math.round(caps.wallMs / 60000)} 分钟绝对上限（含权限等待），已被强制中止`
        : null
    let reason: string | null = _hardHit
    if (!reason && idleMs >= WATCHDOG_IDLE_MS) {
      if (state.pendingOps === 0) {
        reason = `子 agent 超过 ${Math.round(idleMs / 60000)} 分钟无任何活动（疑似死循环/挂死），已被看门狗中止`
      } else if (!(state as any)._loggedBusy) {
        /* 有在途操作 ⇒ 不杀，但**必须留痕**：否则"为什么没被杀"又成了查不到的黑盒。
           同一 run 只记一次，避免每 5 分钟刷一条。 */
        (state as any)._loggedBusy = true
        try {
          ctx.log('info', 'session', `[团队] ${owner?.memberId || runId} 已 ${Math.round(idleMs / 60000)} 分钟无事件，但有 ${state.pendingOps} 个在途操作（${state.pendingLabels.join('、') || '未命名'}）⇒ 不判死，等它自己的超时`)
        } catch { /* 打点失败不影响判定 */ }
      }
    }
    if (!reason) { schedule(); return }
    runMap!.delete(runId)
    notifySubAgentsIdleIfEmpty(ctx.sessionId)   // ★1005：击杀也可能清空最后一个 run
    try { agent.abort() } catch { /* ignore */ }
    onTimeout(reason)
  }
  /* ★p1b：在途操作的**唯一两个写入函数**（subscribe 里的打点与对外导出的 beginOp/endOp 都调它们）。
     定义在 subscribe 之前：订阅回调一挂上就可能在同一次事件循环里被调用，必须先有函数。
     它们做三件事（缺一都会退化）：① 改计数；② 刷心跳（不然刚 begin 就被上一轮计时判死）；③ 重排 timer。 */
  const beginOpRef = (label: string) => {
    state.pendingOps += 1
    state.pendingLabels.push(String(label || 'op'))
    if (!state.suspended) { state.last = Date.now(); schedule() }
  }
  const endOpRef = () => {
    state.pendingOps = Math.max(0, state.pendingOps - 1)
    state.pendingLabels.pop()
    if (!state.suspended) { state.last = Date.now(); schedule() }
  }
  schedule()
  /* ★p1（病根 A）：**在途操作打点收进 armWatchdog 自己的订阅**（这里就是唯一入口）。
     为什么放这儿而不是各调用方各加一遍：armWatchdog 是两条派发路径（runSubAgent 走私有 agent、
     runMemberTurn 走成员会话 agent）**共同**的登记点 —— 放在这里，两路自动一致，
     不会出现"新建路径打了、复用路径忘了"的两头补丁。
     它同时承担原心跳职责：非 error/retry/abort 事件刷新 last（0911 修正：429 风暴时
     error 事件刷心跳会让"无活动超时"永不触发，商城实验实锤挂 35 分钟）。

     ★p1d（**这里只记工具，不记 LLM** —— 上一版用 turn_start/turn_end 是错的，实测证据）：
     病：pi 的失败路径 **只发 turn_end、不发 turn_start**
       （agent.js:376-379：message_start → message_end → turn_end → agent_end，全程没有 turn_start）
       ⇒ 那种情况下 `turn_end` 会凭空 -1，把**其它在途操作**（正在跑的工具/LLM）的计数误抵消。
       `Math.max(0, …)` 只能防负数，防不了**错配** —— 这是真 bug，不是理论风险。
     （顺带更正一个事实：`turn_start` 并非"不存在"，它在 agent-loop.js:51/69/113 有 3 处 emit；
       只是在 agent.js 里 0 次。主审只搜了 agent.js 所以判成"不存在"。但结论仍然成立：
       拿 turn_* 跟工具共用一个计数器会错配，所以这条路不能用。）
     正确做法：**LLM 在途计数放到 streamFn 包装层**（那里天然成对 —— 一次调用一个 begin、
       stream 结束一个 end，与工具计数互不干扰）。见 server.ts 的 memberStreamOpHook。 */
  /* ★c1：**心跳订阅改成可重绑** —— 这是"成员干完活却被判已中断"的真根因。
     病（实测 b1 / m2，14:34:20 派发 → 14:39:23 被「5 分钟无任何活动」杀，而它 14:34~14:39 一直在调工具）：
       ① `runMemberTurn` 先 `ctx.ensureMemberAgent(sid)` 拿到 agent 实例 A，`armWatchdog(..., A, ...)`
          在 A 上 `subscribe` 心跳；
       ② 紧接着 `ctx.runPromptCore(sid, ...)` → server 的 `getOrCreateAgent(sid)` 会用
          `configFingerprint(sessionId)` 比对指纹；**不一致就 `agent.abort()` + `agents.delete` + 重建新实例 B**
          （server.ts:9569-9575「检测到预设/团队/MCP 配置变更，已重建 agent」）；
       ③ 真正跑这一轮的是 **B**，工具事件全发在 B 上 ⇒ 订阅在 A 上的心跳**一次都收不到**
       ④ ⇒ `state.last` 永远停在 armWatchdog 那一刻 ⇒ 满 5 分钟按"无任何活动"判死。
       （顺带解释了为什么"父会话日志里看门狗日志有、但看起来不像被杀" —— 它**确实**被杀了。）
     ⇒ 修法：把订阅收进 `bindHeartbeat(target)`，并用 `owner.resolveAgent?.()` 在每次 `check()` 时
        重新解析当前真实 agent；发现换了就解绑旧的、绑新的。**不新增任何兜底/估算** ——
        心跳仍然只来自真实事件，只是"从哪个实例收"这件事不再靠一次性快照。 */
  let boundAgent: any = null
  let unsubscribeBound: (() => void) | null = null
  const bindHeartbeat = (target: any) => {
    if (!target || typeof target.subscribe !== 'function') return
    if (boundAgent === target) return
    /* 解绑旧实例（pi 的 subscribe 返回取消函数时才解；没有返回值就只丢引用，不会重复计数：
       旧实例已被 server abort 掉，不再发事件） */
    try { if (typeof unsubscribeBound === 'function') unsubscribeBound() } catch { /* ignore */ }
    unsubscribeBound = null
    boundAgent = target
    try {
      const off = target.subscribe((heartbeatEvt: any) => {
        const et = String(heartbeatEvt?.type || '')
        /* 在途操作：只记工具（成对、同源）。
           ★p1b：统一走 `beginOpRef` / `endOpRef`（不直接改 state）——
           理由：① 函数里带"刷心跳 + 重排 timer"，直接改 state 会漏掉，导致刚 begin 就被上一轮计时判死；
                 ② 让"谁在改这个计数"只有一个入口，静态可查。 */
        if (et === 'tool_execution_start') beginOpRef('tool:' + String(heartbeatEvt?.toolName || ''))
        else if (et === 'tool_execution_end') endOpRef()
        if (/error|retry|abort/i.test(et)) return
        if (runMap!.has(runId) && !state.suspended) { state.last = Date.now(); schedule() }
      })
      if (typeof off === 'function') unsubscribeBound = off as any
    } catch { /* 订阅失败不拦派发（最坏退化成旧行为：靠工具在途计数兜住） */ }
  }
  bindHeartbeat(agent)
  // 权限卡挂起/恢复接口（runSubAgent 在 beforeToolCall 前后调用）
  return {
    /* ★c1：**运行中把心跳重绑到真正在跑的那个 agent 上**。
       调用点：`runMemberTurn` 在 `runPromptCore` 返回后调一次 —— 那一刻 `getOrCreateAgent`
       可能已经因为配置变更重建过实例，重绑才能让后续工具事件真的刷到心跳。 */
    rebindTo: (a: any) => { try { bindHeartbeat(a) } catch { /* ignore */ } },
    disarm: () => {
      if (state.timer) clearTimeout(state.timer)
      runMap?.delete(runId)
      notifySubAgentsIdleIfEmpty(ctx.sessionId)   // ★1005：最后一个 run 收尾 → 通知会话层置 idle
    },
    /* ★p1b：对外暴露的 beginOp / endOp —— **就是上面那两个函数本身**（不是第二套实现）。
       出口给调用方用（比如以后要手动包一段"已知的长操作"），
       内部 subscribe 也走同一对函数 ⇒ 计数只有一个写者，静态可查（搜 beginOpRef 即可核）。 */
    beginOp: beginOpRef,
    endOp: endOpRef,
    suspend: () => {
      if (state.suspended) return
      state.suspended = true
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
      // 硬上限顺延：挂起时长不计入
      state.started += Date.now() - state.last
    },
    resume: () => {
      if (!state.suspended) return
      state.suspended = false
      state.last = Date.now()
      schedule()
    },
  }
}

// ============================================================================
// 运行时上下文（server.ts 注入，避免本文件反向依赖 server 内部状态）
// ============================================================================

/** 从子 agent 消息序列构建按时间穿插的 segments（思考/正文/工具真实顺序，前端回放用）。
 *  tool 段带 args（供前端推导团队交付物卡片：fs_write 的 path 是数据源） */
/** 成员 run 的 usage 快照（带缓存维度——LongCat 缓存命中后 usage.input 只报未命中部分，
 *  裸取 input 会把成员 token 统计压到近 0，与主 agent 胶囊口径对齐：input+cacheRead+cacheWrite）
 *
 *  ⚠️★tw1s：**这个函数已降级为 fallback，不要再当主口径用**。
 *  它的根本缺陷：**只取最后一条** assistant 消息的 usage。而一个成员 run 内有几十次 LLM 调用
 *  （每次工具调用都是一跳），最后一跳只占 2~3% ⇒ 实测漏算 97%
 *  （m1 真实 251.38M vs 黑板 2.42M；四成员合计真实 576.06M vs 黑板 9.32M）。
 *  现在主口径 = `resolveRunUsage` 的**会话账本差值**（run 开始/结束各读一次 usageTotals 求差）；
 *  本函数只在「拿不到账本 / 账本差值不可信（负数、异常大、会话被轮换、增量为 0）」时兜底。 */
export function memberUsageOf(msgs: any[]): { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined {
  const m = [...msgs].reverse().find((x: any) => x?.role === 'assistant' && x?.usage && (x.usage.input || x.usage.output || x.usage.cacheRead || x.usage.cacheWrite))
  if (!m) return undefined
  const u = m.usage
  return {
    promptTokens: u.input ?? 0,
    completionTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
  }
}

/* ══════════ ★tw1s：run 增量法（成员 token 计数的唯一主口径）══════════
 * 背景（老大 2026-11-07 实锤"计数不准"）：
 *   旧口径 `memberUsageOf(msgs)` 只取**最后一条** assistant 的 usage。一个 run 内几十次 LLM 调用，
 *   最后一跳只占 2~3% ⇒ 漏算 97%（四成员合计真实 576.06M vs 黑板 9.32M）。
 * 修法（老大已拍板方案）：
 *   ① run 开始时快照该成员**持久会话**的 `usageTotals`；
 *   ② run 结束时再读一次，**差值 = 本 run 真实消耗** ⇒ 写进 `run.usage`；
 *   ③ `memberUsageOf` 降为 fallback（拿不到账本 / 差值不可信时用）。
 * 为什么差值可信：`usageTotals` 是**单调只增**的账本（`creditHopSnapshot` 按 assistant 消息 id 幂等入账）
 *   ⇒ 会话被压缩、消息被裁剪都**不影响**它，差值就是本 run 的消耗。
 * 什么情况差值不可信（都要**显式记日志 + 回退**，宁少计不错计）：
 *   · 会话在 run 内被轮换/重建（成员开新段、分身重试换段）⇒ sessionId 变了 / 差值变负；
 *   · 差值异常大（一个 run 不可能烧到 5 亿 token）⇒ 判为"换了另一份账"；
 *   · 差值为 0 但消息里有 usage ⇒ 账本写入路径没跑到（例如成员会话没接上内容管线）。
 * ⚠️ 历史 runs 不重算（黑板上的旧 usage 保持原样）；口径切换点见 `memberTotals[成员].since`。 */

/** 成员会话的账本快照（`server.ts` 注入的 `memberUsageLedger` 返回它）。
 *  `sessionId` 用来判"还是同一个会话" —— 变了说明 run 中途换过段，差值不可用。 */
export interface MemberUsageLedgerSnapshot {
  sessionId: string
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** 单 run 账本差值的「异常大」判据（5 亿 token）：再夸张的 run 也到不了，超过即判"账本被换过"。 */
const RUN_LEDGER_DELTA_MAX = 500_000_000

/** 读一次成员会话账本（注入缺失 / 抛错 ⇒ null，**绝不打断 run**） */
function readMemberLedger(ctx: TeamCtx, memberId: string): MemberUsageLedgerSnapshot | null {
  try {
    const s = ctx.memberUsageLedger?.(String(memberId || ''))
    if (!s || !s.sessionId) return null
    const n = (v: any) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0 }
    return {
      sessionId: String(s.sessionId),
      uncached: n(s.uncached), cacheRead: n(s.cacheRead), cacheWrite: n(s.cacheWrite), output: n(s.output),
    }
  } catch { return null }
}

export interface RunUsageResolution {
  usage?: { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  /** ledger = 本 run 真实增量（主口径）；messages = 旧口径（只最后一条，偏小，仅兜底） */
  source: 'ledger' | 'messages'
  /** 回退原因（可复核；source=ledger 时为空） */
  note?: string
}

/** **run.usage 的唯一决议函数**（4 处收尾写入都走它：过程快照 / 击杀 / 异常 / 正常）。
 *  纯函数（除了 onWarn 回调），方便单测/对账。 */
export function resolveRunUsage(opts: {
  base: MemberUsageLedgerSnapshot | null
  now: MemberUsageLedgerSnapshot | null
  msgs: any[]
  onWarn?: (msg: string) => void
}): RunUsageResolution {
  const fb = memberUsageOf(opts.msgs || [])
  const warn = (m: string) => { try { opts.onWarn?.(m) } catch { /* ignore */ } }
  const base = opts.base, now = opts.now
  if (!base || !now) {
    return { usage: fb, source: 'messages', note: base ? 'ledger-unavailable' : 'no-base' }
  }
  if (base.sessionId !== now.sessionId) {
    warn(`会话在 run 内被轮换/重建（${base.sessionId.slice(0, 8)} → ${now.sessionId.slice(0, 8)}），账本差值不可用 ⇒ 回退最后一条口径`)
    return { usage: fb, source: 'messages', note: 'session-rotated' }
  }
  const d = {
    promptTokens: now.uncached - base.uncached,
    completionTokens: now.output - base.output,
    cacheReadTokens: now.cacheRead - base.cacheRead,
    cacheWriteTokens: now.cacheWrite - base.cacheWrite,
  }
  const negFields = Object.keys(d).filter(k => (d as any)[k] < 0)
  if (negFields.length) {
    warn(`账本差值出现负数（${negFields.join('/')}；base 与 now 分属同一会话却回退）⇒ 账本被重置，回退最后一条口径`)
    return { usage: fb, source: 'messages', note: 'negative-delta' }
  }
  const total = d.promptTokens + d.completionTokens + d.cacheReadTokens + d.cacheWriteTokens
  if (total > RUN_LEDGER_DELTA_MAX) {
    warn(`账本差值异常大（${total} > ${RUN_LEDGER_DELTA_MAX}）⇒ 判为账本被换成另一份，回退最后一条口径`)
    return { usage: fb, source: 'messages', note: 'delta-too-large' }
  }
  if (total === 0) {
    if (!fb) return { usage: undefined, source: 'ledger', note: 'zero-delta' }
    warn('账本本 run 增量=0 但消息里有 usage ⇒ 账本未入账（成员会话可能没接上内容管线），回退最后一条口径')
    return { usage: fb, source: 'messages', note: 'zero-delta' }
  }
  return { usage: d, source: 'ledger' }
}
/* ══════════ tw1s:end ══════════ */

function buildRunSegments(msgs: any[], opts?: { markOrphanError?: boolean }): Array<{ type: 'thinking' | 'text'; text: string } | { type: 'tool'; toolCallId?: string; name: string; status: string; result?: string; args?: any }> {
  const segs: Array<{ type: 'thinking' | 'text'; text: string } | { type: 'tool'; toolCallId?: string; name: string; status: string; result?: string; args?: any }> = []
  let cur: { type: 'thinking' | 'text'; text: string } | null = null
  /* ★p1（病根 B 的真因）：**块类型有两种命名，这里原来只认其中一种**。
     实测（成员会话 118109e0 的 2054 条消息）：块类型分布是
       `{text:102, tool_use:2332, tool_result:2332, reasoning:1413}`
     —— 全是 `tool_use` / `tool_result` / `reasoning`。
     而本函数原来只认 `toolCall` / `thinking` ⇒ **一个工具段、一个思考段都产不出来**
     ⇒ 黑板里 23/28 个 run 是 segments=0 / tools=0 / text=0（连 status=done 的也是 0）。
     这不是"没调 finish 就判 0"，是**判据与数据形状对不上**。
     server.ts 里到处是 `b.type === 'toolCall' || b.type === 'tool_use'` 的双形状写法（:9071/:12305/:14707…），
     说明"两种形状并存"是这个仓库的既有事实；本函数漏了这一层兼容。
     现在两种都认（并保持原有字段名差异：use 用 `input`、Call 用 `arguments`）。 */
  const isToolCall = (b: any) => (b?.type === 'toolCall' || b?.type === 'tool_use') && b?.name
  const thinkingText = (b: any) => (b?.type === 'thinking' ? b.thinking : (b?.type === 'reasoning' ? b.text : ''))
  for (const m of msgs) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        const th = thinkingText(b)
        if (th) {
          if (!cur || cur.type !== 'thinking') { cur = { type: 'thinking', text: '' }; segs.push(cur) }
          cur.text += th
        } else if (b?.type === 'text' && b.text) {
          if (!cur || cur.type !== 'text') { cur = { type: 'text', text: '' }; segs.push(cur) }
          cur.text += b.text
        } else if (isToolCall(b)) {
          cur = null
          segs.push({ type: 'tool', toolCallId: b.id, name: b.name, status: 'running', args: b.arguments ?? b.input })
        }
      }
    } else if (m?.role === 'toolResult' && m.toolCallId) {
      cur = null
      const t = segs.find((s: any) => s.type === 'tool' && s.toolCallId === m.toolCallId) as any
      if (t) {
        t.status = m.isError ? 'error' : 'done'
        t.result = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 160)
      }
    }
    /* ★p1：`tool_result` 也可能作为 **assistant 消息里的块**存在（本仓库实测就是这种：
       `{"type":"tool_result","toolUseId":"...","content":"..."}` 挂在 assistant.content 里）。
       所以除了上面 role==='toolResult' 的消息级形状，还要处理块级 tool_result。 */
    if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type !== 'tool_result') continue
        const id = b.toolUseId ?? b.toolCallId
        if (!id) continue
        const t = segs.find((s: any) => s.type === 'tool' && s.toolCallId === id) as any
        if (!t) continue
        t.status = b.is_error || b.isError ? 'error' : 'done'
        const body = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '')
        if (!t.result) t.result = String(body || '').slice(0, 160)
      }
    }
  }
  /* ★1032f-b（先红后灰）：**只有确认"中断/异常结束"时**才把悬空的 running 工具标 error。
     原实现无条件把所有 running 改 error —— 但 buildRunSegments 在工具**执行途中**也会被调用
     （snapshotRunProgress 每 2s / 工具开始后到 toolResult 回来之间），那一帧就把正在跑的工具画成红色，
     等 toolResult 回来再变灰 ⇒ 用户看到"每个工具先红一下再变灰"。
     "未回填"本身不区分"还在跑"和"被中断"，所以判据必须由调用方给（只有 killed/异常收尾才传 true）。 */
  if (opts?.markOrphanError) {
    for (const s of segs) {
      if ((s as any).type === 'tool' && (s as any).status === 'running') (s as any).status = 'error'
    }
  }
  return segs
}

/**
 * ★1036-S29（老大 2026-10-31 拍板"增量方案肯定要做"）：把"从消息全量重建出的段序列"
 * 合进 run 的**累积段数组** —— `run.segments` 从此**只增不改**（追加新段 / 就地更新已有段），
 * 不再整体替换。这是"数据只增不改"的落地，也是 20 个并发分身的地基：
 *   · 段一旦出现在界面上，就不会因为某一次残缺的消息快照而消失（闪的结构性根治，
 *     **不需要**再在合并处做"取更长的"那种仲裁）；
 *   · 推送只带增量（见 `server.ts` 的 pushRunSnapshot），带宽从 O(全部段 × N run) 降到 O(新增段)。
 * 身份对齐按**位置 + 类型**（tool 段额外比 toolCallId）。消息序列若在中间被插入/裁剪而错位，
 * 表现为末尾多出重复段（宁可多显示，不可丢内容），并留痕。
 */
function syncRunSegments(runRec: any, next: Array<any>): Array<any> {
  const prev: any[] = Array.isArray(runRec?.segments) ? runRec.segments : []
  const out: any[] = prev.slice()
  let mismatch = 0
  for (let i = 0; i < next.length; i++) {
    const n: any = next[i] || {}
    const p: any = out[i]
    const sameKind = !!p && String(p.type || '') === String(n.type || '')
    const sameTool = !(String(n.type) === 'tool' && n.toolCallId && p?.toolCallId && String(n.toolCallId) !== String(p.toolCallId))
    if (sameKind && sameTool) {
      /* 同一段 → 就地更新：文本取更长的（流式累积）；工具取最新状态/结果。 */
      if (n.type === 'text' || n.type === 'thinking') {
        if (String(n.text || '').length >= String(p.text || '').length) p.text = String(n.text || '')
      } else {
        if (n.status) p.status = n.status
        if (n.result != null) p.result = n.result
        if (n.args != null) p.args = n.args
        if (n.name) p.name = n.name
        if (n.toolCallId && !p.toolCallId) p.toolCallId = n.toolCallId
      }
      continue
    }
    mismatch++
    out.push({ ...n })
  }
  for (let i = 0; i < out.length; i++) out[i].seq = i
  runRec.segments = out
  if (mismatch > 0 && prev.length) {
    /* 位置对齐失败 = 消息序列被插入/裁剪过。不删已有内容（只增），留痕供排查。 */
    try {
      console.warn(`[1036-S29] 段对齐错位 ${mismatch} 处（runId=${String(runRec?.runId || '').slice(0, 8)}，prev=${prev.length} next=${next.length}）—— 已按追加处理，不丢内容`)
    } catch { /* ignore */ }
  }
  return out
}

export interface ModelOverride {
  providerId: string
  providerName: string
  base: string
  apiKey: string
  model: string
  /** 0910 协议扩展：成员独立模型随供应商带协议（createStreamFn 据此路由适配器） */
  protocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
}

export interface TeamCtx {
  sessionId: string
  team: TeamDef
  /** SSE 帧广播（bind broadcastMux） */
  broadcast: (frame: Record<string, any>) => void
  /** 会话执行日志（bind sessionLog） */
  log: (level: 'info' | 'warn' | 'error', category: 'lifecycle' | 'tool' | 'session' | 'approval', message: string, data?: any) => void
  /** 成员可用工具池（fs/记忆/联网/技能/询问，cwd=会话工作区；成员按预设白名单过滤）
   *  0910 二批 F：可选 actor 参数按实例捕获文件快照署名（并发多实例互不覆盖）
   *  0911 反馈③：可选 lock 参数按实例注入文件写锁（owner=runId；并行成员写同一文件时互斥） */
  buildMemberToolPool: (actor?: string, lock?: { owner: string; label: string }) => AgentTool<any>[]
  /** 子 agent 流工厂（包装 createStreamFn：成员模型覆盖 + 可配推理挡位（member.effort，缺省 deep）+ 中断信号桥接） */
  createSubStreamFn: (systemPrompt: string, override: ModelOverride | null, signal?: AbortSignal, effort?: string, actor?: string, onStreamNote?: (n: { kind: string; attempt: number; reason: string }) => void) => (model: unknown, context: any) => any
  /** 成员独立模型解析（失效返回 null，运行时回退共享模型并告警） */
  resolveMemberModel: (member: TeamMember) => ModelOverride | null
  /** 会话级成员技能覆盖（新对话默认空数组；TeamMemberPanel 勾选保存到本会话） */
  memberSkills: (memberId: string) => string[]
  /** 成员写类工具审批门禁（fs_write/fs_delete/run_command → 复用主会话权限卡；"本会话允许"按工具名记忆）
   *  ★1034：加第三个可选参数 `actor`（成员名）—— high_only/full_access 的**免审日志必须带 actor**
   *  （需求"能查到是谁在什么时候做了什么"）。不传时日志里记 `actor=member`。 */
  approval: (toolName: string, args: any, actor?: string) => Promise<{ block: boolean; reason?: string } | undefined>
  /** ★m1p：**派活轮次引用计数**（进入/离开各一次，唯一写者是 runMemberTurn）。
   *  为什么需要：members 工具免审的判据是"这一轮是不是派活"。旧实现用会话上的可变单值
   *  `__l5Dispatch`（写后 finally delete），在"并发重叠"与"先入队、后执行"两种情况下会提前失效 ⇒
   *  成员跑活时弹权限卡（老板亲报，实测 4.5 分钟卡在授权上）。改成计数后：
   *  进入 +1、离开 −1，归零才算这一轮真结束；>0 即免审。
   *  计数是进程内状态，不落盘（重启后没有在跑的派活 = 归零，这是正确事实）。 */
  enterDispatchTurn: (sessionId: string) => number
  leaveDispatchTurn: (sessionId: string) => number
  /** ★r3：**成员当前上下文占用 + 窗口**（给 `memberTotals` 补 ctxUsed/ctxWindow，前端画进度条）。
   *
   *  为什么做成注入而不是在 teamRuntime 里直接算：算它需要**成员会话对象**（`findMemberSession`）
   *  和**模型解析**（`resolveContextWindow` / `resolveTeamMemberModel`），这些都在 server 手上；
   *  而 `computeMemberTotals(board)` 是**纯函数**（只读 board）—— 那个性质必须保住，
   *  否则黑板的重算会变成"顺手访问会话"的隐式副作用（难测、易串台、合并落盘时会话状态不一致）。
   *  ⇒ 分工：teamRuntime 决定"什么时候把 ctx 合进 totals"，server 负责"怎么算"。
   *
   *  返回值语义（**三条铁律**）：
   *   · 返回 `null` = 拿不到 ⇒ 调用方**不写**这两个字段（不是写 0）；
   *   · 两者都是真实数字才算拿到 —— 只有一半（比如有 used 没 window）也算拿不到，
   *     因为前端要靠两者算百分比，缺一个就没意义（宁可不显示，不给半个真相）；
   *   · 绝不在 server 侧编默认窗口（比如硬编码 128K）—— 那会让进度条显示一个假的分母。 */
  memberCtxUsage?: (memberId: string) => { ctxUsed: number; ctxWindow: number } | null
  /** ★member-lifetime（替代原 `memberUsageLedgerTotal`）：**该父会话下每个成员的全历史累计**。
   *
   *  一次返回整张 Map（键 = 真实存在成员会话的 memberId），而不是"逐成员回调"：
   *   · 一帧只遍历一次会话表（原来每个成员各遍历一次，O(成员数 × 会话数)）；
   *   · **键集合由账本决定**，所以"只私聊过、没有 bb.runs 记录"的成员也能出现
   *     （原来 `mergeMemberUsageLedger` 只遍历 `memberTotals` 已有的键 ⇒ 这种成员永远不显示）。
   *
   *  口径在 `memberUsageAggregate.ts`（纯函数，可单测）：全历史 = 当前段 + 归档段 + 其中私聊；
   *  命中率 = Σ缓存读 ÷ (Σ未命中 + Σ缓存读 + Σ缓存写)，分母 = 完整输入量（三桶互斥相加）。
   *
   *  返回空 Map = 该父会话没有任何成员会话 ⇒ 调用方保持 runs 残值（标 `source:'runs'`），不写 0 冒充。 */
  memberUsageHistory?: () => Map<string, MemberUsageTotalsView>
  /** ★f1（需求）：**成员当前（未归档）那一段的用量** —— 卡片上显示的数（新开对话天然从 0 起）。
   *
   *  为什么按段而不是靠"清零"：每段都是独立 session，各自有 `usageTotals`
   *  ⇒ 开新段就是新账本，**不需要任何清零逻辑**（零状态、不会漏清也不会清错）。
   *
   *  与上面 `memberUsageHistory` 的分工（**两个口径，别混**）：
   *   · `memberUsageHistory` = **全历史累计**（`tokens` / 命中率 / 完整度）
   *   · `memberSegTotal`     = **当前段**（卡片显示 / 团队运行预算继续用它，口径不变）
   *
   *  返回 `null` = 拿不到（成员没跑过 / 这一段还没入账）⇒ 调用方**不写** `segTokens`/`segSeq`
   *  ⇒ 前端显示「—」，**绝不写 0 冒充"这一段用了 0"**。 */
  memberSegTotal?: (memberId: string) => {
    segTokens: number; segSeq: number
    promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number
    llmMs: number; runs: number
    ambiguous: boolean
  } | null
  /** ★g1：**成员当前段的运行体征**（给 `team_info` 暴露"这段是不是该换了"的依据）。
   *
   *  为什么必须由 server 注入：这三个数长在**成员会话对象**上（`contextSummaries` / `usageTotals.turns` /
   *  `memberSessionSeq`），teamRuntime 拿不到会话；而 `computeMemberTotals(board)` 是纯函数必须保住。
   *  与 r3 的 `memberCtxUsage`、d1 的 `memberUsageLedgerTotal` 同一个模式。
   *
   *  返回 `null` = 拿不到（成员没跑过）⇒ `team_info` 显示「—」，**绝不写假 0**
   *  （假 0 会让主 agent 以为"这段很干净，不用换"，正好反了）。 */
  memberSegSigns?: (memberId: string) => {
    /** 当前段已压缩次数（= contextSummaries.length，压缩的既有权威口径） */
    compactions: number
    /** 当前段跑过多少轮（= usageTotals.turns，与用量面板同一个账本字段） */
    runs: number
    /** 当前是第几段（memberSessionSeq；0=未知） */
    segSeq: number
  } | null
  /** ★L4（成员检查点）：副作用工具执行前把成员会话正文落盘。
   *  由 server.ts 注入，内部**按工具白名单过滤**（fs_write/fs_edit/fs_delete/run_command/team_dispatch/spawn_clone），
   *  只读工具（fs_read/fs_grep…）不会触发落盘 —— 白名单只在 server 那一处，团队侧不复制一份。
   *  失败不阻断工具执行（server 内部 catch + ERROR 留痕）⇒ 这里不需要 try。 */
  /* ★L4-c：第三个参数是**这次调用的** toolCall（id/name/arguments）——
     server 侧要用它的 id 记"即将执行的工具意图"（草稿 pendingTools），并在工具结束时按 id 摘除。
     不传也能跑（只落正文、不记意图），所以是可选的。 */
  checkpoint?: (memberId: string, toolName: string, toolCall?: { id?: string; name?: string; arguments?: unknown }) => Promise<void>
  /** 会话工作区 */
  workDir: () => string
  /** 会话当前使用的模型 id（跟随会话的成员也要能报出"实际跑的是哪个模型"，被中断的 run 也有标签） */
  sessionModel: () => string
  /** ★tw1s（成员 token 漏算 97% 的根治）：**成员会话的 token 账本快照**（server 注入 = 该成员持久会话的
   *  `usageTotals`）。这是"本 run 真实消耗"的权威来源：账本**单调只增**、按 assistant 消息 id 幂等入账
   *  ⇒ 结束值 − 开始值 = 本 run 全部 LLM 跳的总和（旧口径只算最后一跳，实测漏 97%）。
   *  不设 / 拿不到 / 差值不可信 ⇒ 自动回退旧口径（`memberUsageOf`），run.usageSource='messages' 留痕。 */
  memberUsageLedger?: (memberId: string) => MemberUsageLedgerSnapshot | null
  /** 计划同步（写 session.plan + broadcastPlan → 用户计划卡） */
  /* ★bd1：计划条目改成结构化的 PlanItem[] —— 前端不再从 text 里正  则解析"进行中/待审核" */
  syncPlan: (items: Array<{ text: string; done: boolean }>) => void
  /** ★0929 P1（分身黑板互丢）：spawn_clone 完成后把本次 run 快照按 toolCallId 登记进
   *  session.subRuns（随会话落盘）——injectSubRuns 的 subRuns 兜底原来只认 team_dispatch，
   *  分身一直没登记 → 刷新/黑板被清后分身气泡无从恢复。server.ts 接线；不设=不登记（老行为）。 */
  registerSubRuns?: (toolCallId: string, runs: any[]) => void
  /** ★1036-S36（**派活不阻塞**）：一批成员跑完后，把结果送回主会话的唯一入口。
   *  团队汇总携带派发批次 ID；服务端只在主会话接纳对应消息时确认投递。
   *  结算异常仍走普通通知，不冒充已结算批次。
   *  ⚠️ 不设 = 走同步老行为？不 —— 不设就没有回程，派发结果会丢。所以这是**必需**能力，
   *     只是保留可选类型以便老测试壳编译。 */
  notifyDone?: (text: string, meta?: { memberIds?: string[] } & ({ reason: 'team-summary'; batchId: string } | { reason?: never })) => void
  /** ★1036-S37：**本会话全部 run 的全量快照**（= `session.subRuns` 按 callId 展开）。
   *  为什么需要：`sub_read` 原来只读黑板 `bb.runs`，而 `persistRuns()` 有 `slice(-60)` 上限
   *  ⇒ 20 个成员跑几轮，早期子任务被挤出窗口，主 agent 回看不到自己派过什么。
   *  DSH 等价物是 `listChildren()`（从持久化会话枚举，不读黑板窗口）。 */
  listAllRuns?: () => any[]
  /** ★1032-TM（P102）：**读成员的单聊记录**（只读，最近 N 条）。
   *  为什么需要：`sub_read` 的描述一直写着"能看你和 TA 的单聊"，但实现只回了一句
   *  "去成员窗口点对话看" —— **描述在骗模型**（它会反复调 sub_read 找聊天内容）。
   *  而主 agent 确实该看得到：用户会在成员窗口里直接给成员提新要求，那些信息不进黑板，
   *  指挥官不知道就会做出与成员实际任务冲突的安排。
   *  返回**只保留人说的话**（用户发的 + 成员回的），派活单/系统注入不算"单聊"。 */
  readMemberChat?: (memberId: string, limit?: number) => Array<{ role: 'user' | 'assistant'; text: string; ts: number }>
  /** ★1032-TM（P1）：往成员的**持久会话**追加一条消息（派活任务单 / 成员回复）。
   *  这是"成员 = 一个对话窗口"的地基：派活与用户私聊共用同一个会话，tab 打开就能看到完整聊天记录。
   *  实现见 server.ts 的 `appendMemberMessage`（消息形状必须与正常消息一致，否则历史读不到）。 */
  appendMemberMessage?: (memberId: string, role: 'user' | 'assistant', text: string, meta?: any) => void
  /* ══ ★L5（成员派活走成员会话）：server.ts 注入的四个能力 ══
     为什么是四个而不是一个"帮我跑一轮"的大函数：runMemberTurn 需要**分开**用它们 ——
     先拿会话（记 beforeLen）、再拿 agent（登记中断表）、再决定要不要排队的等法。
     包成一个大函数就只能二选一：要么团队侧看不见会话（又变回黑盒），要么 server 侧替它做调度决策。 */
  /** 拿/建**成员会话**（派活与用户私聊共用的那个窗口；只找不建的老函数是 `findMemberSession`）。 */
  ensureMemberSession?: (memberId: string) => any | null
  /** 成员会话的 **agent**（★L5：中断表/看门狗要拿它 —— `session.stopMember` 靠它真的停得下来）。 */
  ensureMemberAgent?: (sessionId: string) => any | null
  /** **跑一轮** = 会话 `agent.prompt`（等本轮真结束才返回）。忙时照 `__busyPolicy` 处理。 */
  laneActivity?: (memberId: string, runId: string, queued: boolean) => void
  runPromptCore?: (sessionId: string, p: Record<string, unknown>, activityTurnId: string) => Promise<{ ok?: boolean; queued?: boolean; turnFailed?: boolean; error?: string } & Record<string, any>>
  /** 等会话真空闲（返回 false = 等到上限仍忙/仍在排队 ⇒ 调用方必须如实记未完成）。 */
  waitSessionIdle?: (sessionId: string, maxMs?: number) => Promise<boolean>
  /** ★1032（P44）：整段运行（思考/工具/正文）落进成员会话，窗口与主对话流同形 */
  /** ★1032（P45）：**成员/分身 run 的事件喂给"同一条内容管线"**（服务端 handleAgentEvent）——
   *  窗口因此和主对话一样流式（50ms 合并窗口）、收尾一跳一条落库。
   *  `endMemberRun` 只用于"被杀/异常"：那种情况 pi 不发 agent_end，得把已有过程settle掉。 */
  feedMemberEvent?: (memberId: string, event: any, agent: any) => void
  endMemberRun?: (memberId: string, agent: any) => void
  /** ★1032-TM（P1）：更新成员状态（徽标/面板的数据源）。running → done/error/interrupted。
   *  ★1104-H：**必需能力**（原来写成可选 + 调用处 `?.` + `catch{ignore}`，等于"状态没写成功也当没事"）。
   *  成员状态是徽标/面板的唯一真相，缺了它界面就只能靠猜；所以后端必须在建 ctx 时就接上。 */
  setMemberState: (memberId: string, status: 'running' | 'done' | 'error' | 'interrupted', opts?: { unread?: boolean; runId?: string }) => void
  /** ★1032（P24）：给成员开一段新对话（旧段自动归档）+ 主 agent 写的交接。 */
  newMemberSession?: (memberId: string, handoff: string) => { sessionId: string; seq: number; archived: number }
  /** ★1032f（**分身过程流实时**）：运行途中把「本 run 的最新快照」推出去（不等于 registerSubRuns 的最终登记）。
   *  为什么要这个口：后端投影（`projectTurnBlocksOf`）给 subagent 块带的 `run` 取自
   *  `session.subRuns[callId]`，而那张表原来只在「派活瞬间 / 用户中止 / 全部跑完」三处写
   *  ⇒ **运行期间投影读到的永远是派活那一刻的空 segments**。
   *  ⚠️ **团队侧不使用这个字段**（1032-fix）：
   *     团队走 `ctx.pushRunSnapshot` 就地过滤 `bb.runs`（`runSubAgent` 签名里就有 bb 和 callId，
   *     不需要中间人）；分身走这个回调是因为 `cloneRuntime` **没有 bb**，只能靠它把 run 递出来。
   *     ⇒ 这个字段现在**只有 `lite`（分身用的假 ctx）会用到**。不要因为"团队也没用"就删它。 */
  onRunSnapshot?: (runId: string, run: any) => void
  /** ★1032f：运行途中把「本批 runs 的当前快照」推给宿主（轻量通道）。
   *  与 `registerSubRuns` 的区别：**不深拷贝全部 runs、不落盘全量、不重播 anchor 帧**，
   *  只更新内存里的 `session.subRuns[callId]` 并推一帧投影（因为过程流每 2 秒一次，
   *  走 registerSubRuns 会白做几十次深拷贝 + JSON 序列化）。最终落盘仍由批次收尾的
   *  registerSubRuns 负责（那时才需要持久）。 */
  pushRunSnapshot?: (toolCallId: string, runs: any[]) => void
  /** ★0930（分身改"即派即回"）：分身批次跑完后把「分身回归」摘要送回对话
   *  （streaming→steer 插话；空闲→自动拉起一轮；失败转待办）。server.ts 接线。
   *  ★1032-TM（P93）：`meta.memberIds` = 这一批回归了哪些分身 —— 段首画头像用（与 team 的 `notifyDone` 同口径）。 */
  notifyCloneDone?: (text: string, meta?: { memberIds?: string[] }) => void
  /** ★0929 P0：spawn_clone 异常中断路径兜底击杀失控分身 */
  abortSubAgents?: () => void

}

// ============================================================================
// 小工具
// ============================================================================

function truncate(s: unknown, n: number): string {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

export function memberName(team: TeamDef, memberId: string): string {
  const m = team.members.find(x => x.id === memberId)
  if (!m) return memberId
  /* ★ 0925w（实测"分身显示成团队成员名/预设名"）：优先用成员自带显示名（m.name）——
     分身场景正是靠它显示「小螺丝 分身N」；团队成员没填 name 时回退预设名（原行为）。 */
  return (m.name || '').trim() || readAgentPreset(m.preset)?.name || m.preset
}

/** ★1104-L：**一行版**计划快照 —— 只给"有哪些 stepId / 谁负责 / 到哪一步了"。
 *  ⚠️ 为什么不拼进 systemPrompt（1104-I 的教训，实测缓存被打穿）：
 *  system 是请求的**最前端**，往里加任何会变的东西，一变就是**整段前缀作废**（实测 292,251 token
 *  全价重算，日志「前缀头变了（system）」与「步骤 g4 审核通过」同一秒）。
 *  所以计划快照只放在**追加型**消息里（团队回归通知 / 工具回执）——历史是纯追加的，缓存不受影响。
 *  也没有 status 高频字段：running/review 随成员跑动一直在变，放进任何持久文本都是噪音。 */
export function planLine(sessionId: string): string {
  const bb = loadBlackboard(sessionId)
  if (!bb || !bb.goal) return ''
  const parts = bb.steps.map(s => `${s.id}→${s.owner}${s.status === 'done' ? '(已完成)' : ''}`)
  return `【当前计划·第 ${Number(bb.planRev || 0)} 版】${truncate(bb.goal, 40)}｜${parts.join('、')}`
}

/** ★bd1：**计划卡条目（结构化）** —— 老板铁律「后端是唯一源，前端不推断」。
 *  病根（1105 前）：状态被**拼进 text 文本**（"（小明 正在做，第 2 次）"），前端只能靠**解析文本**猜状态
 *  ⇒ 文案一改前端就瞎，分组/胶囊数字更无从谈起。现在把原始 StepStatus 原样传出。
 *  ⚠️ **text 本期保持原样**（仍带状态词）：PlanCard 还没迁到 status 渲染，现在删词会变成
 *     "什么状态都看不出来"。等前端迁移完成再清理（两步走）。 */
export interface PlanItem {
  /** 稳定 id（＝步骤 id，前端做 key / 定位用） */
  id: string
  /** 展示文案（[成员名] 步骤描述 + 状态词；**旧前端照旧吃它**） */
  text: string
  /** 原始 StepStatus 原样传出：pending / running / review / done / rejected / failed / interrupted */
  status: string
  /** 兼容旧前端：只有 done 才 true */
  done: boolean
  /** 成员 id（前端按人分组） */
  owner?: string
  /** 成员显示名（前端分组/头像，省得再查成员表） */
  ownerName?: string
}


/* ══════════ bd1-decisions: 待确认清单（只有 open；答完即删）══════════ */

const DECISION_TOMBSTONE_MAX = 50
const DECISION_MAX = 20

/** 墓碑并集（append-only，封顶 50）：两侧都并，顺序稳定 */
function mergeDecisionTombstones(a: unknown, b: unknown): string[] {
  const out: string[] = []
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue
    for (const x of src) {
      const id = String(x || '').trim()
      if (id && !out.includes(id)) out.push(id)
    }
  }
  return out.slice(-DECISION_TOMBSTONE_MAX)
}

/** 单条归一化（截断 + 空字段不落盘）—— 所有入口都过它，落盘/下发的形状就唯一 */
function normalizeDecision(d: any): BlackboardDecision {
  const out: BlackboardDecision = {
    id: String(d?.id || ''),
    question: truncate(d?.question, 300),
    createdAt: Number(d?.createdAt) || Date.now(),
  }
  const ctxText = String(d?.context || '').trim()
  if (ctxText) out.context = truncate(ctxText, 600)
  const opts = Array.isArray(d?.options) ? d.options.map((o: any) => String(o || '').trim()).filter(Boolean).slice(0, 6) : []
  if (opts.length) out.options = opts
  return out
}

/** 待确认清单合并：**墓碑优先（删除赢）** + 同 id 以 local 为准 + 按 createdAt 排序。
 *  空问题的脏条目直接丢（不给前端留空气泡）。 */
function mergeDecisions(fresh: unknown, local: unknown, tombstones: string[]): BlackboardDecision[] {
  const dead = new Set(tombstones)
  const byId = new Map<string, BlackboardDecision>()
  for (const src of [fresh, local]) {
    if (!Array.isArray(src)) continue
    for (const raw of src as any[]) {
      const id = String(raw?.id || '').trim()
      if (!id || dead.has(id)) continue
      if (!String(raw?.question || '').trim()) continue
      const prev = byId.get(id)
      byId.set(id, normalizeDecision({ ...(prev || {}), ...raw }))
    }
  }
  return Array.from(byId.values()).sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
}

/** `bb_write(kind='decision')` 的唯一实现 —— 待确认清单的「新增 / 回答 / 直接删」。
 *  ★需求（1105）：**只有 open 一种状态**，没有 answered、没有"已答区"：
 *    · 带 question、无 decisionId ⇒ 新增一条（id 自动 dec1/dec2…，跳过墓碑与已占号）
 *    · 带 decisionId + answer      ⇒ 答了：**删掉这条**并把答案交回调用方（要落地就再加步骤）
 *    · 带 decisionId + remove      ⇒ 直接删（老板答"不做"＝删）
 *  ⚠️ 绝不阻塞：这里只记不问，计划卡照常推进；用户不回答也不影响任何派发。 */
function bbDecisionWrite(ctx: TeamCtx, bb: Blackboard, params: any): { content: Array<{ type: 'text'; text: string }>; details: any } {
  if (!Array.isArray(bb.decisions)) bb.decisions = []
  if (!Array.isArray(bb.decisionTombstones)) bb.decisionTombstones = []
  const list: BlackboardDecision[] = bb.decisions
  const tombs: string[] = bb.decisionTombstones
  const idArg = String(params?.decisionId || '').trim()
  const question = String(params?.question || '').trim()
  const answer = String(params?.answer || '').trim()
  const remove = params?.remove === true
  const openLine = () => (list.length
    ? '当前待确认 ' + list.length + ' 条：' + list.map(d => d.id + '「' + truncate(d.question, 24) + '」').join('、')
    : '当前没有待确认项')

  const tombstone = (id: string) => {
    if (!tombs.includes(id)) tombs.push(id)
    while (tombs.length > DECISION_TOMBSTONE_MAX) tombs.shift()
  }

  /* ── 针对某一条：回答 或 删除 ── */
  if (idArg) {
    const idx = list.findIndex(d => d.id === idArg)
    if (idx < 0) throw new Error('待确认项不存在：' + idArg + '。' + openLine() + '。要新增请只传 question（不要传 decisionId）')
    if (!answer && !remove) throw new Error('decisionId=' + idArg + ' 必须同时带 answer（用户怎么答的）或 remove:true（直接删）——只给 id 我不知道你要干什么')
    const cur = list[idx]
    list.splice(idx, 1)
    tombstone(idArg)
    saveBlackboard(bb)
    broadcastBB(ctx, bb)
    ctx.log('info', 'session', '[团队] 待确认项 ' + idArg + (answer ? ' 已应答' : ' 已删除'))
    const text = answer
      ? '已记录用户回答（' + idArg + '「' + truncate(cur.question, 40) + '」）：' + truncate(answer, 300) + '\n'
        + '这条已从待确认里删除（口径：答完即删，不再有已答区）。\n'
        + '如需落地：答"做" ⇒ 用 bb_goal 重写计划 / bb_write 加步骤后派发；答"不做" ⇒ 什么都不用做。\n'
        + openLine()
      : '已删除待确认项 ' + idArg + '（「' + truncate(cur.question, 40) + '」）。\n' + openLine()
    return { content: [{ type: 'text', text }], details: { ok: true, decisionId: idArg, removed: true, openCount: list.length } }
  }

  /* ── 新增 ── */
  if (!question) throw new Error('kind=decision 新增时必须带 question（一句话问清要用户拍板的事）；要回答/删除请带 decisionId')
  if (list.length >= DECISION_MAX) {
    throw new Error('待确认项已满 ' + DECISION_MAX + ' 条，先处理旧的再记新的。' + openLine() + '。'
      + '必须记就先回答/删除最不重要的那条（bb_write(kind=decision, decisionId=…, remove:true)），或者自己拍板直接做')
  }
  const used = new Set<string>([...list.map(d => d.id), ...tombs])
  let n = 1
  while (used.has('dec' + n)) n++
  const id = 'dec' + n
  list.push(normalizeDecision({ id, question, context: params?.context, options: params?.options, createdAt: Date.now() }))
  saveBlackboard(bb)
  broadcastBB(ctx, bb)
  ctx.log('info', 'session', '[团队] 待确认项已记录：' + id)
  return {
    content: [{
      type: 'text',
      text: '已记入待确认：' + id + '「' + truncate(question, 60) + '」。' + openLine() + '。\n'
        + '⚠️ 这不阻塞：**计划照常推进**，不要等用户回答、也不要为它单独收轮。用户回答后：答"做" ⇒ bb_goal/bb_write 把它变成计划步骤再派发；答"不做" ⇒ bb_write(kind=decision, decisionId=…, remove:true)。',
    }],
    details: { ok: true, decisionId: id, openCount: list.length },
  }
}

/** 黑板 → 文本。
 *  ★1032-TM（P102）：**分两档**，因为 `bb_read` 是主 agent 的**高频调用**（实测一个会话里 44 次），
 *  而全文输出实测 **15.5k 字符 ≈ 9.7k tokens/次**（29 步的会话）—— 每次巡检都把上下文烧掉一大截。
 *    · 默认（brief）：每步一行 + 80 字产出摘要 + 最近 6 条发现 —— 主 agent 判断"该派谁/该打回谁"够用；
 *    · `detail`：完整产出（400 字）、打回反馈、最近 10 条发现 —— 只在"要看某个产出到底写了什么"时用；
 *    · `stepId`：只渲染那一步（全文），其它不输出。
 *  ⚠️ 只是**少给字**，一个字都没删：真要看细节给 detail/stepId 就能拿到全部。
 */
function formatBB(bb: Blackboard, opts?: { detail?: boolean; stepId?: string }): string {
  const detail = opts?.detail === true
  const only = String(opts?.stepId || '').trim()
  const stepsSrc = only ? bb.steps.filter((s) => String(s.id) === only) : bb.steps
  if (only && !stepsSrc.length) return `黑板上没有这一步：${only}（现有步骤：${bb.steps.map((s) => s.id).join('、') || '无'}）`
  const steps = stepsSrc.map(s => {
    const deps = s.deps.length ? `（依赖 ${s.deps.join('、')}）` : ''
    const extra: string[] = []
    if (s.result) extra.push(`产出：${truncate(s.result, detail ? 400 : 80)}`)
    if (detail && s.artifacts?.length) extra.push(`产物：${s.artifacts.join('、')}`)
    if (detail && s.feedback) extra.push(`打回反馈：${truncate(s.feedback, 200)}`)
    if (s.attempts > 1) extra.push(`已派发 ${s.attempts} 次`)
    return `- [${s.status}] ${s.id}（${s.owner}）${s.text}${deps}${extra.length ? '\n  ' + extra.join('\n  ') : ''}`
  }).join('\n')
  const findings = only
    ? ''
    : (bb.findings.length
      ? bb.findings.slice(detail ? -10 : -6).map(f => `- [${f.by}] ${truncate(f.text, detail ? 240 : 100)}`).join('\n')
      : '（无）')
  const head = `# 黑板（${bb.teamId}）\n目标：${bb.goal}\n${bb.acceptance ? `总验收标准：${bb.acceptance}\n` : ''}计划：\n${steps}`
  /* ★bd1：**待确认区**（只列 open 的）—— bb_read 的 brief 也带出：主 agent 一巡读就知道
     "哪些事还等着需求"，不用再翻别处；stepId 单步视图下不渲染（免得像那一步的内容）。 */
  const decisionsBlock = (only || !bb.decisions || !bb.decisions.length) ? '' : (
    '\n待确认（open，等用户拍板；答了用 bb_write(kind=decision, decisionId=…, answer=…)，答"不做"用 remove:true）：\n'
    + bb.decisions.map(d => {
      const c = d.context ? '（' + truncate(d.context, detail ? 200 : 90) + '）' : ''
      const o = d.options?.length ? '\n  可选：' + d.options.join(' / ') : ''
      return '- ' + d.id + ' ' + truncate(d.question, detail ? 240 : 120) + c + o
    }).join('\n')
  )
  const tail = findings ? `\n发现：\n${findings}` : ''
  /* 终态汇总是给用户看的结论，摘要档也给全（它本来就是"最后要给出去的那段话"） */
  /* ★h5：成员累计 token 一行（唯一权威口径，已含被封顶裁掉的 run；空板返回 ''） */
  const finalText = bb.finalResult ? `\n最终汇总：${truncate(bb.finalResult, detail ? 800 : 400)}` : ''
  const hint = detail || only ? '' : '\n（摘要视图：要某一步的完整产出用 bb_read(stepId=…)；要全部细节用 bb_read(detail=true)）'
  return head + decisionsBlock + tail + memberTotalsLine(bb) + finalText + hint
}

/** ★r3：把**成员当前上下文占用**合进 `bb.memberTotals`（就地改 bb，不返回新对象）。
 *
 *  为什么放在这里（broadcastBB 之前）而不是 `computeMemberTotals` 里：
 *   · `computeMemberTotals(board)` 是**纯函数**（只读 board、可单测、不碰会话）—— 这个性质要保住，
 *     否则黑板重算就变成"顺手访问会话"的隐式副作用；
 *   · 而 ctx 数据只能从**成员会话**算（需要 `findMemberSession` + 模型窗口解析），那在 server 手上；
 *   · `broadcastBB` 是"黑板变了要告诉前端"的**唯一集中出口**（20+ 处调用都过这里），
 *     而且天然有 `ctx`（能拿 sessionId）与 `bb`（要补的对象）⇒ 在这里合最省、最不会漏。
 *
 *  三条铁律（对应任务单）：
 *   ① **拿不到就不写**：`ctx.memberCtxUsage` 返回 null（或没注入）时，**不动** memberTotals
 *      —— 绝不写 0 冒充"用了 0"，也不写估算值；
 *   ② **不改现有字段语义**：只加 `ctxUsed` / `ctxWindow` 两个键，tokens/hit/cache/uncached/output 一个不碰；
 *   ③ 纯函数性质不变：`computeMemberTotals` 一行不改。
 *
 *  ⚠️ 只改**内存里的 bb**（broadcast 出去的这份），**不触发额外落盘**：
 *     ctx 是"此刻的瞬时值"，把它写进盘上会让"上次落盘时的占用"看起来像当前值（更误导）。
 *     盘上的 memberTotals 永远是 token 累计（持久事实），ctx 只随实时帧下发。 */
function mergeMemberCtxUsage(ctx: TeamCtx, bb: Blackboard): void {
  const probe = ctx.memberCtxUsage
  if (typeof probe !== 'function') return          // 未注入 ⇒ 什么都不做（不写字段）
  const totals: any = (bb as any)?.memberTotals
  if (!totals || typeof totals !== 'object') return
  for (const mid of Object.keys(totals)) {
    const rec: any = totals[mid]
    if (!rec || typeof rec !== 'object') continue
    let got: { ctxUsed: number; ctxWindow: number } | null = null
    try { got = probe(mid) } catch { got = null }   // 算失败 = 拿不到（不阻断广播）
    if (!got) continue                              // ← 拿不到就跳过，不写键
    const used = Number(got.ctxUsed)
    const win = Number(got.ctxWindow)
    /* 两者都必须是**有限正数**才算拿到：
       · used 允许为 0（新会话确实没占用），但 window 必须 > 0（分母为 0 算不出百分比）；
       · 任何一个不是有限数 ⇒ 视为拿不到（绝不写 NaN/Infinity 出去）。 */
    if (!Number.isFinite(used) || used < 0) continue
    if (!Number.isFinite(win) || win <= 0) continue
    rec.ctxUsed = Math.round(used)
    rec.ctxWindow = Math.round(win)
  }
}

/** ★f1：把**当前段的用量**合进 `memberTotals`（卡片显示用；老板：新开对话就清 0）。
 *
 *  与 `mergeMemberUsageLedger`（全历史累计）**并存不冲突**：写的是不同字段
 *  （`tokens` = 全历史 / `segTokens` + `segSeq` = 当前段）。
 *  为什么不塞进 mergeMemberUsageLedger：那个的 probe 返回 null 时要**保留 runs 累计**
 *  （有值可显示），而段读数拿不到时语义是"这一段没有数" ⇒ 两个字段的缺省含义不同，
 *  合在一个循环里会互相污染（拿不到段 ≠ 要回退 runs）。拆开，各自判断。
 *
 *  拿不到 ⇒ **删掉这两个键**（前端显示「—」），而不是留着上一次的数：
 *  `segTokens` 的语义是"**当前段**的累计"，不是"最近一次已知值" ——
 *  段被归档/换成新空段之后还留着旧段的数字，就是在拿旧事实冒充当前事实，
 *  这与"拿不到就不写"（`mergeMemberCtxUsage` 的做法）在**语义上不同**：
 *  ctx 是瞬时占用、留旧值只是过期；这里留旧值会直接显示成"这一段用了 X"（错段）。 */
function mergeMemberSegUsage(ctx: TeamCtx, bb: Blackboard): void {
  const probe = ctx.memberSegTotal
  if (typeof probe !== 'function') return
  const totals: any = (bb as any)?.memberTotals
  if (!totals || typeof totals !== 'object') return
  for (const mid of Object.keys(totals)) {
    const rec: any = totals[mid]
    if (!rec || typeof rec !== 'object') continue
    let got: ReturnType<NonNullable<TeamCtx['memberSegTotal']>> = null
    try { got = probe(mid) } catch { got = null }
    const tk = got ? Number(got.segTokens) : NaN
    if (!got || !Number.isFinite(tk) || tk < 0) {   // 拿不到 / 非有限数 ⇒ 明确"当前无值"
      delete rec.segTokens
      delete rec.segSeq
      continue
    }
    rec.segTokens = Math.round(tk)
    const sq = Number(got.segSeq)
    /* 段号未知（0）就**不写** segSeq —— 让前端显示「—」，而不是编一个"第 0 段" */
    if (Number.isFinite(sq) && sq > 0) rec.segSeq = Math.round(sq)
    else delete rec.segSeq
    /* ★member-lifetime：>1 个未归档段（数据异常）⇒ 明确标出，别让"当前段"看起来毫无歧义 */
    if (got.ambiguous) rec.segAmbiguous = true
    else delete rec.segAmbiguous
  }
}

function broadcastBB(ctx: TeamCtx, bb: Blackboard): void {
  try {
    /* ★r3：广播前补上成员上下文占用（拿不到就不写，见 mergeMemberCtxUsage 的三条铁律）。 */
    mergeMemberCtxUsage(ctx, bb)
    /* ★d1：再把用量累计切成「成员会话账本」口径（含私聊、不受 runs 封顶影响）。
       顺序无所谓（两者写的是不同字段），但都必须在 `JSON.parse(JSON.stringify(bb))` **之前** —— 否则改动只落在内存、帧里没有。 */
    mergeMemberUsageLedger(ctx, bb)
    /* ★f1：再把**当前段用量**合进去（`segTokens`/`segSeq`，卡片显示用；老板：新开对话清 0）。
       与全历史累计并存：`tokens` 保持不动，只是多两个只读字段。 */
    mergeMemberSegUsage(ctx, bb)
    ctx.broadcast({ type: 'session/blackboard', sessionId: ctx.sessionId, blackboard: JSON.parse(JSON.stringify(bb)) })
  } catch { /* ignore */ }
}

/** ★d1/★member-lifetime：**把「成员会话账本」的全历史用量合进 `memberTotals`** —— 唯一数据源入口。
 *
 *  病（实测两次，两个不同的坑）：
 *   ① m3 的会话账本有 6.6M token，但 `memberTotals.m3.tokens = 0` —— 因为只累加 `bb.runs`，
 *      而那条 run 的 `usage = {}`；私聊更是一分都不计（私聊不走 `runMemberTurn`、不写 bb.runs）。
 *   ② 改成读账本后仍然只读 `findMemberSession`（**未归档段**）⇒ 归档段的消耗全丢
 *      （实测 m4：当前段 280.9M，全部段 732.9M，漏 61.7%）——"全历史"是假的。
 *
 *  现在的口径（唯一，纯函数在 `memberUsageAggregate.ts`）：
 *   · `tokens` = 该成员**全部段**（当前 + 归档 + 其中私聊）的 `usageTotals` 相加；
 *   · `hitRate` = Σ缓存读 ÷ (Σ未命中 + Σ缓存读 + Σ缓存写)，先求和再相除，分母 = 完整输入量；
 *   · `usageStatus` 明确 complete / partial（有缺账段，合计是部分和）/ empty（真 0）；
 *   · **键集合 = 账本里的成员**（并入 `memberTotals`），所以"只私聊过、没有 run 记录"的成员也会出现。
 *
 *  为什么放在这一层（和 r3 的 mergeMemberCtxUsage 完全同一个模式）：
 *   `computeMemberTotals(board)` 是纯函数（只读 board、可单测），必须保住；
 *   "读成员会话账本"需要 server 的能力（会话对象 + 骨架升级）⇒ 由 `ctx.memberUsageHistory` 注入。
 *
 *  拿不到（空 Map）⇒ **什么都不改**，只把 `source` 标成 `'runs'`、`usageStatus='none'`，
 *  让 `computeMemberTotals` 的 runs 残值原样留着 —— 排查时一眼分清"真值"与"只有 runs 的残值"。 */
function mergeMemberUsageLedger(ctx: TeamCtx, bb: Blackboard): void {
  const probe = ctx.memberUsageHistory
  if (typeof probe !== 'function') return      // 未注入 ⇒ 保持原样（不标 source，等同"没跑过合并"）
  let views: Map<string, MemberUsageTotalsView> | null = null
  try { views = probe() } catch { views = null }
  if (!views) return
  const totals: any = (bb as any)?.memberTotals
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return
  /* 补键 + 覆盖 + 残值标记只有一份实现（纯函数，已单测）。 */
  mergeViewsIntoMemberTotals(totals, views)
}

/** 步骤依赖环检测（Kahn）：有环直接拒绝建计划 */
function detectCycle(steps: BlackboardStep[]): string | null {
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const s of steps) {
    indeg.set(s.id, s.deps.length)
    out.set(s.id, [])
  }
  for (const s of steps) {
    for (const d of s.deps) {
      out.get(d)?.push(s.id)
    }
  }
  const queue = steps.filter(s => (indeg.get(s.id) || 0) === 0).map(s => s.id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const next of out.get(id) || []) {
      const v = (indeg.get(next) || 0) - 1
      indeg.set(next, v)
      if (v === 0) queue.push(next)
    }
  }
  return visited === steps.length ? null : steps.filter(s => (indeg.get(s.id) || 0) > 0).map(s => s.id).join('、')
}

// ============================================================================
// 子 agent 运行（用完即焚）
// ============================================================================

/* ★1032-C-1a-2b-3（**机制退役 + 墓碑**）：这里原来有一份「run 事件帧内存注册表」
   （`activeRunFrames` Map / `bufferRunFrame` / `listActiveRunFrames` / 400 帧帽 / 30 分钟 TTL），
   作用是：run 事件帧只广播不落盘，刷新后前端只能等新帧重建卡片（计时/segments 全归零）
   ⇒ 按 runId 缓存帧，开窗/刷新时经 `blackboard.read.activeRuns` 下发，前端重放重建。

   **为什么删**：这个过程数据的职责已经**移到后端**了 ——
   `pushRunSnapshot`（1032f，`server.ts:7192`）每 2 秒把 run 最新快照写进 `session.subRuns`
   并重推投影帧 ⇒ 投影直接读 `subRuns` 就够，前端不再需要重放帧
   （`handleSubagentEvent` 与两处帧重放已在 2b-1 删除）。
   实测证据（175fcf02 全部 8 条 run）：`segs=37/10/13/33/35/29/53/22`、
   `tools=13/4/7/11/19/11/26/14`、`plan/usage/timing` 全有 —— 帧里有的 subRuns 都有。

   ⚠️ 删除顺序（刻意的）：2b-1 先断前端调用链，2b-3 才删生产者。
      反过来（先删生产者）会让前端立刻拿不到数据。
   ⚠️ `_verify_runframes.mjs`（1010 的验收脚本）保留为墓碑，不删 —— 抹掉它等于抹掉验收痕迹。 */


/* ═══════════════════════════════════════════════════════════════════════════════
 * ★L5（心脏手术）：**成员派活 = 往成员会话发一条消息**
 *
 * 病（返工单 §0）：同一个成员有两个入口、两套执行 ——
 *   用户跟成员说话 → `runPromptCore(成员会话)`：有历史、会压缩、有圆环/usage/落盘；
 *   主 agent 派活   → `runSubAgent` 私建 `new Agent`（`initialState` 无 messages、`sub:true` 记账被压掉）
 * ⇒ 派给成员的活，成员自己看不到（跑活的是另一个无历史 Agent），"每轮都像新开窗口"。
 *
 * 改法：派活 = 往**同一个成员会话**发一条消息。改完成员自动获得历史/压缩/圆环/usage/落盘/
 * 检查点/索引 —— 全部因为"它就是个普通会话"，不需要在团队侧再实现任何一件。
 *
 * 三条硬口径：
 *   · `runSubAgent` **一行不删**（分身 cloneRuntime 还在用）⇒ `NIS_MEMBER_VIA_SESSION=0` 立刻回滚；
 *   · 任务单**全放 message**（不进 system —— system 一变整段前缀作废，且它是全库共用的）；
 *   · `queued:true` **不等于跑完**（排队 ≠ 执行）⇒ 必须等它真开始并结束，等不到就如实报失败。
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** 回滚开关：`NIS_MEMBER_VIA_SESSION=0` ⇒ 走旧的私有 Agent 路径（runSubAgent）。默认走成员会话。 */
export function memberViaSessionEnabled(): boolean {
  return String(process.env.NIS_MEMBER_VIA_SESSION ?? '1') !== '0'
}

/** 成员这一轮"说"的正文 = 最后一条带 text 的 assistant 消息（同一轮里工具跳也在这条后面）。 */
function lastAssistantTextOf(msgs: any[]): string {
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    const m: any = msgs[i]
    if (String(m?.role || '') !== 'assistant' || !Array.isArray(m?.content)) continue
    const txt = m.content.filter((c: any) => c?.type === 'text' && c.text).map((c: any) => String(c.text)).join('')
    if (txt.trim()) return txt
  }
  return ''
}

/** 取"本轮新增的消息"（★L5）。
 *  优先按**我们那条 user 消息的持久 id** 定位：派发时把 `clientMessageId` 交给 server，
 *  它会把这条 user 消息的 id 定成那个值（与前端乐观气泡同一个机制）。
 *  为什么不能只靠 `beforeLen`：成员会话现在与用户私聊共用 —— 用户在派活期间插一句话，
 *  按长度切片就会把别人的话算成本轮产出（"结果提取"这一步宁可窄，不可宽）。
 *  找不到 id 才退回 `beforeLen`（返工单 §2.1 ⑥ 的口径），并在日志里留痕。 */
function sliceRunMessages(msgs: any[], beforeLen: number, userMsgId: string): { slice: any[]; by: 'id' | 'len' } {
  const arr = Array.isArray(msgs) ? msgs : []
  if (userMsgId) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (String(arr[i]?.id || '') === userMsgId) return { slice: arr.slice(i + 1), by: 'id' }
    }
  }
  return { slice: arr.slice(Math.max(0, Number(beforeLen) || 0)), by: 'len' }
}

/** 派活任务单（**全部作为一条 message**）。
 *  内容从 `runSubAgent` 的 sys 搬过来（团队清单 / 黑板快照 / 任务单 / 汇报纪律），
 *  但去掉了"bb_write 是唯一汇报通道"那套 —— 需求 A：**成员不挂 bb_write，正文就是产出**。 */
function buildMemberTaskMessage(ctx: TeamCtx, bb: Blackboard, step: BlackboardStep, member: TeamMember, taskText: string, acceptance: string): string {
  const mName = memberName(ctx.team, member.id)
  const roleText = String(member.role || readAgentPreset(member.preset)?.description || '').trim() || '（见任务单）'
  const teamList = ctx.team.members
    .map(m => `- ${m.id} ${memberName(ctx.team, m.id)}：${truncate(readAgentPreset(m.preset)?.description || '', 80)}`)
    .join('\n')
  /* 计划最多列 40 条（超了注明还有多少）—— 任务单是 message，长了只影响本轮，
     但也没必要把几百条计划全搬进来（那是把黑板当上下文用）。 */
  const allSteps = Array.isArray(bb.steps) ? bb.steps : []
  const planLines = allSteps.slice(0, 40).map(s => `- [${s.status}] ${s.id}（${s.owner}）${truncate(s.text, 120)}`)
  if (allSteps.length > 40) planLines.push(`- ……另有 ${allSteps.length - 40} 条未列出（与本步骤无关的可以忽略）`)
  const findingsText = (bb.findings || []).slice(-8).map(f => `- [${f.by}] ${truncate(f.text, 240)}`).join('\n') || '（无）'
  const depText = (step.deps || []).map(depId => {
    const d = bb.steps.find(s => s.id === depId)
    return `- ${depId}：${truncate(d?.result || '(无产出摘要)', 1200)}`
  }).join('\n')
  const prevDone = bb.steps.filter(s => s.id !== step.id && s.owner === member.id && String(s.status) === 'done' && s.result).slice(-1)[0]
  const lines: string[] = [
    '# 你的身份（本次派活）',
    `你是团队成员 ${member.id}（${mName}）。父会话在指挥你，你的产出会回到父会话。`,
    '',
    `你的职责：${truncate(roleText, 400)}`,
    '',
    '# 工作纪律',
    '- 只做任务单内的事，不越职责边界；不做团队派发/管理类工作（你没有这些工具）',
    `- 工作目录：${ctx.workDir()}——产出文件一律写在这里（相对路径）`,
    '- **局部改动一律用 fs_edit（old_string/new_string），不要整文件 fs_write 重写**',
    '- 有项目档案 NIS-notes.md 时：约 1MB，禁止整份 fs_read，用 project_note 按节读',
    '',
    '# 团队成员（只读参考，无法互相联系）',
    teamList,
    '',
    '# 黑板（当前进度）',
    `目标：${truncate(bb.goal, 300)}`,
  ]
  if (bb.acceptance) lines.push(`总验收标准：${truncate(bb.acceptance, 300)}`)
  lines.push('计划：', ...planLines, '已有发现：', findingsText, '')
  if (prevDone) lines.push('# 接着上一次干活（省掉重新摸索）', `你上一趟（${prevDone.id}）的产出摘要：${truncate(String(prevDone.result), 600)}`, '')
  lines.push(
    '# 你这次的任务',
    `步骤：${step.id}`,
    `任务描述：${truncate(step.text, 500)}`,
    `任务单：${truncate(taskText, 2000)}`,
  )
  if (acceptance) lines.push(`验收标准：${truncate(acceptance, 600)}`)
  if (step.feedback) lines.push(`上一次打回反馈（务必解决）：${truncate(step.feedback, 400)}`)
  if (depText) lines.push('前置依赖产出（可直接使用）：', depText)
  lines.push(
    '',
    '# 汇报方式',
    '干完直接说话（正文就是你的产出），**不要调 bb_write**（成员没有这个工具）。',
    '父会话会读你这一轮的回复。遇到障碍照实说，不要编造完成。',
  )
  return lines.join('\n')
}

/** 等"排队中的这一轮"真的跑完（★L5 §2.4）。
 *  `queued:true` 只代表"消息进了队列"，**不代表执行过** —— 把它当跑完就是假报完成。
 *  返回 false = 等不到（调用方必须如实记失败，不许当成跑过）。
 *  ★m6-member-model（二审①）：判据从"锚点之后任意 assistant"收窄到 **本轮范围内的 assistant**
 *  （`thisTurnMessages`：本轮 user → 下一条 user 之前）。原写法会把**上一轮遗留的 assistant**
 *  或**同段后续私聊轮**的产出当成"我们这轮跑完了" —— 轮次身份不能靠车道串行来保证。 */
async function waitMemberTurnRan(ctx: TeamCtx, ms: any, beforeLen: number, userMsgId: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, maxMs)
  let startedAt = 0
  for (;;) {
    let msgs: any[] = []
    try { msgs = Array.isArray(ms.messages) ? ms.messages : [] } catch { msgs = [] }
    const ours = userMsgId ? msgs.some((m: any) => String(m?.id || '') === userMsgId) : false
    const started = ours || msgs.length > beforeLen
    if (started && !startedAt) startedAt = Date.now()
    if (started) {
      const idle = ctx.waitSessionIdle ? await ctx.waitSessionIdle(String(ms.id), 60_000) : true
      if (idle) {
        const after: any[] = (() => { try { return Array.isArray(ms.messages) ? ms.messages : [] } catch { return [] } })()
        const got = thisTurnMessages(after, beforeLen, userMsgId).some((m: any) => String(m?.role || '') === 'assistant')
        if (got) return true
        /* 起了但暂时没有 assistant：给 5 秒宽限（同一轮可能先写工具），仍没有就按"跑完但无产出"返回，
           让提取环节如实报"没有产出正文" —— 不在这里编一个成功。 */
        if (startedAt && Date.now() - startedAt > 5000) return true
      }
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** ★m6-member-model（二审①）：**本轮**的消息范围 —— 以本轮 user 消息（`clientMessageId` 锚点）为起点，
 *  遇到**下一条 user 消息**就停（那是下一轮：同段私聊 / 队列里的另一轮，绝不能算进来）。
 *  找不到锚点（老数据）⇒ 从 `beforeLen` 起、同样在下一个 user 前停。
 *  ⚠️ 为什么不复用 `sliceRunMessages`：那个的语义是"从本轮 user 之后**取到末尾**"（够用于产出提取），
 *     而"本轮用了哪个模型"必须**严格绑定本轮** ⇒ 边界必须是"下一条 user 之前"。
 *  ⚠️ 导出只为**隔离实测**（真实现 + 合成消息序列），不是给别的模块用的公共 API。 */
export function thisTurnMessages(msgs: any[], beforeLen: number, userMsgId: string): any[] {
  const arr = Array.isArray(msgs) ? msgs : []
  let start = -1
  if (userMsgId) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (String(arr[i]?.id || '') === userMsgId) { start = i; break }
    }
  }
  if (start < 0) start = Math.max(0, Number(beforeLen) || 0) - 1
  let end = arr.length
  for (let j = start + 1; j < arr.length; j++) {
    if (String(arr[j]?.role || '') === 'user') { end = j; break }
  }
  return arr.slice(start + 1, end)
}


/** ★L5：把一次派发跑在**成员会话**里（一个普通会话的一轮）。
 *  与 `runSubAgent` 的分工：这里**不建 Agent、不拼 sys、不喂事件** —— 那些都是会话自己的事。
 *  这里只做调度该做的事：拿会话 → 落 run 记录 → 发消息 → 提产出 → 收尾记账。 */

/** 子 agent 的自列计划工具（0910 反馈4：成员可自己拆子任务，弱模型靠清单稳住执行节奏）。
 *  与指挥官 plan_write 隔离：只进 run 快照（前端成员气泡里显示），不碰会话计划卡。
 *  全量替换语义；每次写入广播一帧 session/subagent-event（event.type='sub_plan'）供实时显示。 */
function buildSubPlanTool(state: { items: Array<{ text: string; done: boolean }> }, onUpdate?: (items: Array<{ text: string; done: boolean }>) => void): AgentTool<any> {
  return {
    name: 'sub_plan',
    label: '成员自列执行计划',
    description: '给自己列执行计划（子任务清单，最多 12 条）：开工前写下要做的 3~6 件小事，每完成一件就重写一次清单把对应项 done 置 true。全量替换语义（每次传完整清单）',
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ description: '子任务描述（一句话，具体可核对）' }),
        done: Type.Optional(Type.Boolean({ description: '该子任务是否已完成（默认 false）' })),
      }), { description: '完整子任务清单（全量替换）' }),
    }),
    async execute(_callId, params: any) {
      const items = (Array.isArray(params?.items) ? params.items : [])
        .map((it: any) => ({ text: truncate(String(it?.text || '').trim(), 120), done: !!it?.done }))
        .filter((it: any) => it.text)
        .slice(0, 12)
      if (!items.length) throw new Error('items 不能为空：传完整子任务清单（text 必填）')
      state.items = items
      try { onUpdate?.(items) } catch { /* ignore */ }
      const doneN = items.filter(i => i.done).length
      return {
        content: [{ type: 'text', text: `计划已更新（${doneN}/${items.length} 完成）。按清单推进；全部完成后用 bb_write 汇报产出摘要（result + finish:true）。` }],
        details: { ok: true, items, done: doneN, total: items.length },
      }
    },
  }
}

/** 子 agent 的受限 bb_write：只能写自己步骤的 result/artifacts 与团队 findings。
 *  终点信号在 `finish:true`（reportState.finalized）—— 旧注释里的 reportState.final / shouldStopAfterTurn
 *  是死字段与不存在的钩子名，乙案已一并清掉（真正停点在 runSubAgent 的 finishTurn 里扫 finish 参数）。
 *  bbWriteState：限流计数（writes）+ 上限（limit），由 runSubAgent 传入——
 *  本函数是模块级工厂，不能直接引用 runSubAgent 局部变量（bbWrites 事故根因） */
/** ★by1（乙案）：一趟执行的**汇报状态**（终点信号）。
 *  `finalized` 只在 `bb_write(finish:true)` 时置 true；`interim` 是中途汇报（进度），**不是交付产出**。 */
type ReportState = { id: string; finalized: boolean; summary: string; interim: string[] }

function buildSubWriteTool(ctx: TeamCtx, bb: Blackboard, step: BlackboardStep, mName: string, reportState: ReportState, bbWriteState: { writes: number; limit: number }): AgentTool<any> {
  return {
    name: 'bb_write',
    label: '汇报黑板',
    /* ★by1（乙案）第一步（零风险，先上）：**两个语义必须写清楚** —— h4 的根因就是描述里
       完全没有"一写 result 就结束执行"这句，模型只能从"任务完成/有发现时写黑板"里推断 result 是
       "本次要说的那段话"，而"有发现"恰好鼓励它中途写。
       · finish:true + result = 任务真的做完了 ⇒ **唯一终点**，本次执行当场结束；
       · 只写 result 不传 finish = 中途进度/半截汇报 ⇒ 记进 run 进度，**不结束执行、不算交付产出**。 */
    description: '任务汇报（唯一汇报通道）：**只有在任务真正做完时才调一次** —— 必须同时带 result（产出摘要 3~6 句）+ finish:true；**finish:true 是唯一会结束本次执行的信号**。中途想记录进度/中间结论 ⇒ 用 finding（可多次写），**不要用 result**；把「记录 3/12」「已读完 A 文件」这类进度写进 result（尤其再配 finish:true）= 谎报完成，会被当成交付产出。artifacts 写产物相对路径（可选，属于终态汇报）。',
    parameters: Type.Object({
      result: Type.Optional(Type.String({ description: '**终态**产出摘要（3~6 句：做了什么/结果如何/关键决策）。⚠️ 只有配 finish:true 才算"这趟的交付产出"；不配 finish 只是过程记录，不会结束执行' })),
      finish: Type.Optional(Type.Boolean({ description: '⚠️ true = 「任务真的做完了，本次执行到此结束」。必须与 result 一起用；中途汇报**不要**传它' })),
      artifacts: Type.Optional(Type.String({ description: '产物文件相对路径，多个用分号分隔（属于终态汇报）' })),
      finding: Type.Optional(Type.String({ description: '对其他成员有用的中间发现/进度（可多次写，不结束执行）' })),
      /* ★v2：**打回后要不要自动重派**（只对 status=rejected 有意义，其它 status 忽略）。
         为什么做成显式参数而不是"让后端猜 feedback 里的意图"：
           feedback 是自由文案，靠解析它判"是不是作废"等于把结构判据建在措辞上 —— 文案一改就废，
           而且模型说"这条不用做了"有一百种写法。**意图必须由调用方明确表达**。
         为什么默认 true：v1 的「打回即重派」是老板要的闭环（打回=让它去改），
           只有"作废/方向变了/在等前置/任务单自己写错了"这几种才该关掉。 */
      repost: Type.Optional(Type.Boolean({ description: '打回后是否自动重派（默认 true，只对 status=rejected 有意义）。**填 false = 不要再派**——用于：本步作废 / 方向变了要重写计划 / 在等前置条件 / 任务单本身写错了。另外两种情况即使不传也不会重派：该步骤**从未执行过**（没跑过 = 打回通常意味着不要了），或已被 team_dispatch(supersedes) 标为取代。' })),
    }),
    async execute(_callId, params: any) {
      const result = String(params?.result || '').trim()
      const finding = String(params?.finding || '').trim()
      /* ★by1：终态只认 finish:true（字符串 "true" 也收 —— 弱模型偶尔把布尔写成字符串，
         这是**唯一交付证据**，宽松读入比让整趟作废更划算）。 */
      const finishRaw = params?.finish
      const terminal = finishRaw === true || finishRaw === 'true'
      if (!result && !finding && !terminal) throw new Error('result、finding、finish 至少给一个')
      /* ★by1（乙案）：**限流只压「过程类调用」，终态汇报永不限流**。
         · 过程类 = 不带 finish 的调用（纯 finding / 中途 result）—— 防刷屏的对象就是它们；
         · 终态   = 带 finish:true 的调用 —— 它是**唯一交付证据**，被限流就等于"活干完了却被判零产出"
                    （h3 的坑：前 4 次 finding 把第 5 次终态汇报挤掉 ⇒ 白重派一轮）。
           旧理由是"带 result 的调用会把 run 当场结束，不存在刷屏风险"—— 乙案后 run 不再因 result 结束，
           所以把豁免口径从"带 result"收窄成"带 finish"，与停点同一口径（一件事只有一个判据）。
         文案只提示、不终止（P58）：上限本意是防刷屏，不是掐任务。 */
      if (!terminal && bbWriteState.writes > bbWriteState.limit) {
        return {
          content: [{ type: 'text', text: `【提示，非失败】黑板汇报已达上限（${bbWriteState.limit} 次），后面的**过程记录**不用再写黑板了。**继续把剩下的活干完**；做完请调一次 bb_write 带 result + **finish:true** 收尾（终态汇报不受这个上限限制，一定会记账）。` }],
          details: { limited: true },
        }
      }
      /* ★by1（乙案）**终点信号 ≠ 完成判据**，两个分支彻底分开：
         · terminal（finish:true）⇒ 置 finalized + 写 step.result/artifacts（这才是**交付产出**）；
         · 只 result 不 finish ⇒ 中途汇报：只进 reportState.interim（→ run.interim），
           **绝不写 step.result** —— 否则「记录 1/12」会被审核闸门（stepHasOutput）/主 agent 当成这步的交付物，
           那正是"半途汇报被当完工"的另一半病根（数据面）。
         （任务单建议"中途汇报也更新 step.result、保留最后写的"；我改成不写 step.result ——
          step.result 是**步骤的正式产出**，被 bb_read/审核闸门/交付物三处消费，掺进进度句就是造假。） */
      if (terminal) {
        // 置位必须最先做：后续 saveBlackboard/broadcast 任一抛错都不能让 run 继续循环
        // （0831 实锤：置位放在副作用之后，异常路径 final 恒 false，成员"汇报完成"后仍连调 4-7 次）
        reportState.finalized = true
        if (result) {
          // 0910 三批：产出摘要留一份在 run 上——成员常常"只调 bb_write、不发正文"，
          // 气泡正文就空了。收尾时正文为空则用它（**只有终态汇报**能当气泡正文）。
          reportState.summary = result
          step.result = truncate(result, 2000)
          const arts = String(params?.artifacts || '').split(/[;；\n]/).map(s => s.trim()).filter(Boolean)
          step.artifacts = arts.length ? arts.slice(0, 10) : undefined
        }
      } else if (result) {
        reportState.interim.push(truncate(result, 600))
        if (reportState.interim.length > 8) reportState.interim = reportState.interim.slice(-8)
      }
      if (finding) {
        bb.findings.push({ t: Date.now(), by: mName, text: truncate(finding, 600) })
        if (bb.findings.length > 30) bb.findings = bb.findings.slice(-30)
      }
      step.updatedAt = Date.now()
      try {
        saveBlackboard(bb)
        broadcastBB(ctx, bb)
      } catch (e: any) {
        ctx.log('warn', 'session', `[${mName}] 黑板落盘/广播异常（汇报仍有效）: ${e?.message || e}`)
      }
      ctx.log('info', 'tool', `[${mName}] bb_write（${result ? `result ${result.length} 字` : ''}${terminal ? ' + finish' : ''}${finding ? ' + finding' : ''}）`)
      if (terminal) {
        ctx.log('info', 'session', `[${mName}] 终态汇报已写入黑板，本次执行结束（finish=true，finalized=${reportState.finalized}）`)
        return {
          content: [{ type: 'text', text: '终态汇报已记录（finish:true）—— 本次执行到此结束，无需再调用任何工具。' }],
          details: { ok: true, final: true, finalized: true },
        }
      }
      if (result) {
        ctx.log('info', 'session', `[${mName}] 中途汇报已记录（未结束执行，interim=${reportState.interim.length} 条）`)
        return {
          content: [{ type: 'text', text: '中途汇报已记录（**不会结束本次执行**）。继续把任务做完；全部完成后调一次 bb_write 带 result + finish:true 收尾。' }],
          details: { ok: true, final: false, interim: true },
        }
      }
      return {
        content: [{ type: 'text', text: '发现已记录，继续你的工作。' }],
        details: { ok: true },
      }
    },
  }
}




// ============================================================================
// ★1104-H：**成员串行车道**（一个人同一时刻只干一件事 —— 跨调用也成立）
// ============================================================================
/* 病根（实测 be4a425f，84 个 run）：原来的"同成员串行"只在**单次 team_dispatch 内**按 bucket/chunk 分批，
   跨调用没有任何忙闲检查 ⇒ 主 agent 后一次派活和同一成员正在跑的那件直接重叠
   （m4 两件重叠 79 秒、m3 重叠 244 秒）；而 memberStates 一人一槽，后写覆盖前写
   ⇒ 先完成那件的"未读完成"被吃掉，用户看到的是"先派的没回来、后派的先回来"。
   现在：每个成员一条串行车道。派活 = 入车道；车道空闲立刻跑，忙就排队，前一件跑完在**同一出口**取队首。
   回归通知按**调用**（callId）结算 ⇒ 排队的活跟着它前一批一起回归，两件事不会搅成一件。
   ⚠️ "忙"只认事实：车道在跑（`running`）或 黑板里该成员有存活 run（`activeRunIds` 命中）。
      不另设标志位，也就没有"标志忘了清"这种病。 */
type LaneItem = { task: any; callId: string; runId: string }
type MemberLane = { running: boolean; queue: LaneItem[] }
type CallSettle = { left: number; results: any[]; overlapWarn: string | null }

const memberLanes = new Map<string, MemberLane>()
const callSettles = new Map<string, CallSettle>()

const laneKey = (sessionId: string, memberId: string): string => `${sessionId}|${memberId}`
const callKey = (sessionId: string, callId: string): string => `${sessionId}|${callId}`

/** 该成员此刻有没有**活着**的 run（车道在跑 ∪ 黑板里该成员有存活 run）。 */
function memberRunLive(sessionId: string, memberId: string, bb: Blackboard | null): boolean {
  if (!memberId) return false
  if (memberLanes.get(laneKey(sessionId, memberId))?.running) return true
  for (const r of (bb?.runs || [])) {
    if (String(r?.memberId || '') !== memberId) continue
    if (String(r?.status || '') !== 'running') continue
    if (activeRunIds.has(String(r?.runId || ''))) return true
  }
  return false
}

/** 该成员的排队里已经有这个步骤 ⇒ 重复派发（会白跑一遍并覆盖产出）。 */
function laneHasStep(sessionId: string, memberId: string, stepId: string): boolean {
  const lane = memberLanes.get(laneKey(sessionId, memberId))
  return !!lane?.queue.some(it => String(it?.task?.stepId || '') === stepId)
}

/** 一次派发调用的结算账本：这一批全跑完才发回归通知（排队的活跟着前一批回归）。 */
function beginCallSettle(sessionId: string, callId: string, overlapWarn: string | null, tasks: any[]): void {
  callSettles.set(callKey(sessionId, callId), { left: tasks.length, results: [], overlapWarn })
}


/** 车道泵：串行跑队首，跑完在**同一个出口**取下一件。异常也必须把这一件结算掉（否则这批永远不通知）。 */

/* ★nc2：**回归通知分级**（老板：回归别打断思路 —— 全成功只发一行；有失败/需拍板才逐项展开）。
   成功口径：`done`（已审核完）与 `review`（成员跑完、等审核 —— runStepTask 的成功终态）**都算成功**；
   ⚠️ 不能按"status !== 'done' 就算失败"写：团队路径正常成功落的是 `review`，那样写会让 B 档永远不触发。
   其余（failed/error/timeout/interrupted/rejected/blocked/空状态）一律算异常 ⇒ A 档（宁可多报，不漏报）。
   另外 run 终态也判一次：judgeRunOutcome（gx2 那套 verdict）判失败时 run.status 落 'error' —— 覆盖
   "成员没 bb_write 出结果、但 run 本身失败"的漏报路径。 */
export function judgeRegressionTier(results: any[] | undefined, batchRuns: any[] | undefined): { tier: 'full' | 'brief'; reasons: string[] } {
  const reasons: string[] = []
  for (const x of (Array.isArray(results) ? results : [])) {
    const st = String(x?.status || '')
    if (x?.blocked) { reasons.push(`步骤 ${String(x?.stepId || '?')} 未派发`); continue }
    if (st === 'done' || st === 'review') continue
    reasons.push(`步骤 ${String(x?.stepId || '?')} 状态 ${st || '(空)'}`)
  }
  for (const r of (Array.isArray(batchRuns) ? batchRuns : [])) {
    const st = String(r?.status || '')
    if (st === 'done' || st === 'running') continue
    reasons.push(`run ${String(r?.runId || '').slice(0, 8)} 终态 ${st || '(空)'}`)
  }
  return { tier: reasons.length ? 'full' : 'brief', reasons }
}

/** ★nc2：A 档文案（逐项展开 + 计划行 + 审核指引 + 下一步建议 + overlapWarn）。
 *  正文与原实现逐字一致（老板只要求"全成功别展开"，A 档保持现状），末尾新增「下一步建议」。 */
export function fullRegressionText(p: {
  count: number; pendingLeft: number; lines: string[]; plan: string; hint: string; overlapWarn: string | null
}): string {
  return `【团队回归】本批 ${p.count} 项已全部结束${p.pendingLeft > 0 ? `（**全队还有 ${p.pendingLeft} 项未收尾**：等它们回归或去 bb_read 看进度，别当整件事做完）` : '（全队计划已全部收尾）'}。\n\n${p.lines.join('\n\n')}\n\n` +
    (p.plan ? `${p.plan}\n\n` : '') +
    '下一步：逐项审核——合格 bb_write(kind=step,stepId,status=done)；不合格 bb_write(status=rejected,feedback=...) 后重新 team_dispatch（同一任务累计 3 次封顶，超限上抛用户）。' +
    (p.hint ? `\n\n${p.hint}` : '') +
    (p.overlapWarn ? `\n\n${p.overlapWarn}` : '')
}

/** ★nc2：B 档文案 —— **一行**（信息一个字没少：逐项产出/产物本来就在黑板与 bb.runs 里，bb_read 拿得到）。
 *  保留未收尾数（这句很有用）+ overlapWarn + 下一步建议（老板：一醒来就知道干什么）。 */
export function briefRegressionText(count: number, pendingLeft: number, hint: string, overlapWarn: string | null): string {
  const head = `【团队回归】本批 ${count} 项完成，无异常${pendingLeft > 0 ? `（全队还有 ${pendingLeft} 项未收尾）` : '（全队计划已全部收尾）'}。要细节用 bb_read。`
  return [head, hint, overlapWarn].filter(Boolean).join('\n\n')
}

/** ★nc2：逐项摘要行（A 档正文；导出以便直接测真代码，不在测试里抄一份逻辑）。
 *
 *  ★p2（需求第 1 条 · 主 agent 降耗）：**回归消息瘦身**。
 *  病（实测）：主 agent 一轮 840 条消息 / 345,576 token，其中 tool 结果裁剪已省 46 万，
 *  说明"历史本身"才是主因；而成员回归是往里灌历史的最粗一根管子 ——
 *  旧实现每项把 `step.result` 的前 400 字原样塞给主 agent，一批 3 项就是 1200+ 字，
 *  同一条内容还躺在黑板和 bb.runs 里（重复真相）。老板原意是让主 agent 当**智囊**（少干活、多决策），
 *  它不该靠读大段成员正文来了解情况。
 *  改成三块、每项总长上限约 500 字：
 *    ① 结果一句（做了什么 / 成没成）——取自 result 的**首句**，不是前 N 字（避免半句话）；
 *    ② 产物路径（相对路径，顿号分隔）；
 *    ③ 关键决策/风险一句（result 里带"风险/决策/注意"的句子；没有就不占位）。
 *  ⚠️ **失败/打回的信息不瘦**（老板钉的）：失败原因必须完整保留 —— 主 agent 靠它决定重派方向，
 *     瘦掉就等于让它瞎猜。所以失败分支走 `failReason` 原样输出（到 400 字）。
 *  ⚠️ **只改回给模型的文本**。`step.result` 的存储是完整真相（bb_read / 面板 / 回归存档都用它），
 *     这里一个字都不动存储。 */
export function regressionDetailLines(results: any[] | undefined): string[] {
  return (Array.isArray(results) ? results : []).map((x: any) => {
    if (x?.blocked) return `[${x?.memberName}] 步骤 ${x?.stepId} 未派发：${x?.reason}`
    const st = String(x?.status || '')
    const stText = st === 'done' ? '完成' : st === 'error' ? '失败' : st === 'failed' ? '失败' : st === 'review' ? '待审核' : st || '?'
    const head = `[${x?.memberName}] 步骤 ${x?.stepId} — ${stText}${x?.attempts > 1 ? `（第 ${x?.attempts} 次）` : ''}`
    const raw = String(x?.result || '').replace(/\s+/g, ' ').trim()

    /* ── 失败/打回：原因完整保留（不瘦）── */
    const isFail = st === 'failed' || st === 'error'
    if (isFail) {
      const why = truncate(raw, 400) || '(成员未汇报原因，见黑板)'
      return `${head}\n失败原因：${why}${raw.length > 400 ? `…（完整产出用 bb_read(stepId=${x?.stepId})）` : ''}`
    }

    /* ── 成功/待审核：三块瘦身 ── */
    if (!raw) return `${head}\n结果：(成员未汇报，见黑板)`
    /* ① 结果一句：取首个句末标点前的完整句子（不是硬切 N 字 —— 半句话比没话更误导）。
       兜底：整段没有句末标点时取前 120 字（正常汇报都有标点；这条只是防"一整段无标点"的怪输入）。 */
    const m = raw.match(/^[^。！？；\n]{4,120}[。！？；]/)
    const oneLine = m ? m[0] : truncate(raw, 120)
    const parts: string[] = [`结果：${oneLine}`]
    /* ② 产物路径：优先用结构化 artifacts（权威字段）；没有就从 result 里认路径。
       匹配规则收得很紧 —— 必须**像个文件路径**：
        · 反引号包裹的（`` `path` ``，最可靠）
        · 盘符绝对路径 `D:\...`
        · 带扩展名的相对路径（`reports/audit.md`、`src/a.ts`）
       为什么要紧：宽正则会把正文里的「/server.ts（25093」这种**句子片段**当成路径
       （实测踩到：`/server.ts（25093、/服务入口层（HTTP+WS、/teamRuntime.ts（2157`），
       与其给主 agent 一堆假路径，不如少给。多个用顿号；超过 6 个折成"等 N 个"。 */
    let arts: string[] = Array.isArray(x?.artifacts) ? x.artifacts.filter(Boolean).map(String) : []
    if (!arts.length) {
      const found = raw.match(/`[^`\n]{3,120}`|[A-Za-z]:\\[^\s，。；、）)]{3,120}|\b[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}\b/g)
      if (found) arts = [...new Set(found.map(s => s.replace(/^`|`$/g, '').trim()))]
    }
    if (arts.length) {
      const shown = arts.slice(0, 6).join('、')
      parts.push(`产物：${shown}${arts.length > 6 ? ` 等 ${arts.length} 个` : ''}`)
    }
    /* ③ 关键决策/风险一句：只在 result 里**明确提到**这几类词时才取，不硬凑一句废话。 */
    const riskM = raw.match(/[^。！？；\n]{0,80}(?:风险|注意|隐患|未验证|不确定|决策|取舍|约定)[^。！？；\n]{0,120}[。！？；]?/)
    if (riskM && riskM[0].trim() && riskM[0].trim() !== oneLine) parts.push(`要点：${truncate(riskM[0].trim(), 160)}`)
    return `${head}\n${parts.join('\n')}${raw.length > 260 ? `\n（细节用 bb_read(stepId=${x?.stepId})，正文 ${raw.length} 字）` : ''}`
  })
}

/** ★nc2：「下一步建议」—— 从黑板计划算**一条**可执行的推进行（老板：一醒来就知道干什么，别每次重新 bb_read 全局）。
 *  **★nb1（实测的两个误报，一刀修掉）**：
 *   ① **排队中 ≠ 待派发**：`team_dispatch` 派出时在 step 上留 `dispatchedAt` ⇒ `status` 仍是 pending
 *      但已派出（在成员车道上等）单独报「排队中」，不再当成"从没派过"。留痕分两种口径
 *      （都按"主人手上有没有活"判，因为这两种处境给主 agent 的动作完全不同）：
 *        · **排队中** —— 主人正忙（有 running 步骤）⇒ 等它手上那件跑完自动接着做，**不用重派**；
 *        · **派出去没见开跑** —— 主人空闲却没人跑它（典型：后端重启把内存车道丢了）⇒ 别干等，重新派发。
 *      ⚠️ 本函数读的多半是**盘上**副本（settleCall 里 `bbEnd = loadBlackboard(...)`），
 *      所以留痕必须落盘（派发侧 saveBlackboard 已带 `_dispatched`），只写内存等于没留痕。
 *   ② **同一成员不并行**：可派发候选按 owner 分组，每个主人**只推 1 条**、且只在它手上**没活**时才推；
 *      忙的主人一条都不推，改成"m4 忙（在做 x）→ y 等它"，同一主人多余的写成"另有 N 项等 m4"。
 *      这就是我们自己的规矩：同一成员同一时刻只干一件事（旧实现会把 p0a/p0b/p0c 全派给 m4，纯属自相矛盾）。
 *   ③ **审核优先**：有 review 的步骤先报「待审核」（审完再派新的，否则待审核会越堆越多）。
 *  另：只有 `deps` 全 done 的 pending 才算「可派发」；最多 4 组，多出来的折成"还有 N 项"；
 *  计划为空 ⇒ 返回空串（零噪音，不出这一行）。 */
export function nextStepHint(steps: any[] | undefined, ctx?: TeamCtx, bb?: Blackboard | null): string {
  const all = (Array.isArray(steps) ? steps : []).filter(Boolean)
  if (!all.length) return ''
  /* ★hint1（**僵尸步骤**）：指挥官重派时用**新 stepId**（如 dk11b），旧 step 就永远挂在
     interrupted/failed ⇒ 建议里一直报"需重派"，主 agent 被误导重复派发（实测 dk11/dk12）。
     判据**只认事实字段**：派发侧 `team_dispatch(supersedes:[...])` 在旧步骤上写 `supersededBy`，
     这里把带该字段的步骤从「待办分组」里剔除 —— **绝不按 stepId 命名规律去猜**（老板禁兜底）。
     ⚠️ 只从"待办"里剔除；`doneIds`（deps 判定）仍用全集 all，否则被取代的前置会连带卡住后继。 */
  const list = all.filter(s => !String((s as any)?.supersededBy || '').trim())
  if (!list.length) return '下一步建议：剩下的步骤都已被后续派发取代（僵尸已清），按最新几轮回归结果收尾'
  const st = (s: any) => String(s?.status || '')
  const sid = (s: any) => String(s?.id || '')
  const ownerOf = (s: any) => String(s?.owner || '')
  const doneIds = new Set(all.filter(s => st(s) === 'done').map(sid))   /* ★hint1：deps 判定用全集，别用被过滤后的 list */
  /* ★y1（与派发硬校验**同口径**）：依赖是否已满足 —— 不能再只查 `doneIds`。
     原来只判 `doneIds.has(dep)`，于是 deps 里躺着一条被取代的僵尸（rejected，不在 doneIds 里）
     就恒为 false ⇒ 这个步骤永远被归进「等前置步骤完成」，而派发硬校验（跟着 supersededBy 链
     判接手者）却会**放行** ⇒ 前后不一致（正是本单要治的病）。
     现在复用同一个 `resolveSupersededTail`：
       · 未被取代 ⇒ 本身 done 才算满足
       · 被取代且链尾存在 ⇒ 看链尾（终态接手者）是否 done
       · 被取代但链尾不存在（如 'plan-rev' 方向级作废）⇒ 无依赖可等，算满足
       · 成环 ⇒ 算**不满足**（可疑就拦住，与硬校验一致） */
  const depsOk = (s: any) => {
    const deps = Array.isArray(s?.deps) ? s.deps : []
    const byId = new Map<string, any>(all.map((x: any) => [String(x?.id || ''), x]))
    return deps.every((d: any) => {
      const dw = byId.get(String(d))
      if (!dw) return doneIds.has(String(d))          // 依赖不在计划里：保留原判据（硬校验那边会直接抛，这里只影响"建议"分组）
      if (!String(dw.supersededBy || '').trim()) return st(dw) === 'done'
      const { final, cycle } = resolveSupersededTail(all, dw)
      if (cycle) return false                          // 环 ⇒ 不满足（可疑）
      if (!final) return true                          // 无接手者 ⇒ 无依赖可等
      return st(final) === 'done'                      // 链尾（终态接手者）done 才算真满足
    })
  }
  const idsOf = (arr: any[]) => arr.slice(0, 3).map(sid).join('/')
  const running = list.filter(s => st(s) === 'running')
  const review = list.filter(s => st(s) === 'review')
  /* ★nb4（实测 yb：status=interrupted 但 step.result 有 742 字真产出；审核闸门允许标 done，
     这里却说「执行失败/被中断」，误导主 agent 重派）：
     failed/interrupted 的归属**必须与审核闸门同一个判据** —— 直接复用 f1b 的 `stepHasOutput(step)`
     （闸门侧的 `runCountsAsExecuted` 判 interrupted 时用的就是它；全局只此一份实现，不另写一套）。
     有产出 ⇒ 归「待审核」（闸门能标 done）；零产出 ⇒ 才归「需重派」。
     ★hint1 更正：rejected **不**在这里 —— 它是指挥官主动打回的终态，"需重派"是说反话，现单独成组（见下）。 */
  const brokenAll = list.filter(s => ['failed', 'interrupted', 'rejected'].includes(st(s)))
  const reviewable = brokenAll.filter(s => st(s) !== 'rejected' && stepHasOutput(s))
  /* ★hint1（bug1）：`rejected` 是**指挥官主动打回的终态**（"方向不对 / 不想做了"），把它算进
     「需重派」等于说反话（实测：ds1b 被打回、已由 ds1c 做完，却永远在被建议"重派"）。
     它仍要出现在清单里（让主 agent 知道有被打回的），但单独一组、不给"重派"这个动作。 */
  const rejectedSteps = brokenAll.filter(s => st(s) === 'rejected')
  const broken = brokenAll.filter(s => st(s) !== 'rejected' && !reviewable.includes(s))
  const pending = list.filter(s => st(s) === 'pending')
  /* ① 已派出未开跑 = pending 且有派发留痕（dispatchedAt）。再按"主人手上有没有活"分两种处境：
       queued（主人在跑别的 ⇒ 真排队）/ orphan（主人空闲 ⇒ 车道没了，建议重派）。 */
  const runningOwners = new Set(running.map(ownerOf).filter(Boolean))
  /* ★q2（修 2）：**内存优先，盘上留痕兜底** —— 判据顺序反过来了，这是本轮的核心修正。
     病（实测）：通知说 p1d「没见开跑、建议重派」，而 team_info 显示 m4 正在做 p1d
     ⇒ 主审白重派了两轮。
     真因：旧判据 `runningOwners` 是从**黑板 steps（盘上副本）** 的 `status==='running'` 推出来的，
     而"成员此刻是否真在跑"是**内存事实**（车道 `memberLanes` + 看门狗 `watchdogs`）；
     内存→盘上的落盘有节流（saveBlackboard 不是每毫秒写），
     所以**盘上看着空、内存里在跑** ⇒ 被判成 orphan ⇒ 建议重派（纯误报）。
     修法（结构性，不是调阈值/加宽限期）：
       ① **先问内存**：该 owner 有活着的 run（`memberRunLive`：车道在跑 ∪ 黑板里存活 run）
          ⇒ 归 `queued`（真排队/真在跑），**绝不报 orphan**；
       ② 内存里没有 ⇒ 再看盘上 `dispatchedAt` 留痕 ⇒ 这时报 orphan 才是对的：
          **后端重启后内存清空**（车道 Map 没了、run 全失效），确实该重派。
     为什么两边都对：正常跑时内存有活→不误报；重启后内存空→落回盘上留痕→正确报 orphan。
     ⚠️ 为什么不用"盘上真相"作判据：盘上天生滞后（这是落盘机制决定的），拿滞后数据判断"现在有没有在跑"
        方向就错了 —— 内存才是"此刻"的唯一真相，盘上是"曾经发生过什么"的真相。两者各管一段，不能混。 */
  const queued: any[] = []
  const orphan: any[] = []
  for (const s of pending) {
    if (!(Number((s as any)?.dispatchedAt || 0) > 0)) continue
    const o = ownerOf(s)
    /* ① 内存优先：这个 owner 此刻有活着的 run 吗？（车道在跑 / 黑板存活 run）
       没有 ctx（老调用方/单测）就退回旧行为（只看 runningOwners），保持向后兼容。 */
    const liveInMemory = ctx?.sessionId
      ? (memberRunLive(ctx.sessionId, o, bb || null) || runningOwners.has(o))
      : runningOwners.has(o)
    if (liveInMemory) queued.push(s)
    else orphan.push(s)
  }
  const sentIds = new Set([...queued, ...orphan].map(sid))
  const fresh = pending.filter(s => !sentIds.has(sid(s)) && depsOk(s))   // 真·可派发：没派过 + 前置齐
  const waiting = pending.filter(s => !sentIds.has(sid(s)) && !depsOk(s))
  /* ② 每个主人只推 1 条（同一成员同一时刻只干一件事）：忙的一条不推，只是"等它"。 */
  const freePick: any[] = []
  const pickedOwners = new Set<string>()
  const busyBlocked = new Map<string, any[]>()    // 因为主人忙、这一刻派不了的可派发步骤
  const moreOfOwner = new Map<string, number>()  // 已经推过 1 条、同一主人剩下的条数
  for (const s of fresh) {
    const o = ownerOf(s) || '?'
    if (runningOwners.has(o)) {
      const cur = busyBlocked.get(o) || []
      cur.push(s)
      busyBlocked.set(o, cur)
      continue
    }
    if (pickedOwners.has(o)) {
      moreOfOwner.set(o, (moreOfOwner.get(o) || 0) + 1)
      continue
    }
    pickedOwners.add(o)
    freePick.push(s)
  }
  const groups: string[] = []
  let overflow = 0
  const add = (txt: string, n: number) => {
    if (groups.length >= 4) { overflow += n; return }
    groups.push(txt)
    if (n > 3) overflow += n - 3
  }
  /* ③ 审核优先：产出已经在手上了，先结掉（done/rejected）再派新活。 */
  if (review.length) add(`${idsOf(review)} 待审核 → 先 bb_read 审核（该 done 就 done、该打回就 rejected，别拖）`, review.length)
  /* ★nb4：状态是 interrupted/failed 但**有产出** ⇒ 与 review 同一个动作（待审核），不按失败处理。 */
  if (reviewable.length) add(`${idsOf(reviewable)} 待审核（状态 interrupted/failed 但 result 非空、闸门允许标 done）→ 先 bb_read 审核：该 done 就 done、不合格再 rejected`, reviewable.length)
  /* 待派发：一人一条；忙的主人在同一条里说清"等它"，多的写成"另有 N 项"。 */
  if (freePick.length || busyBlocked.size || moreOfOwner.size) {
    const parts: string[] = []
    if (freePick.length) parts.push(`派 ${freePick.slice(0, 3).map(s => `${ownerOf(s)} 做 ${sid(s)}`).join('、')}`)
    for (const [o, arr] of busyBlocked) {
      const doing = running.find(s => ownerOf(s) === o)
      parts.push(`${o} 忙（在做 ${doing ? sid(doing) : '别的活'}）→ ${arr.map(sid).slice(0, 2).join('/')} 等它，别并行派`)
    }
    for (const [o, c] of moreOfOwner) parts.push(`另有 ${c} 项等 ${o}`)
    const n = freePick.length + Array.from(busyBlocked.values()).reduce((a, b) => a + b.length, 0) + Array.from(moreOfOwner.values()).reduce((a, b) => a + b, 0)
    const head = freePick.length ? `${idsOf(freePick)} 待派发 → ` : '暂无可派发：'
    add(`${head}${parts.join('；')}（同一成员同一时刻只干一件事）`, n)
  }
  if (queued.length) add(`${idsOf(queued)} 排队中（已派出，等成员手上那件跑完自动接着做，不用重派）`, queued.length)
  if (orphan.length) add(`${idsOf(orphan)} 派出去了但没见开跑（派发痕迹在、车道已空——多半是后端重启丢了队列）→ 重新 team_dispatch 一次`, orphan.length)
  if (broken.length) add(`${idsOf(broken)} 需重派（执行失败/被中断、零产出、且没被后续派发取代）→ 重新 team_dispatch，并把上次跑到的位置写进任务单；**重派时带上 supersedes:['旧stepId']** 把旧步骤记为已取代（否则它会一直挂在建议里）`, broken.length)
  /* ★hint1（bug1）：rejected 单独一组 —— 动作不是"重派"，而是"要么显式重派、要么改计划"。
     ★v2：措辞跟着收紧后的重派判据改 —— 打回时**只有真正执行过、且没被取代、没显式 repost:false**
     的步骤才会自动重派；这里列出的是**当前仍停在 rejected 的**（= 自动重派没发生或已跑完又被打回），
     所以正确动作就是"显式重派 / 改计划"二选一，别说"它可能已经自动重派了"（那会让人干等）。 */
  if (rejectedSteps.length) add(`${idsOf(rejectedSteps)} 已打回（rejected＝你主动打回的终态，不是待办）→ 如仍需做请**显式** team_dispatch 重派并在任务单写清新要求；方向变了就 bb_goal 重写计划。**不要等自动重派**：它只在"该步骤真的执行过、且没被取代、且你没传 repost:false"时才会发生`, rejectedSteps.length)
  if (running.length) add(`${idsOf(running)} 仍在跑 → 等它回归`, running.length)
  if (waiting.length) add(`${idsOf(waiting)} 等前置步骤完成`, waiting.length)
  if (!groups.length) {
    const allDone = list.every(s => st(s) === 'done')
    return allDone
      ? '下一步建议：计划已全部完成 → 写 bb_write(kind=final) 汇总后答复用户'
      : '下一步建议：黑板计划没有可推进的步骤（状态异常，用 bb_read 核对）'
  }
  return `下一步建议：${groups.join('；')}${overflow > 0 ? `；还有 ${overflow} 项` : ''}`
}

/** 一件活结束 ⇒ 记进它所属调用的账；这一批全结束才发**唯一**一次回归通知。 */
function settleCall(ctx: TeamCtx, callId: string, r: any): void {
  const ck = callKey(ctx.sessionId, callId)
  const call = callSettles.get(ck)
  if (!call) {
    /* 没有账本 = 进程重启后迟到的结果（或发起它的调用已经消失）。如实记下来，不静默丢。 */
    console.warn(`[团队] 迟到结果没有结算账本（callId=${String(callId).slice(0, 8)}，步骤 ${String(r?.stepId || '?')}）—— 回归通知不重发`)
    return
  }
  call.results.push(r)
  call.left -= 1
  if (call.left > 0) return
  callSettles.delete(ck)
  try {
    /* ★1032-C0-d（**团队 run 的唯一正规落盘点**）：这一批的 run 按 callId 一次登记。
       run 本体取自 `bb.runs`（`runSubAgent` 开工时 push 的同一批对象，含 segments/tools/status）。
       ⚠️ 用 **`run.callId`** 取，不用 `step.runId`（后者每轮派发被覆盖、打回复用时会指错）。
       ⚠️ 失败的 run 也要登记 —— 否则刷新后失败卡凭空消失（那是最需要回看的东西）。 */
    const bbEnd = loadBlackboard(ctx.sessionId)
    const batchRuns = (Array.isArray(bbEnd?.runs) ? bbEnd!.runs! : []).filter((x: any) => String(x?.callId || '') === callId)
    if (batchRuns.length) ctx.registerSubRuns?.(callId, batchRuns)
    const lines = regressionDetailLines(call.results)
    /* 跑完了：用通知回到主会话（文案与旧回执同一套口径，避免主 agent 拿到两种说法）。
       ★1032-TM（P105）：**告诉它"全队还有几项没结束"** —— 成员是按批回归的，第一批回来时
       主 agent 会被唤醒，而文案只说"本批 N 项结束"，很容易以为整件事完了（实测）。 */
    /* ★f1b（P1）：口径收口到 countPendingLeft（含 failed/interrupted/rejected），别再在这里手写枚举。 */
    const _pendingLeft = countPendingLeft(bbEnd?.steps as any[])
    if (!ctx.notifyDone) {
      /* 没有回程 = 这批结果到不了主会话。**这是接线缺陷，不是"没事发生"** —— 必须喊出来。 */
      console.error('[团队] ctx.notifyDone 未接线：这一批成员结果无法回到主会话（缺陷，不是静默可接受的分支）。结果：', lines.join('\n'))
      return
    }
    /* ★1104-L：回归通知里带**一行**当前计划（哪些 stepId / 谁负责 / 谁已完成）。
       放在这里而不是系统提示：这条通知是**追加**进历史的，不会动缓存前缀（见 planLine 注释）。
       ★nc2 回归分级（老板：回归别打断思路）：全成功 ⇒ **一行**；有失败/需拍板 ⇒ 逐项展开（原样）。
       两档都带「下一步建议」（老板：一醒来就知道干什么，别每次重新 bb_read 全局再列一堆选项）。 */
    const _plan = planLine(ctx.sessionId)
    const _hint = nextStepHint(bbEnd?.steps as any[], ctx, bbEnd)
    const _tier = judgeRegressionTier(call.results, batchRuns)
    const _text = _tier.tier === 'full'
      ? fullRegressionText({
          count: call.results.length, pendingLeft: _pendingLeft, lines, plan: _plan, hint: _hint, overlapWarn: call.overlapWarn,
        })
      : briefRegressionText(call.results.length, _pendingLeft, _hint, call.overlapWarn)
    ctx.notifyDone(
      _text,
      { memberIds: call.results.map((x: any) => String(x?.memberId || '')).filter(Boolean), reason: 'team-summary', batchId: callId },
    )
    if (_tier.tier === 'full') {
      ctx.log('warn', 'session', `[团队] 回归走 A 档（逐项展开）：${_tier.reasons.slice(0, 3).join('；')}`)
    }
  } catch (e: any) {
    /* 结算/通知异常：**必须如实报给主会话** —— 否则主 agent 永远等不到回归，界面看起来像什么都没发生。 */
    const msg = `【团队结算异常】派发批次结算失败：${String(e?.message || e).slice(0, 300)}`
    console.error('[团队] ' + msg, e)
    /* ★fx1（Bug3）：这条回执原来前缀是【团队】（不在 INJECT_MARKERS 里 ⇒ 标签空）且不带身份 ⇒ 段首只有两条线。
       前缀已改【团队结算异常】并登记 kind；身份**有就传**（结算异常时 call.results 可能只有一部分，不编）。 */
    const _ids = Array.isArray((call as any)?.results)
      ? (call as any).results.map((x: any) => String(x?.memberId || '')).filter(Boolean)
      : []
    ctx.notifyDone?.(msg, _ids.length ? { memberIds: _ids } : undefined)
  }
}

// ============================================================================
// 指挥官工具集（team-lead 主 agent 挂载）
// ============================================================================

/** ★1104-K：派发时自动补建步骤用的 id —— 取最小可用的 `d{n}`（与计划里 s/g/h 系列不撞）。
 *  只用"分配一个没人占的名字"这一件事，不复用 planRev 计数（重写计划后编号可以回收）。 */
function nextDispatchStepId(bb: Blackboard): string {
  const used = new Set((bb.steps || []).map(s => String(s?.id || '')))
  for (let i = 1; i < 1000; i++) if (!used.has(`d${i}`)) return `d${i}`
  return `d${Date.now().toString(36)}`
}

/** ★y1：**跟到 supersededBy 链的最终接手者**（派发硬校验用）。
 *
 *  语义：C 依赖 A，A 被 B 取代 ⇒ 真正该等的是 B；B 又被 C 取代 ⇒ 等 C……直到链尾。
 *
 *  返回：
 *   · `{ final: 步骤对象, cycle: false }` —— 链尾是一个**真实存在**的步骤，按它的 status 判
 *   · `{ final: null, cycle: false }`    —— 链尾指向**不存在的 id**（实测：g2 → 'plan-rev'）
 *   · `{ final: 环上某步, cycle: true }` —— 成环（A→B→A），调用方必须按**阻塞**处理
 *
 *  为什么"不存在"和"成环"要分开（这是本函数唯一需要解释的设计点）：
 *   · **不存在** = `supersededBy` 指向一个非步骤的语义值（如 'plan-rev' 表示"方向级作废"）。
 *     这种情况**压根没有接手者**，也就没有"没做完的接手者"让后继去等 ⇒ 不阻塞。
 *   · **成环** = 有接手者但追不到底（数据可疑/被手工改坏）。可疑就不放行 —— 后端是硬闸门，
 *     放行了要真烧钱，宁可拦住让人修计划。
 *   两者处理相反是**刻意的**，不是为了对称好看。
 *
 *  `MAX_HOPS` 只作最后一道护栏（正常链长 1~2，实测黑板最长 1 跳）；
 *  真靠它兜住的场景极少，主要防"数据被改坏成一长串"时把派发卡死在循环里。 */
const SUPERSEDED_MAX_HOPS = 50
function resolveSupersededTail(steps: any[], start: any): { final: any | null; cycle: boolean } {
  const byId = new Map<string, any>()
  for (const s of (Array.isArray(steps) ? steps : [])) byId.set(String(s?.id || ''), s)
  const seen = new Set<string>([String(start?.id || '')])
  let cur = start
  let hops = 0
  while (String(cur?.supersededBy || '').trim()) {
    if (++hops > SUPERSEDED_MAX_HOPS) return { final: cur, cycle: true }   // c) 太长 ⇒ 按可疑处理
    const nxId = String(cur.supersededBy)
    const nx = byId.get(nxId)
    if (!nx) return { final: null, cycle: false }                          // b) 接手者不存在 ⇒ 无依赖可等
    if (seen.has(nxId)) return { final: nx, cycle: true }                  // a) 环 ⇒ 阻塞
    seen.add(nxId)
    cur = nx
  }
  return { final: cur, cycle: false }                                      // d) 链尾（终态接手者）
}


// ============================================================================
/* ★1032（P14 清理）：**成员单聊的 member-chats 独立存储已整套删除**（`MemberChatRun` / `mcEnsure` /
   `mcPersist` / `memberChatsSnapshot` / `clearMemberChats` / `runMemberChat` / `dmKey` / generation 等）。
   理由：成员单聊统一走**成员的持久会话**（`session.memberSay` → `dm:` 真会话），
   "成员 = 一个对话框"只有一条数据通路；保留第二套存储必然对不上（铁律：一个数据一条通路）。 */
/* ★1032（P15 清理）：`sessions_alive_check` / `setMemberChatSessionLivenessCheck` 已删 ——
   它是 runMemberChat 的"会话已删除就别回写"守卫，成员单聊归一到成员会话后没有使用者。 */

/** 0911 反馈③：run 是否活跃（server 启动时注入给 fileLocks 做残留锁兜底：
 *  owner 已失活时新持有者可直接抢锁，杜绝 run 异常路径残留导致的死锁） */
export function isRunActive(runId: string): boolean {
  return activeRunIds.has(runId)
}

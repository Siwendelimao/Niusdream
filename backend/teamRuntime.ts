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

export function stepHasExecutionEvidence(step: any, runs: any[] | undefined): boolean {
  const sid = String(step?.id || '')
  /* b) 步骤停在 review —— 成员跑完上报（runStepTask 亲手写），本身就是产出证据 */
  if (String(step?.status || '') === 'review') return true
  /* c) executedAt —— 执行路径落的持久证据（runs 被封顶裁掉/被自愈覆盖也查得到） */
  if (Number(step?.executedAt || 0) > 0) return true
  /* a) runs 里有该步的终态记录（interrupted 需额外有产出，见 runCountsAsExecuted） */
  return (runs || []).some(r => String(r?.stepId || '') === sid && runCountsAsExecuted(r, step))
}

/** ★gg1：审核闸门失败时的**人话解释** —— 按真实原因分支。
 *  旧版一句话（"要么从未派发，要么这趟执行被中断且零产出"）把 rejected / 混乱终态 / runs 被裁
 *  全说成"从未派发"，主 agent 会照着**错的方向**排查（实测被这条误导过）。
 *  只在**没有执行证据**时被调用（调用点：bb_write step done 的闸门），分支顺序＝最具体的证据优先：
 *   ① rejected（已被打回）② interrupted（跑到一半被中断）③ 有 runs 但没一条算执行完成
 *   ④ 有 executedAt 但 runs 被 60 条封顶裁掉 ⑤ 真·从未派发 ⑥ 其它 status（failed/running/未知）
 *  每支都给"处理方式"：重派 / 打回+重写计划 / 先派发 —— 看完就能动作，不用再翻代码。 */
export function explainNoExecutionEvidence(step: any, runs: any[] | undefined): string {
  const id = String(step?.id || '')
  const status = String(step?.status || '')
  const myRuns = (runs || []).filter(r => String(r?.stepId || '') === id)
  const outLen = String((step as any)?.result ?? '').trim().length
  const at = Number((step as any)?.executedAt || 0)
  const atText = at > 0 ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : ''
  const head = `步骤 ${id} 不能标记 done：`

  /* ① 已被打回 —— 本来就没有"待审的产出"，说"从未派发"最误导 */
  if (status === 'rejected') {
    const fb = (step as any)?.feedback ? truncate((step as any).feedback, 80) : '需重做'
    return head + `它已被打回（反馈：${fb}），当前没有可审核的产出。`
      + '处理方式：重新 team_dispatch 派发该步骤（任务单里必须写清上面反馈的解决要求），等成员跑完再审核；'
      + '如果方向不对/不需要了，用 bb_goal 重写计划把它移除。'
  }
  /* ② 派发过、跑到一半被中断（用户点停止 / 后端重启自愈 / 看门狗），且零产出或产出不足 */
  if (status === 'interrupted') {
    return head + `它派发过、跑到一半被中断（用户点停止 / 后端重启自愈 / 看门狗），`
      + (outLen ? `当前产出只有 ${outLen} 字、不足以审核。` : '且完全没有产出。')
      + '处理方式：重新 team_dispatch 派发该步骤（把上次跑到的位置写进任务单，别让它重头再来）；'
      + '方向不对就用 bb_write(kind=step,status=rejected,feedback=...) 打回，再用 bb_goal 重写计划。'
  }
  /* ③ 有 runs 记录，但没有一条算「执行完成」（running 没结果 / error 半截 / interrupted 零产出） */
  if (myRuns.length) {
    const last = String(myRuns[myRuns.length - 1]?.status || '空')
    return head + `它有 ${myRuns.length} 条 run 记录，但没有一条算「执行完成」（最后终态：${last}）。`
      + '处理方式：重新 team_dispatch 重派该步骤；若这几次的产出都不可用，用 bb_write(kind=step,status=rejected,feedback=...) 打回，再用 bb_goal 重写计划。'
  }
  /* ④ 派发过（执行路径落了 executedAt），但 runs 已被黑板 60 条封顶裁掉、且零产出。
        ⚠️ 正常情况下闸门因 executedAt>0 直接放行、走不到这里 —— 这是**诊断用的防守分支**
        （executedAt 口径若再收紧、或手工调用时，仍然给得出准确说法，而不是退化成"从未派发"）。 */
  if (at > 0) {
    return head + `它派发过（executedAt=${atText}），但 runs 记录已被黑板 60 条封顶裁掉、且没有任何产出。`
      + '处理方式：重新 team_dispatch 派发该步骤再审核；方向不对就用 bb_write(kind=step,status=rejected,feedback=...) 打回，再用 bb_goal 重写计划。'
  }
  /* ⑤ 真·从未派发：无 runs、无 executedAt、不在 review，且还停在待派发 */
  if (!status || status === 'pending') {
    return head + '它从未派发执行（无 runs 记录、无 executedAt、也不在 review，status=pending），不能凭空标 done。'
      + '处理方式：先用 team_dispatch 派发该步骤，等成员跑完（步骤会进入 review）再审核；不需要了就用 bb_goal 重写计划移除它。'
  }
  /* ⑥ 其它：把**实际 status** 写出来（failed / running / done / 未知都落这里） */
  if (status === 'failed') {
    return head + `它执行失败（status=failed）${outLen ? `、产出只有 ${outLen} 字` : '、零产出'} —— 不是"没开始等派发"。`
      + '处理方式：重新 team_dispatch 重派该步骤；若失败原因在计划本身，用 bb_write(kind=step,status=rejected,feedback=...) 打回，再用 bb_goal 重写计划。'
  }
  if (status === 'running') {
    return head + '它还在跑（status=running），没有可审核的结果。处理方式：等这趟跑完（步骤会进入 review）再审核，不要凭空标 done。'
  }
  return head + `它的当前状态是「${status}」，没有可审核的执行证据（无 runs、无 executedAt、不在 review）。`
    + '处理方式：重新 team_dispatch 派发该步骤再审核；状态确实不对时用 bb_goal 重写计划把它移除。'
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
  /** ★d1：**这个数字从哪来的**（诊断字段，不参与任何运算/显示口径计算）。
   *  · `'ledger'` = 成员会话账本（`usageTotals`，**含私聊消耗**，且不受 runs 封顶影响）—— 主源
   *  · `'runs'`   = 回退到板上 runs 累计（老逻辑）
   *  为什么要这个字段：改了数据源之后，"为什么这个成员的数字和我预期不一样"必须能一眼查清；
   *  没有它就只能靠猜是账本值还是 runs 残值。**只读不写进前端文案**，前端零改动。
   *  缺省（undefined）= 本次没跑过合并（纯 `computeMemberTotals` 的原始结果）。 */
  source?: 'ledger' | 'runs'
  /** ★f1：**当前（未归档）那一段的 token 合计** —— 卡片上显示的那个数（老板：新开对话就清 0）。
   *  ⚠️ 与上面 `tokens`（全历史累计，其他统计还用）**不是一个口径**，两者都保留：
   *     · `tokens`    = 该成员历史全部段 + 已退休 runs 的累计（图表/统计用）
   *     · `segTokens` = 当前段的累计（卡片显示用；开新段天然从 0 起）
   *  拿不到就是 `undefined`（**前端显示「—」，不许写 0 冒充"这一段用了 0"**）。 */
  segTokens?: number
  /** ★f1：当前是**第几段**（`memberSessionSeq`）。缺失/未知 = `undefined`（前端显示「—」）。 */
  segSeq?: number
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

/** 两侧 retired（盘上 / 本地副本）合并：**逐成员取较大者**。
 *  累计量单调只增 ⇒ 取大的不会让数字回退；不按字段各取 max —— 那会拼出一份谁都没见过的账。 */
export function mergeMemberRetired(a: any, b: any): Record<string, MemberRetiredTotal> {
  const out: Record<string, MemberRetiredTotal> = {}
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue
    for (const mid of Object.keys(src)) {
      const cur: any = (src as any)[mid]
      if (!cur || typeof cur !== 'object') continue
      const cand: MemberRetiredTotal = {
        ...pickTotal(cur),
        foldedRunIds: Array.isArray(cur.foldedRunIds) ? cur.foldedRunIds.slice(-MEMBER_FOLDED_IDS_KEEP) : [],
      }
      const prev = out[mid]
      if (!prev) { out[mid] = cand; continue }
      const better = cand.tokens > prev.tokens
        || (cand.tokens === prev.tokens && (cand.runs > prev.runs || (cand.runs === prev.runs && cand.llmMs > prev.llmMs)))
      if (better) out[mid] = cand
    }
  }
  return out
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

export function loadBlackboard(sessionId: string): Blackboard | null {
  try {
    const raw = fs.readFileSync(bbPath(sessionId), 'utf-8')
    const bb = JSON.parse(raw)
    if (!bb || bb.sessionId !== sessionId) return null
    // 冻结步骤自愈（0902 事故遗留形态：进程被杀时步骤停在 running，黑板永远显示进行中）。
    // 写入侧修（铁律 31 允许的防御类）：读侧发现 running 步骤但其 runId 的子 agent 已不在
    // 运行集（重启后必然不在）→ 标 interrupted，主 agent 收到后可补派
    if (Array.isArray(bb.steps)) {
      let changed = false
      for (const s of bb.steps) {
        const live = s.runId && activeRunIds.has(String(s.runId))
        if (s.status === 'running' && !live) { s.status = 'interrupted'; changed = true }
      }
      // 0910 反馈4：run 记录同样自愈——进程被杀时 run 停在 'running'，读侧标 'interrupted'
      // 并写明原因（前端气泡据此显示"被中断"，而不是空着或永远转圈）。记录本身不删，产出照旧可回看。
      if (Array.isArray(bb.runs)) {
        for (const r of bb.runs) {
          if (r && r.status === 'running' && !activeRunIds.has(String(r.runId))) {
            r.status = 'interrupted'
            r.endedAt = r.endedAt || Date.now()
            r.text = r.text || '（这轮执行被中断——后端在处理过程中重启/停止，产出以工作区文件为准）'
            changed = true
          }
        }
      }
      /* ★t1x：自愈时**顺手把执行证据固化到步骤上** —— 修历史板：be4a425f 实测 51 个 review 步骤里
         19 个的 run 终态是 interrupted（用户点停止/重启自愈写成的），旧闸门只认 done/timeout
         ⇒ 这些步骤**永久**不能标 done。这里只记"这步真的执行过"（executedAt）这一事实，不改任何状态。 */
      for (const r of ((bb as any).runs || [])) {
        if (!r) continue
        const st = (bb.steps || []).find((s: any) => String(s?.id || '') === String(r.stepId || ''))
        /* ★f1b（P0-2）：只给**够格**的证据固化 executedAt —— interrupted 若零产出就是"跑到一半被杀"，
           固化后 executedAt>0 会让闸门直接放行（绕过 P0-2 的产出校验）⇒ 这里必须用同一判据。 */
        if (st && !Number((st as any).executedAt || 0) && runCountsAsExecuted(r, st)) { (st as any).executedAt = Number(r.t || 0) || Date.now(); changed = true }
      }
      if (changed) {
        try {
          bb.updatedAt = Date.now()
          /* ★0929 P0（多窗口长任务隐患排查）：原子写 —— 裸 writeFileSync 崩溃窗口会留
             半截 JSON，下次 loadBlackboard 直接解析失败=整板丢（#clone 板实测已达 4MB）。 */
          /* ★e1：**自愈写盘也不许把 `memberTotals` 带下去**。
             它是派生值（真源 = 成员会话 usageTotals + memberRetired），而这里读到的
             `bb.memberTotals` 是**磁盘上的旧值**（老黑板里是 runs 口径的脏值）。
             用深拷贝剔一份再写，避免 `delete` 破坏调用方手里的 `bb`（下面还要用它填内存口径）。 */
          const _toDisk: any = { ...bb }
          delete _toDisk.memberTotals
          writeJsonAtomic(bbPath(sessionId), _toDisk)
        } catch { /* ignore */ }
      }
    }
      /* ★h5 **一次性迁移**（不是运行时兜底）：本次改动之前落的老板子没有 memberRetired/memberTotals
         ⇒ 用现有 runs 现算一次，让首次读到（bb_read / blackboard.read / 广播帧）就有值。
         ★e1 更正：这里算出的 `memberTotals` **只填内存**（回退值），**不再落盘**
         （原注释说"下一次 saveBlackboard 会把 retired+totals 一起落盘" —— 方案 2 之后 totals 永不落盘）。 */
      if (!(bb as any).memberRetired || typeof (bb as any).memberRetired !== 'object') (bb as any).memberRetired = {}
      /* ★bd1 **一次性迁移**（不是运行时兜底）：本次改动之前落的老板子没有 decisions/decisionTombstones
         ⇒ 补成空数组，让 bb_read / 广播帧 / bb_write(decision) 三处都拿到确定的数组。
         纯读、不额外写盘（下一次 saveBlackboard 会把它们一起落盘）。 */
      if (!Array.isArray((bb as any).decisions)) (bb as any).decisions = []
      if (!Array.isArray((bb as any).decisionTombstones)) (bb as any).decisionTombstones = []
      ;(bb as any).memberTotals = computeMemberTotals(bb)

    return bb
  } catch {
    return null
  }
}

function saveBlackboard(bb: Blackboard): void {
  try {
    bb.updatedAt = Date.now()
    /* ★0929 P1（刀6 成员回流覆盖）：**所有板**落盘统一「盘上取最新 → 合并 → 原子写」同步临界区。
       旧病（分身2 审计实锤）：team_dispatch execute 开头 `loadBlackboard` 持一份副本**跨整个派发期**
       （分钟级 await Promise.all），期间【成员单聊回流 findings（2010）/ 同轮并行 bb_write·bb_goal
       （pi 同轮工具确为 Promise.all）】写盘的成果，会被 dispatch 侧 bb_write/步骤状态回写用旧副本
       **整板覆盖**——单聊产出白干、指挥官 done/rejected 被打回。
       合并规则（JS 单线程：load→merge→write 之间无 await，天然互斥）：
         · runs 按 runId/id 合并（同键本地=最新状态优先），按 t 排序、封顶 60 条
         · steps 按 **planRev 代次**合并：更高代次（bb_goal 全量重写）整份替换；同代次按 id 取
           updatedAt 较新者；更低代次（长跑成员手里的旧副本）只回写已有步骤、不许带回旧计划（见下方实现）
         · findings 内容并集去重（append-only，按 t 排序）
         · 标量字段（goal/acceptance/finalResult…）以本地为准（本地=刚被业务代码改过的对象）
         · 合并结果回灌本地 bb —— 后续事件推进的整板写的都是同一份全量
       注：0929 刀1 曾决定「团队板保持直写（共享对象无自丢）」——共享对象确实不丢**自己的**写，
       但防不住**外部写者**（单聊回流/并行工具副本），本刀按分身2 P1 证据统一改为合并落盘。 */
    const fresh: any = loadBlackboard(bb.sessionId) || {}
    const local: any = bb as any
    let _droppedRuns: any[] = []
    const runs: any[] = (() => {
      const m = new Map<string, any>()
      for (const r of [...(fresh.runs || []), ...(local.runs || [])]) m.set(String((r as any)?.runId || (r as any)?.id || Math.random()), r)
      const all = Array.from(m.values()).sort((a: any, b: any) => (a?.t || 0) - (b?.t || 0))
      /* ★t1x：封顶 60 条是给文件体积用的（56 步 + 重试已经顶到上限），但**被裁掉的 run 会把
         "这步执行过"的证据一起带走**，之后 bb_write 再也查不到 ⇒ 步骤永远停在 review。
         ⇒ 裁之前把执行事实固化进 step.executedAt（下面 steps 合并完就写），记录可以丢，事实不丢。 */
      _droppedRuns = all.length > 60 ? all.slice(0, all.length - 60) : []
      return all.slice(-60)
    })()
    const freshRev = Number((fresh as any)?.planRev || 0)
    const localRev = Number((local as any)?.planRev || 0)
    const steps: any[] = (() => {
      /* ★1104-I 计划代次决定 step 合并口径（旧实现只有"按 id 并集"，等于没有替换语义）：
         · localRev > freshRev —— 本地是刚 bb_goal 的全新计划 ⇒ **全量替换**：只保留新计划的步骤，
           外加盘上正在跑的旧步骤（活的 run 必须仍可在板上寻址，否则成员跑完回写状态时找不到 step）。
           已作废的 pending/review/done/rejected 一律丢弃 —— 它们就是幽灵步骤的来源。
         · localRev < freshRev —— 本地是长跑成员手里那份旧副本 ⇒ 只允许写回"板上已有且更晚"的状态，
           不许把它记着的旧计划重新带回板上（否则成员一落盘就把新计划覆盖回去）。
         · 同代次 —— 按 id 合并，updatedAt 较新者胜（bb_write / 状态回写都走这条）。 */
      if (localRev > freshRev) {
        const ids = new Set((local.steps || []).map((s: any) => String((s as any)?.id || '')))
        const live = (fresh.steps || []).filter((s: any) => !ids.has(String((s as any)?.id || '')) && String((s as any)?.status || '') === 'running')
        return [...(local.steps || []), ...live]
      }
      if (localRev < freshRev) {
        const byId = new Map<string, any>((fresh.steps || []).map((s: any) => [String((s as any)?.id || ''), s]))
        for (const s of (local.steps || [])) {
          const id = String((s as any)?.id || '')
          const prev = byId.get(id)
          if (!prev) continue
          if (Number((s as any)?.updatedAt || 0) > Number((prev as any)?.updatedAt || 0)) byId.set(id, s)
        }
        return Array.from(byId.values())
      }
      const m = new Map<string, any>()
      for (const s of [...(fresh.steps || []), ...(local.steps || [])]) {
        const id = String((s as any)?.id || Math.random())
        const prev = m.get(id)
        if (!prev || Number((s as any)?.updatedAt || 0) >= Number(prev?.updatedAt || 0)) m.set(id, s)
      }
      return Array.from(m.values())
    })()
    /* ★t1x：把被裁掉的 run 的"执行过"事实固化到**合并后**的步骤对象上（只写事实，不改状态）。 */
    if (_droppedRuns.length) {
      for (const r of _droppedRuns) {
        const st = steps.find((s: any) => String(s?.id || '') === String(r?.stepId || ''))
        /* ★f1b（P0-2）：同上，interrupted 零产出不许固化成 executedAt。 */
        if (st && !Number((st as any).executedAt || 0) && runCountsAsExecuted(r, st)) (st as any).executedAt = Number(r?.t || 0) || Date.now()
      }
    }
    const seen = new Set<string>()
    const findings: any[] = [...(fresh.findings || []), ...(local.findings || [])]
      .filter((f: any) => { const k = JSON.stringify(f); if (seen.has(k)) return false; seen.add(k); return true })
      .sort((a: any, b: any) => (a?.t || 0) - (b?.t || 0))
    const merged: any = { ...fresh, ...local, runs, steps, findings, sessionId: local.sessionId || bb.sessionId }
    merged.createdAt = fresh.createdAt || local.createdAt || Date.now()
    /* ★h5 成员 token 累计（**后端唯一源**）= memberRetired（被 60 条封顶裁掉的部分）+ 板上现存 runs。
       · retired 两侧（盘上 fresh / 本地副本 local）逐成员取较大者 —— 单调量取大不会回退；
       · **裁 runs 之前必须 foldRetiredRuns** —— 这一步就是"数字不再往下掉"的关键：
         被裁掉的 run 的 token 一次不落地折进 retired，之后无论裁多少次、刷新多少回都不受影响；
       · memberTotals 每次落盘重算；前端只读它，**不许再自己 sum(runs)**（那正是回退的病根）。 */
    merged.memberRetired = mergeMemberRetired((fresh as any)?.memberRetired, (local as any)?.memberRetired)
    foldRetiredRuns(merged, _droppedRuns)
    merged.memberTotals = computeMemberTotals(merged)
    /* ★bd1：待确认清单的合并口径 —— 与 steps 的"后写覆盖"不同，**删除必须赢**：
       · 墓碑先并集（封顶 50），凡在墓碑里的 id 一律不进结果；
       · 剩下的按 id 求并集（同 id 以 local＝刚被业务代码改过的对象为准），按 createdAt 排序。
       ⇒ 同轮并行 bb_write（Promise.all）各自新增的不会丢，而"删掉的"不会被盘上那份复活。 */
    merged.decisionTombstones = mergeDecisionTombstones((fresh as any)?.decisionTombstones, (local as any)?.decisionTombstones)
    merged.decisions = mergeDecisions((fresh as any)?.decisions, (local as any)?.decisions, merged.decisionTombstones)

    /* 代次只升不降：旧副本（localRev < freshRev）不许把板子的计划代次写回旧值。 */
    merged.planRev = Math.max(freshRev, localRev)
    merged.updatedAt = Date.now()
    /* ★h5：累计回灌本地内存板（bb === local）—— broadcastBB / bb_read / persistRuns 读的都是这份对象。
       ★e1：`memberTotals` 也在这里回灌（内存要留），但**下面落盘前会从 merged 删掉**（派生值不落盘）。 */
    ;(local as any).memberRetired = merged.memberRetired
    ;(local as any).memberTotals = merged.memberTotals
    ;(local as any).decisions = merged.decisions
    ;(local as any).decisionTombstones = merged.decisionTombstones

    ;(bb as any).runs = runs
    ;(bb as any).steps = steps
    ;(bb as any).findings = findings
    ;(bb as any).planRev = merged.planRev
    ;(bb as any).decisions = merged.decisions
    ;(bb as any).decisionTombstones = merged.decisionTombstones
    /* ★e1（需求方案 2）：**`memberTotals` 不落盘** —— 它是派生值，不是事实。
       为什么必须去掉（上一轮 z2b 实测出来的"两个真相"）：
         `mergeMemberUsageLedger` 在**内存/广播**上写的是账本口径（source='ledger'，m3 ≈ 7M），
         而 `saveBlackboard` 里的 `computeMemberTotals(merged)` 又用 **runs 口径**把它重算一遍并落盘
         ⇒ **磁盘 = runs 口径、广播 = 账本口径**（同一份数据两个写者、两个真相）。
       真源是两样东西，都在别处、都持久：
         · 成员会话的 `usageTotals`（server 侧读，含私聊、单调只增、不受 runs 封顶影响）
         · `memberRetired`（**这个继续落盘**，见上：它是 runs 被 60 条封顶裁掉前折进去的，去掉就真丢数据）
       ⇒ `memberTotals` 每次都由「账本 + memberRetired」现算：广播帧现算、`blackboard.read` 现算。
       ⚠️ 只从**落盘副本**删，`merged` 对象本身与内存 bb 都保留（下面 bb_read / broadcastBB 还要用）。
       ⚠️ 老黑板上的脏值：不落盘后**下一次 saveBlackboard 自然就不写了** —— 不需要迁移脚本；
          重启后第一次保存它就消失（报告里已注明这一点）。 */
    delete (merged as any).memberTotals
    /* ★0929 P0 同款：原子写（tmp+rename），防崩溃留半截 JSON 丢整板 */
    writeJsonAtomic(bbPath(bb.sessionId), merged)
  } catch (e) {
    console.error('[team] blackboard save failed:', e)
  }
}

/** ★0929 刀1 原分身板合并器——刀6 起其算法已**收口进 saveBlackboard（全板合并）**，
 *  本函数保留为兼容别名（persistRuns 的 #clone 分流仍按名调用，语义不变）。 */
function saveBlackboardRunsMerged(bb: Blackboard): void {
  saveBlackboard(bb)
}

/** ★L5：run 账本的**唯一落盘实现**（原来是 `runSubAgent` 里的局部闭包）。
 *  抽出来的原因：`runMemberTurn` 也要写同一种记录 —— 复制一份就是两套口径
 *  （裁 60 条 / 折 retired / 重算 memberTotals / #clone 分流，少一步就少一份真相）。
 *  纯函数式：只依赖传进来的 bb。 */
function persistBoardRuns(bb: Blackboard): void {
  /* ★tw1s：**口径切换点**（只写一次）—— 从此以后 run.usage = 会话账本差值（run 增量法，含全部跳）；
     此前的历史 runs **不重算**（它们只含最后一跳，是旧口径，数字偏小）。排查看"从哪一刻开始可信"读它。 */
  if (!(bb as any).usageAccounting) (bb as any).usageAccounting = { scheme: 'run-ledger-delta', since: Date.now() }
  if ((bb as any).runs.length > 60) {
    /* ★h5：**裁之前先折**（被裁 run 的 token 进 memberRetired 永久保留）—— 否则长任务跑着跑着，
       成员 token 累计会随每一次 slice(-60) 往下掉。 */
    foldRetiredRuns(bb, (bb as any).runs.slice(0, (bb as any).runs.length - 60))
    ;(bb as any).runs = (bb as any).runs.slice(-60)
  }
  /* ★h5：内存板的累计跟着更新（broadcastBB / bb_read 直接读这份对象） */
  ;(bb as any).memberTotals = computeMemberTotals(bb)

  /* ★0929 P1 分流：分身板（`${sessionId}#clone`）各 run 各持副本跨 await 互写 ⇒ 走合并落盘；
     团队板是共享对象，保持原直写。 */
  if (String((bb as any).sessionId || '').endsWith('#clone')) saveBlackboardRunsMerged(bb)
  else saveBlackboard(bb)
}

/** 会话删除时清理黑板落盘 */
export function clearBlackboard(sessionId: string): void {
  try {
    fs.rmSync(bbPath(sessionId), { force: true })
  } catch { /* ignore */ }
}

/** 只读黑板原始 JSON（不触发热路径自愈）：bb_goal 取上一版 planRev / 保留 runs 用 */
function readBlackboardRaw(sessionId: string): any | null {
  try {
    const bb = JSON.parse(fs.readFileSync(bbPath(sessionId), 'utf-8'))
    return bb && bb.sessionId === sessionId ? bb : null
  } catch {
    return null
  }
}

/** 本进程内**正在跑**的 run（派发 + 单聊共用）：读侧自愈必须跳过它们——否则前端随手
 *  读一次黑板就会把"正在执行的步骤/成员"误标成 interrupted（自愈只该处理上一个进程留下的残留）。 */
const activeRunIds = new Set<string>()

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
  /** ★d1（需求）：**成员用量累计以"成员会话账本"为主源**（含私聊消耗、不受 runs 封顶影响）。
   *
   *  为什么做成注入而不是在 `computeMemberTotals` 里直接读会话：
   *    `computeMemberTotals(board)` 是**纯函数**（只读 board）—— 那是好设计（可单测、合并落盘时不串台），
   *    必须保住。所以和 r3 的 `memberCtxUsage` 同一个模式：teamRuntime 决定"何时合"，
   *    server 负责"怎么算"（它才有 `findMemberSession` 与成员会话对象）。
   *
   *  返回 `null` = 拿不到 ⇒ 调用方**保持 runs 累计**（并标 `source:'runs'`），不写 0 冒充。
   *  三种拿不到（server 侧负责识别并返回 null）：成员从没跑过 / 会话已归档或回收 / `sessions.get` 升级失败。 */
  memberUsageLedgerTotal?: (memberId: string) => {
    promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number
    tokens: number; llmMs: number; runs: number
  } | null
  /** ★f1（需求）：**成员当前（未归档）那一段的用量** —— 卡片上显示的数（新开对话天然从 0 起）。
   *
   *  为什么按段而不是靠"清零"：每段都是独立 session，各自有 `usageTotals`
   *  ⇒ 开新段就是新账本，**不需要任何清零逻辑**（零状态、不会漏清也不会清错）。
   *
   *  与上面 `memberUsageLedgerTotal` 的分工：
   *   · `memberUsageLedgerTotal` = **全历史累计**（其他统计/图表还在用，保持不动）
   *   · `memberSegTotal`         = **当前段**（卡片显示）
   *
   *  返回 `null` = 拿不到（成员没跑过 / 这一段还没入账）⇒ 调用方**不写** `segTokens`/`segSeq`
   *  ⇒ 前端显示「—」，**绝不写 0 冒充"这一段用了 0"**。 */
  memberSegTotal?: (memberId: string) => {
    segTokens: number; segSeq: number
    promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number
    llmMs: number; runs: number
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
   *  实现 = server.ts 的 `injectSessionNotice`（与"分身回归"同一条通路：忙则 steer 并入当前轮、
   *  闲则开新一轮、失败转待办）。`team_dispatch` 改成异步后靠它"回来"。
   *  ⚠️ 不设 = 走同步老行为？不 —— 不设就没有回程，派发结果会丢。所以这是**必需**能力，
   *     只是保留可选类型以便老测试壳编译。 */
  notifyDone?: (text: string, meta?: { memberIds?: string[] }) => void
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
  runPromptCore?: (sessionId: string, p: Record<string, unknown>) => Promise<{ ok?: boolean; queued?: boolean; turnFailed?: boolean; error?: string } & Record<string, any>>
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

/** 计划卡条目：[成员名] 步骤描述；running 的步骤带"进行中"标记（用户可见谁正在做哪条）。
 *  ★bd1：返回**结构化**对象（见 PlanItem）—— text 不变、新增 id/status/owner/ownerName。 */
export function planItems(ctx: TeamCtx, bb: Blackboard): PlanItem[] {
  return bb.steps.map(s => {
    let text = `[${memberName(ctx.team, s.owner)}] ${s.text}`
    if (s.status === 'running') text += `（${memberName(ctx.team, s.owner)} 正在做，第 ${s.attempts} 次）`
    /* ★gg1：review 改「成员已上报，待审核」—— 这条 done=false（圆圈空心），旧文案"已完成"和它自相矛盾 */
    else if (s.status === 'review') text += '（成员已上报，待审核）'
    else if (s.status === 'rejected') text += `（已打回：${s.feedback ? truncate(s.feedback, 40) : '需重做'}）`
    /* ★gg1：failed / interrupted 原来**一个后缀都没有** ⇒ 和"还没开始"长得一模一样（老板截图那类：
       看着还在等，其实早崩了）。interrupted 用 stepHasOutput 区分"有产出（可审核）/ 零产出"。 */
    else if (s.status === 'failed') text += '（执行失败：没有产出，需重派或打回）'
    else if (s.status === 'interrupted') text += stepHasOutput(s) ? '（被中断：有产出，可审核）' : '（被中断：零产出）'
    /* ★gg1 决策：pending 也补「待派发」（验收条目明确要求 + 三个状态凑成闭环：待派发→派、失败→重派/打回、
       被中断→重派）。它只多 5 个字，done 步骤无后缀；若日后觉得新建计划时太吵，删这一行即可，不影响其它分支。 */
    else if (s.status === 'pending') text += '（待派发）'
    return { id: s.id, text, status: String(s.status), done: s.status === 'done', owner: s.owner, ownerName: memberName(ctx.team, s.owner) }
  })
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

/** ★d1（需求）：**把「成员会话账本」的用量合进 `memberTotals`** —— 数据源切换的主入口。
 *
 *  病（实测）：m3 的会话账本里明明有 6.6M token（`usageTotals`），但 `memberTotals.m3.tokens = 0`。
 *  根因：`computeMemberTotals` **只累加 `bb.runs`**，而 m3 那条 run 的 `usage = {}`（当时会话读不到，
 *  后被 u1/x1 修好） ⇒ 整张卡 0。
 *  这个坑会随"成员越多、单成员跑得越少"而放大：
 *   · 成员只跑一次且那次没记账 ⇒ 改前整张卡 0，改后有数
 *   · 成员在窗口里**私聊** ⇒ 改前完全不计，改后计入（老板要的口径）
 *   · runs 被 60 条封顶裁掉 ⇒ 改前靠 memberRetired 补（易漏），改后不受影响
 *
 *  为什么放在这一层（和 r3 的 mergeMemberCtxUsage 完全同一个模式）：
 *   `computeMemberTotals(board)` 是纯函数（只读 board、可单测），必须保住；
 *   "读成员会话账本"需要 server 的能力（`findMemberSession` + 会话对象）⇒ 由 `ctx.memberUsageLedgerTotal` 注入。
 *
 *  **字段映射**（与现有语义严格一致 ⇒ 前端零改动）：
 *    usageTotals.uncached   → promptTokens
 *    usageTotals.cacheRead  → cacheReadTokens
 *    usageTotals.cacheWrite → cacheWriteTokens
 *    usageTotals.output     → completionTokens
 *    usageTotals.llmMs      → llmMs
 *    tokens = uncached + cacheRead + cacheWrite + output
 *    runs   = 优先 usageTotals.turns；为 0/缺失时保留原来的 runs 条数（比编一个数诚实）
 *
 *  拿不到账本（返回 null）⇒ **什么都不改**，只把 `source` 标成 `'runs'`，
 *  让 `computeMemberTotals` 的 runs 累计原样留着 —— 这样排查时能一眼分清"真值"与"只有 runs 的残值"。 */
function mergeMemberUsageLedger(ctx: TeamCtx, bb: Blackboard): void {
  const probe = ctx.memberUsageLedgerTotal
  if (typeof probe !== 'function') return      // 未注入 ⇒ 保持原样（不标 source，等同"没跑过合并"）
  const totals: any = (bb as any)?.memberTotals
  if (!totals || typeof totals !== 'object') return
  for (const mid of Object.keys(totals)) {
    const rec: any = totals[mid]
    if (!rec || typeof rec !== 'object') continue
    let got: ReturnType<NonNullable<TeamCtx['memberUsageLedgerTotal']>> = null
    try { got = probe(mid) } catch { got = null }
    if (!got) { rec.source = 'runs'; continue }     // 拿不到 ⇒ 保留 runs 累计，只标来源
    /* 五项都必须是有限非负数才算拿到 —— 任何一个不是数就整体放弃（绝不写 NaN/Infinity 出去，
       也不"部分采用"：部分采用会得到一份既不是账本也不是 runs 的第三口径，那比 0 更难排查）。 */
    const p = Number(got.promptTokens), c = Number(got.completionTokens)
    const cr = Number(got.cacheReadTokens), cw = Number(got.cacheWriteTokens)
    const tk = Number(got.tokens), lm = Number(got.llmMs), rn = Number(got.runs)
    if (![p, c, cr, cw, tk, lm, rn].every(v => Number.isFinite(v) && v >= 0)) { rec.source = 'runs'; continue }
    rec.promptTokens = Math.round(p)
    rec.completionTokens = Math.round(c)
    rec.cacheReadTokens = Math.round(cr)
    rec.cacheWriteTokens = Math.round(cw)
    rec.tokens = Math.round(tk)
    rec.llmMs = Math.round(lm)
    /* runs：账本有 turns 就用它（口径是"这个成员总共跑过几轮"，含私聊）；
       为 0 说明账本没记轮数（老会话），保留原 runs 条数 —— 不拿 0 覆盖掉真实条数。 */
    if (rn > 0) rec.runs = Math.round(rn)
    rec.source = 'ledger'
  }
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

export async function runSubAgent(
  ctx: TeamCtx,
  bb: Blackboard,
  step: BlackboardStep,
  member: TeamMember,
  runId: string,
  taskText: string,
  acceptance: string,
  /* ★1032-C0（**真 bug 修复**）：这批 run 属于哪一次派发（= 派发工具的 toolCallId）。
     没有它，读侧 `injectSubRuns` 只能按 stepId 匹配，而 stepId 是**跨批复用**的
     （每次派发都从 s1 开始编）⇒ 第 2 批会把第 1 批的 run 也匹配进来。
     实测 175fcf02：5 个批次、8 个真实任务，subRuns 里被登记成 18 条（每批重复 2~3 次）。
     其中一处后果就是 `dca76c3` 那次崩页（同一轮内 v-for key 重复）。 */
  callId?: string,
): Promise<void> {

  /* ★1032-C-1a-2b-3：原来的「事件帧缓存包装」整块删除 ——
     它只是 `bufferRunFrame(frame)` + 原样广播，注册表退役后这层包装**没有任何作用**。
     留着空壳就是下一任维护者的困惑源（"这个 __runBuffer 标记干什么用的？"）。
     `__runBuffer` 标记也没有别的读取方（全仓搜过：只有这里写）。 */

  const mName = memberName(ctx.team, member.id)
  const preset = readAgentPreset(member.preset)
  if (!preset) throw new Error(`成员预设不存在：${member.preset}`)

  // ── 精准上下文打包（定稿八）：团队清单 + 黑板快照 + 任务单 ──
  const roleText = String(member.role || preset.description || '').trim() || '（见任务单）'
  const teamList = ctx.team.members
    .map(m => `- ${m.id} ${memberName(ctx.team, m.id)}：${truncate(readAgentPreset(m.preset)?.description || '', 80)}`)
    .join('\n')
  const depText = step.deps.map(depId => {
    const d = bb.steps.find(s => s.id === depId)
    return `- ${depId}：${truncate(d?.result || '(无产出摘要)', 1200)}`
  }).join('\n') || '（无前置依赖）'
  const findingsText = bb.findings.slice(-8).map(f => `- [${f.by}] ${truncate(f.text, 240)}`).join('\n') || '（无）'
  const prevDone = bb.steps.filter((s) => s.id !== step.id && s.owner === member.id && String(s.status) === 'done' && s.result).slice(-1)[0]; const _touched = []; for (const _r of (bb.runs || []).slice(-6)) { for (const _seg of (Array.isArray(_r && _r.segments) ? _r.segments : [])) { if (!_seg || _seg.type !== 'tool') continue; const _nm = String(_seg.name || ''); if (_nm !== 'fs_write' && _nm !== 'fs_edit') continue; const _a = _seg.args || {}; const _fp = String(_a.path || _a.file_path || ''); if (_fp && _touched.indexOf(_fp) < 0) _touched.push(_fp); } } const _pw = []; if (prevDone) _pw.push('你上一趟（' + prevDone.id + '）的产出摘要：' + truncate(String(prevDone.result), 600)); if (_touched.length) _pw.push('本会话最近改过的文件（先看这些，别重新搜仓库）：' + _touched.slice(0, 12).join('、')); const prevWorkText = _pw.length ? ('# 接着上一次干活（省掉重新摸索）' + String.fromCharCode(10) + _pw.join(String.fromCharCode(10)) + String.fromCharCode(10) + String.fromCharCode(10)) : '';

  let sys = `你是「${mName}」，NiusDream 团队「${ctx.team.name}」的专职成员（一次性实例，完成任务即销毁）。
你的唯一职责：${truncate(roleText, 400)}

工作纪律：
- 只做任务单内的事，不越职责边界；不做团队派发/管理类工作（没有这些工具）
- 当前工作目录是会话工作区：${ctx.workDir()}——产出文件一律写在这里（相对路径）\n- **局部改动一律用 fs_edit（old_string/new_string），不要整文件 fs_write 重写**——改一行就整份重写会浪费大量输出 token，也更容易出错；fs_edit 报 old_string 不唯一时带 3 行上下文重试一次，仍失败再用 fs_write
${(Array.isArray(preset.tools) ? preset.tools : []).includes('sub_plan') ? '- 接到任务先自列执行计划：用 sub_plan 把任务拆成 3~6 条可核对的小步骤（复杂任务必做；一句话能做完的简单任务可跳过），然后逐条执行、完成一条就更新它的 done 状态（全量重写）' : ''}${(() => { try { return fs.existsSync(path.join(ctx.workDir(), 'NIS-notes.md')) ? '- 工作区有项目档案 NIS-notes.md（**约 1MB，禁止整份 fs_read**）——要看某一节用 project_note(action="read", section="当前进度")，其余按需 fs_grep 关键词，不要从头读到尾\n' : '' } catch { return '' } })()}- 收尾汇报用 bb_write 且必须带 **result + finish:true**（result 3~6 句：做了什么/结果如何/关键决策；有产物把相对路径写进 artifacts）—— finish:true 是**唯一**会结束本次执行的信号，不传它这趟就不算收尾
- **长内容先落文件**：报告/审计/对比/清单这类**超过 500 字**的产出，用 fs_write 写进工作区 md 文件，bb_write 的 result 只写 3~6 句 + 那个文件路径（artifacts 里也写上）；主指挥官只读 result 和路径，靠自己按需读文件——把全文塞进 result 会让它每轮都背着这段历史，纯浪费。短结论（一句话能说清）直接写 result，**不要为了写文件而写文件**
- 中途进度/中间结论用 **finding** 记（可多次写、不结束执行）；**不要**把「记录 3/12」这类进度写进 result —— 那会被当成交付产出，等于谎报完成
- 遇到无法完成：照常 bb_write（result + finish:true），在 result 里写明障碍与已尝试的方案，不要编造完成
- **交付必须自带"可核对的位置"**：result 里逐条列出改动位置，每个文件用反引号包成 \`路径:行号\`（如 \`src/a.vue:120\`），并附改动后的关键代码片段（≤2 行）。验收方**按你给的位置核对，不靠关键词搜**。理由（不只是流程要求）：你完全可能用比任务单更简洁的实现达到同样效果——验收方若按"任务单里提的字段名/文案"去搜就会扑空，甚至误判成没做；给出位置才是结构性解法。产品/报告类没有代码改动的，就列产物文件路径 + 关键段落所在节标题

# 团队成员（只读参考，无法互相联系）
${teamList}

# 黑板快照（唯一事实源）
目标：${truncate(bb.goal, 300)}
${bb.acceptance ? `总验收标准：${truncate(bb.acceptance, 300)}\n` : ''}计划进度：
${bb.steps.map(s => `- [${s.status}] ${s.id}（${s.owner}）${truncate(s.text, 120)}`).join('\n')}
已有发现：
${findingsText}

${prevWorkText}# 你的任务单
步骤：${step.id}
任务描述：${truncate(step.text, 500)}
任务单（指挥官打包）：${truncate(taskText, 2000)}
${acceptance ? `本步骤验收标准：${truncate(acceptance, 600)}` : ''}
${step.feedback ? `上一次打回反馈（务必解决）：${truncate(step.feedback, 400)}\n` : ''}${step.deps !== undefined && step.deps.length ? `前置依赖产出（可直接使用）：
${depText}` : ''}
汇报纪律：bb_write 是唯一汇报通道，口头返回无效。`

  // ── 工具：成员预设白名单 + 受限 bb_write（只能汇报自己的步骤） ──
  /* ★1036-S21：**显式工具白名单优先**（分身这类"角色自带名单"的场景）。
     原来只认预设的 `tools` ⇒ 分身名单在 cloneRuntime 已过滤一次、这里又按预设砍一次，
     结果是"名单里加了工具也不生效"（list_dir/repo 一直 not found）。
     显式字段 = 该角色的权威清单；没有才退回预设默认。 */
  const whitelist = Array.isArray((member as any).toolWhitelist) ? ((member as any).toolWhitelist as string[])
    : Array.isArray(preset.tools) ? preset.tools : []
  /* ★by1（乙案）**终点信号 ≠ 完成判据**（h4 的根因）：`finish:true` 是**唯一终点信号**（finishTurn 只认它）；
     `result` 单独出现 = 中途汇报，只进 reportState.interim（→ run.interim），**不写 step.result**、不结束 run。
     旧实现「写 result 即终点」把两件事绑在同一个字段上 ⇒ 成员中途写一句「记录 1/12」就被当成完工掐掉
     （h4 取证：798 个分身步骤里 12 条进度型 result、3 条 run 终态 done 但产出只有 25 字）。
     必须在 buildSubWriteTool 之前声明（闭包引用，声明在 Agent 构造后会 TDZ） */
  const reportState: ReportState = { id: Math.random().toString(36).slice(2, 8), finalized: false, summary: '', interim: [] }
  /* ★1032-TM（P106）：原来这里有「本轮工具调用 30 轮」的计数熔断 + 一次收尾宽限（roundGrace），
     已删 —— 需求：防重复守卫（同工具同参数同结果连续 5 次）已经能抓住死循环，
     按轮数一刀切只会误杀正常巡检（一次 fs_read + 一次 fs_grep 就算 2 轮）。 */
  // 0911 反馈3：LLM 流式重试/报错事件（透传前端实时显示；收尾并入 segments 随 run 落盘）
  const streamNotes: Array<{ kind: string; attempt: number; reason: string }> = []
  // 0911 三批：注释类事件 → error 段（模型重试/恢复 + 巡检，两类共用；收尾与击杀两条路径都并入 segments）
  const notesToSegments = () => streamNotes.map(n => ({
    type: 'error' as const,
    text: n.kind === 'inspector'
      ? n.reason
      : `模型调用${n.kind === 'retry' ? `重试（第 ${n.attempt} 次）` : n.kind === 'recovered' ? '已恢复' : '多次重试后失败'}${n.reason ? `：${n.reason.slice(0, 160)}` : ''}`,
  }))
  // bb_write 限流状态：必须与 reportState 一样在 buildSubWriteTool 之前声明并传参——
  // 工具工厂是模块级函数，闭包捕获不到 runSubAgent 的局部变量（0901 实锤：execute 引用
  // 未传参的 bbWrites → ReferenceError，成员所有 bb_write 汇报报"bbWrites is not defined"，
  // 步骤 result 却被主 agent 审核路径代写，把故障掩盖）
  const bbWriteState: { writes: number; limit: number } = { writes: 0, limit: 4 }
  // 成员自列计划状态（0910 反馈4）：run 内私有的子任务清单，随 run 快照落黑板 → 刷新可回放。
  // 与主 agent 的 plan_write 区分：不碰会话计划卡（那是指挥官的），只在自己气泡里显示。
  const subPlanState: { items: Array<{ text: string; done: boolean }> } = { items: [] }
  // 0910 二批 F：署名不再用全局 setSnapshotActor（并发多实例会互相覆盖署名），
  // 改为构建工具池时按实例闭包捕获（ctx.buildMemberToolPool(mName)）
  // 0911 反馈③：同时按实例注入文件写锁（owner=本 run 的 runId）——并行成员写同一文件互斥
  const memberTools = ctx.buildMemberToolPool(mName, { owner: runId, label: mName }).filter(t => whitelist.includes(t.name))
  // 实时广播成员计划（前端成员气泡里的清单即时更新；run 结束时随快照一并落黑板）
  const emitSubPlan = (items: Array<{ text: string; done: boolean }>) => {
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'sub_plan', plan: items },
      })
    } catch { /* ignore */ }
  }
  // 0910 二批修正（需求）：sub_plan 由成员预设勾选控制——原先无条件追加，与预设编辑/工具页的
  // 勾选语义冲突（"没勾选却有功能"）；现在勾了才挂载，系统提示的列计划指引也同步条件化
  /* ★1032（P71）：**成员模式**（老大定）：
       default = 默认（与主对话默认模式同语义：能直接干就直接干）
       plan    = 只出计划（军师）：只给只读工具 + sub_plan + bb_write，产出就是计划本身
       execute = 直接执行（不列计划）
       readonly= 只读：工具收窄成只读白名单，防止误改文件
     口径：**模式只收窄工具与提示，不改派活/汇报协议** —— 这样模式坏不了主流程。 */
  const runMode = String((member as any).mode || 'default')
  const READONLY_TOOLS = ['fs_read', 'fs_grep', 'fs_glob', 'list_dir', 'repo_search', 'web_search', 'web_fetch', 'use_skill', 'skill', 'team_info', 'bb_write', 'sub_plan', 'ask_user']
  const _modeTools = (list: any[]) => (String(runMode) === 'plan' || String(runMode) === 'readonly')
    ? list.filter((t: any) => READONLY_TOOLS.includes(String(t?.name || '')))
    : list
  const tools = [..._modeTools(memberTools), buildSubWriteTool(ctx, bb, step, mName, reportState, bbWriteState)]
  if (whitelist.includes('sub_plan')) tools.push(buildSubPlanTool(subPlanState, emitSubPlan))

  // 技能提示（会话级技能覆盖，新对话默认空——团队配置不再携带技能）
  const memberSkillList = ctx.memberSkills(member.id)
  /* ★1032（P71）：模式的行为约束写进 system prompt —— 工具已经收窄过，这里再说清"你的活到哪为止"。 */
  if (runMode === 'plan') {
    sys = sys + '\n【本成员模式：只出计划】你只负责把任务拆成可执行的步骤计划，用 sub_plan 列出 3~8 步（每步一句话、可核对），然后用 bb_write 汇报这份计划。**不要真的去执行**（不要 fs_write / run_command 等写操作）。'
  } else if (runMode === 'readonly') {
    sys = sys + '\n【本成员模式：只读】你只能读取与分析，禁止任何写入/命令执行；发现问题写进 bb_write 汇报。'
  }
if (memberSkillList.length > 0 && tools.some(t => t.name === 'use_skill')) {
    sys = sys + `\n可用技能：${memberSkillList.join('、')}（需要时用 use_skill 加载指令）`
  }

  // ── 模型：independent 解析失败回退 shared ──
  // 0910 反馈5：回退必须"可见"——除了日志，把结果带进 run 快照（前端气泡显示"独立模型不可用，已回退"），
  // team_info 也会标注不可用，避免"设了独立模型却在跑会话模型"静默发生
  let override: ModelOverride | null = null
  let modelFallback = false
  if (member.modelMode === 'independent') {
    override = ctx.resolveMemberModel(member)
    if (!override) {
      modelFallback = true
      ctx.log('warn', 'session', `[团队] 成员 ${mName} 独立模型（${member.modelId}）解析失败（该模型不在任何已配置可用供应商中），本次回退共享模型`)
    }
  }
  const memberEffort = String((member as any).effort || '').trim()
  // 0910 反馈3：成员气泡上的模型名必须与用户在成员面板里选的**同步**。
  // 独立模型 = 配置的那个 id（解析成功用它、回退时仍显示配置值 + 已回退徽标）；
  // 跟随会话 = 空（前端沿用响应里的会话模型名），不再让"网关回包里的 model 字段"冒充成员模型。
  const effectiveModelId = member.modelMode === 'independent'
    ? String(member.modelId || '').trim()
    : String(ctx.sessionModel?.() || '').trim()  // 跟随会话：把会话模型 id 也写进记录（中断时气泡仍有标签）

  // ── 中断控制器：session.cancel → abortSubAgents → ac.abort() → LLM 流即时断开 ──
  const ac = new AbortController()

  const agent = new Agent({
    // signal 桥接（铁律 21）：pi 的 abort signal 在 streamFn 第三参 config.signal 里，
    // opts.signal（=ac.signal）是本子 agent 的中断控制器。用 AbortSignal.any 合流——
    // 包装层不得把 ac.signal 塞进 context（第二参）丢掉 pi 的 signal（点停止后子 agent 继续跑的根因）
    streamFn: (model: unknown, context: any, config?: { signal?: AbortSignal }) => {
      const signals = [ac.signal, config?.signal].filter(Boolean) as AbortSignal[]
      const merged = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      /* ★p1c：整个 stream 生命周期算一次在途操作（含"发请求 → 收到最终消息"全程）。
         `createSubStreamFn` 的类型是**两段式**：传配置返回一个 `(model, context) => stream` 的函数
         （见 TeamCtx 接口声明），所以要再调一次才拿到 stream 对象。
         stream 带 `result(): Promise<AssistantMessage>`（pi-ai dist/utils/event-stream.d.ts），
         它在 stream end 时 resolve/reject **都**会走 finally ⇒ 不会漏减。
         用 void 吞掉 promise（不让它变成 unhandled rejection —— 真正的错误由 pi 侧处理）。 */
      const _fn = ctx.createSubStreamFn(sys, override, merged, memberEffort || undefined, mName, (note) => {
        streamNotes.push(note)
        /* ★1036-S40（老大：**"成员报错重连没有显示，应该和主 agent 一样"**）：
           重试事件原来只进 `streamNotes`，而 streamNotes 只在**收尾**并入 segments
           ⇒ 整个重试期间（实测 429 连重试 5 次、几十秒到几分钟）卡片一声不响，
           只有运行日志里能看到 —— 用户以为卡死了。
           ⇒ 同时写一个**瞬时态** `runRec.retrying`（retry 设、recovered/成功清），
             前端卡片摘要直接显示"重连中（第 N 次）"，不占对话流位置。 */
        if (note?.kind === 'retry') {
          ;(runRec as any).retrying = { attempt: Number(note.attempt) || 1, reason: String(note.reason || '').slice(0, 120) }
        } else if (note?.kind === 'recovered') {
          delete (runRec as any).retrying
        } else if (note?.kind === 'failed') {
          /* ★1032-TM（P96）：**重试耗尽 = 这一趟 LLM 不可能再成功了**，把它记成 run 的**输入事实**。
             实测（2026-11-03，agnes 429，把重试上限临时降到 1 复现）：
               日志 `模型调用重试 1 次仍失败，放弃本轮` → 步骤却记成「完成」，
               `run.status='done'`、`run.text` 是 `[NIS-ERR]429 · 这一步没跑起来…` —— **失败被当成成功**。
             原因：这一档以前**什么都不做**，而 LLM 层"放弃本轮"是**正常返回**（不抛异常）⇒
             `runSubAgent` 收盘时按"正常完成"写终态。
             ⇒ 这里只记事实（`llmFailed`），**终态仍由收尾那一处唯一写**（读这个事实决定 done/error），
                不新增第二个 status 写者。 */
          ;(runRec as any).llmFailed = { reason: String(note.reason || '').slice(0, 300), at: Date.now() }
          delete (runRec as any).retrying
        }
        try {
          ctx.broadcast({
            type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
            memberId: member.id, memberName: mName, seq: ++seq,
            event: { type: 'stream_note', ...note },
          })
        } catch { /* ignore */ }
      })
      const _stream: any = _fn(model, context)
      /* ★p1d：**这里不再自己打点** —— 走 server 的统一钩子（`setMemberStreamOpHook`）。
         原因：`ctx.createSubStreamFn` 内部就是 `createStreamFn(..., { sub: true, opTrack: true })`，
         而 server 那边已经对**所有 opTrack 流**做了 begin/end。这里再打一次 = 同一件事记两遍，
         会把计数虚高成 2 ⇒ "有在途操作"的判断虽然还是对的，但数字失真、排查时误导。
         单一入口原则：LLM 在途只在一个地方记（createStreamFn 的 memberStreamOpHook）。
         ⚠️ f1：判据是 `opTrack` 而不是 `sub` —— 成员会话（runMemberTurn）现在**只打 opTrack 不打 sub**
            （sub 会连带关掉它的压缩，见 server createStreamFn 的 opts 注释）。 */
      return _stream
    },
    // 工具结果回执走 pi-ai 适配器原生 role:"tool" 转换（压平 hack 已退役，与主 agent 一致）
    initialState: { systemPrompt: sys, tools },
    sessionId: `${ctx.sessionId}/sub/${runId.slice(0, 8)}`,
    finishTurn: toFinishTurn((c: any) => {
      // pi 0.84.x 回调参数是 {message, toolResults, context, newMessages}——没有 messages 字段
      // （c.messages 恒为 undefined → 熔断从未生效，实测单成员刷 107 次 bb_write）。取全量上下文判定
      // 只看本轮新增消息，避免历史上下文触发成员熔断。
      const msgs = Array.isArray(c?.newMessages) ? c.newMessages : []
      // ★by1（乙案）：**停点只认显式终态** `bb_write(finish:true)`；写 result 不再结束 run。
      // 旧实现「带 result 即停」⇒ 成员中途一句「记录 1/12」当场结束 run（h4 铁证：798 个分身步骤
      // 里 12 条进度型汇报、3 条 run 终态 done 但产出只有 25 字）。模型常在"汇报完成"后继续
      // 反复调用（实锤：单 run 连调 5-7 次），所以在消息流里判停、且只认 finish。
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b.type !== 'toolCall' || b.name !== 'bb_write') continue
          const fin = (b as any).arguments?.finish
          if (fin === true || fin === 'true') return true
        }
      }
      /* ★1032-TM（P106）：**「本轮工具调用 30 轮」的硬上限已删**（老大："不需要，有防重复守卫就够"）。
         它的来历是当年"单个成员连刷 107 次 bb_write"——但那是**重复刷同一个工具**，下面这条
         "同工具+同参数+同结果连续第 5 次"的守卫本来就是为它设计的，能准确抓住死循环。
         而按"轮数"一刀切会误杀正常巡检：一次 fs_read + 一次 fs_grep 就是 2 轮，
         查 4 个问题各读 5 个文件就是 20 轮 ⇒ 任务没查完就被迫收尾（实测截图）。
         删掉的是"计数熔断"，保留的是"重复熔断"——**判断依据从"做了多少"改成"是不是在原地打转"**。
         `roundGrace` 没了用途，一并删。 */
      // 通用重复熔断：同工具、同参数且同结果连续第 5 次才停；结果变化说明有进展。
      const resultByCall = new Map<string, unknown>()
      for (const m of msgs) {
        if (m.role === 'toolResult' && m.toolCallId) resultByCall.set(String(m.toolCallId), m.content ?? m.result ?? '')
      }
      const calls: Array<{ sig: string; result: unknown }> = []
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b.type !== 'toolCall') continue
          let argsSig = ''
          try { argsSig = JSON.stringify(b.arguments ?? {}).replace(/\s+/g, '').slice(0, 120) } catch { argsSig = '' }
          const callId = String(b.id || b.toolCallId || '')
          if (!callId || !resultByCall.has(callId)) continue
          calls.push({ sig: `${b.name}:${argsSig}`, result: resultByCall.get(callId) })
        }
      }
      let run = 0
      let prev: string | null = null
      for (const call of calls) {
        let resultSig = ''
        try { resultSig = JSON.stringify(call.result).replace(/\s+/g, '').slice(0, 240) } catch { resultSig = String(call.result).slice(0, 240) }
        const key = `${call.sig}:${resultSig}`
        run = key === prev ? run + 1 : 1
        prev = key
        if (run >= 5) {
          const toolName = call.sig.split(':')[0]
          ctx.log('error', 'lifecycle', `循环熔断：${toolName} 参数和结果均未变化，连续第 ${run} 次，已硬停止本轮执行`, { guard: 'hard-stop', tool: toolName, repeat: run })
          return true
        }
        if (run === 4) {
          const toolName = call.sig.split(':')[0]
          ctx.log('warn', 'lifecycle', `循环预警：${toolName} 参数和结果均未变化，已连续第 4 次；这是软提醒，下一次仍重复才会停止`, { guard: 'soft-warning', tool: toolName, repeat: run })
        }
      }
      /* ★s3（与 server.ts:9427 同一判据，口径一致）：**模型自然收尾 ⇒ 结束回合**。
         这里原来固定 `return false`，意味着：既没有 bb_write(finish:true)、也没有触发重复熔断时，
         永远"继续" ⇒ pi 会再请求一跳 ⇒ 模型没话说 ⇒ 无事件 ⇒ 看门狗杀 ⇒ 面板显示「已中断」。
         判据看**本轮 assistant 消息的 stopReason**：
           · `'toolUse'` = 它还要调工具 ⇒ 必须继续（不返回 true）
           · 其它（stop/endTurn/length…）= 它说完了 ⇒ 结束
         为什么不会误判流式中间态：finishTurn 在 streamAssistantResponse await 出**完整 message**
         之后才被调用（agent-loop.js:141→179），`c.message` 是最终消息，不是片段。
         ⚠️ 与 server 那处唯一的语义差别：那边还要跑"软段续跑/护栏"逻辑，所以放在护栏之前；
            这边没有续跑机制，直接判即可。 */
      const _stopReason = String((c?.message as any)?.stopReason || '')
      if (_stopReason !== 'toolUse') return true
      return false
    }),
    // 写类工具走主会话审批门禁（成员的 fs_write/fs_delete/run_command 弹权限卡，
    // "当前会话允许"按工具名记忆——批准一次后同类放行）；其余（读/搜索/汇报）免审。
    // 审批等待期间挂起看门狗（等待无心跳，用户可能长时间不在线——审批自带 10 分钟超时不会永久挂）
    beforeToolCall: async (tctx: any) => {
      ctx.log('info', 'tool', `[${mName}] ${tctx.toolCall.name} ${truncate(JSON.stringify(tctx.args ?? {}), 120)}`)
      /* ★L4：检查点（副作用工具执行前落盘）。放在审批之前 —— 用户点"允许"时正文已安全。
         白名单由 server 的 checkpoint 实现过滤，这里对所有工具都问一次（只读工具不会被写盘）。
         ★L4-c：把这次调用一起传过去（server 用它记 "即将执行什么" 的意图，id 用于结束时销账）。 */
      if (ctx.checkpoint) await ctx.checkpoint(member.id, String(tctx.toolCall.name || ''), {
        id: String(tctx.toolCall.id || ''),
        name: String(tctx.toolCall.name || ''),
        arguments: tctx.args ?? tctx.toolCall.arguments,
      })
      // 无差别进程杀伤硬拦截（0902 事故：成员跑 taskkill /IM node.exe 团灭 pi-bridge/vite）。
      // 放在写类审批之前：full_access 模式下主会话审批门禁直接放行，成员侧必须自拦
      if (tctx.toolCall.name === 'run_command') {
        const kill = matchIndiscriminateKillCommand(String(tctx.args?.command || ''))
        if (kill) {
          ctx.log('error', 'approval', `[${mName}] 已拦截无差别进程杀伤命令：${kill.cmd}`)
          return { block: true, reason: `命令「${kill.cmd}」会按映像名杀掉所有 ${kill.image} 进程（包括 NiusDream 后端自身）。请用 taskkill /F /PID <具体进程号> 指定进程，或用其他方式停止你启动的测试服务。` }
        }
      }
      /* ★1034-commit6：列表补 `fs_edit` —— 它和 fs_write 同为写类操作，原来漏在名单外
         ⇒ 成员编辑文件**连免审日志都没有**（只写不记）。现在走同一入口：
         `ctx.approval` 一律放行（成员内部免审），但会写一行
         `[团队][mode] 成员 X 免审执行 fs_edit` —— 满足"免审也要能查到谁干了什么"。 */
      if (['fs_write', 'fs_edit', 'fs_delete', 'run_command'].includes(tctx.toolCall.name)) {
        watchdog.suspend()
        try {
          // 权限申请必须留痕（权限筛选可见）——之前成员弹卡用户在日志里看不到来源（0901 反馈 #5）
          ctx.log('warn', 'approval', `[团队] 成员 ${mName} 请求授权：${tctx.toolCall.name}`)
          /* ★1034：传成员名当 actor —— 免审日志要能查到"是谁"。 */
          const r = await ctx.approval(tctx.toolCall.name, tctx.args, mName)
          if (r?.block) {
            ctx.log('warn', 'approval', `[${mName}] ${tctx.toolCall.name} 被拒绝：${r.reason || '用户拒绝'}`)
            return { block: true, reason: r.reason }
          }
          ctx.log('info', 'approval', `[团队] 成员 ${mName} 的 ${tctx.toolCall.name} 已获授权/免审`)
        } finally {
          watchdog.resume()
        }
      }
      return undefined
    },
  })

  /* ★1032（P19 结构）：**subAgents / subControllers 两张表已删** ——
     它们和 `watchdogs` 记的是同一件事（谁在跑、怎么停），而 `watchdogs` 现在既存 agent 也存 ac，
     且登记点（这里）到 armWatchdog 之间**没有 await**，不存在"表还没登记"的窗口 ⇒
     三张表记一件事 = 三份可能对不上的真相（铁律：一个事实只有一个写者）。 */

  // ── run 记录：开工即落盘（0910 反馈4：需求"后端不丢"，不接受前端兜底拼装）──
  // 旧实现只在 run 结束时 push 快照 → 派发途中后端被杀（用户实锤：重启后成员气泡消失）就全没了。
  // 现在：①开工写 status='running' ②订阅里节流增量更新（工具轨迹/分段/计划）③正常/看门狗/异常
  // 三条结束路径都**就地更新同一条记录** ④读侧 loadBlackboard 把残留 running 自愈成 'interrupted'
  // （带原因）——任何时刻进程被杀，都还留着"这个成员干了什么"。
  if (!Array.isArray((bb as any).runs)) (bb as any).runs = []
  const runRec: any = {
    runId, stepId: step.id, memberId: member.id, memberName: mName,
    /* ★1036-S4：**派发任务原文**随 run 快照一起存 —— 标签页要显示"主 agent 派了什么活"，
       这是唯一的权威来源（原来只有 transcript 里 tool 参数有，前端得反解工具参数才能拿到）。
       只存打包后的任务单（`taskText`），不存内部提示词。 */
    task: String(taskText || ''),
    /* ★1032-C0：本 run 的派发归属（读侧唯一判据）。老数据没有这个字段 —— 那批会读到空，
       由 C-0-c 的一次性迁移脚本补齐，**读侧不留 stepId 兜底**（宁少卡不错卡）。 */
    callId: callId || undefined,
    /** 0913 头像批：成员预设 id —— 前端气泡按它取预设头像（未设置则回退默认头像） */
    memberPreset: member.preset,
    status: 'running', text: '', reasoning: '',
    tools: [], model: effectiveModelId || undefined,
    modelFallback: modelFallback || undefined,
    modelConfigured: member.modelMode === 'independent' ? String(member.modelId || '') : undefined,
    plan: undefined, segments: [],
    timing: { llmMs: 0 }, usage: undefined,
    t: Date.now(), startedAt: Date.now(),
  }
  ;(bb as any).runs.push(runRec)
  /* ★by1（乙案）：**终点信号随 run 一起落盘** —— `finalized` 只有 bb_write(finish:true) 才为 true，
     `interim` 是中途汇报（run 进度），**不是**交付产出。
     落盘不需要白名单：saveBlackboard 合并 runs 时是**整对象**取新（:405-424），新子字段跟着 run 走；
     f1a 的坑只在"会话级字段"（session.plan 那类手工逐字段搬的），与 runs 无关 —— 已核实。
     老黑板里的 runs 没有 finalized 字段 ⇒ 读侧（judgeRunOutcome）把 undefined 当"自然结束"，语义与改造前一致。 */
  const runFinishFields = () => ({
    finalized: reportState.finalized,
    ...(reportState.interim.length ? { interim: reportState.interim.slice(-8) } : {}),
  })
  activeRunIds.add(runId)
  /* ★L5：落盘实现已抽到模块级 `persistBoardRuns`（runMemberTurn 共用同一份）——
     这里只是别名，调用点一个没动，行为逐字不变。 */
  const persistRuns = () => persistBoardRuns(bb)
  persistRuns()

  // bb_write 限流：正常完成 2~3 次足够（result + 途中 finding）。刷屏 = 模型误解纪律，
  // 超限后工具报错并明示"立即结束"，防一轮烧几十次调用（测试3 曾单成员刷 40+ 次）。
  // 状态本体 bbWriteState 在上方（工具工厂之前）声明——此处只留时间戳
  const started = Date.now()

  /* ★tw1s：**本 run 的账本起点** —— 必须在任何 LLM 调用之前取（`agent.prompt` 在下面才开跑）。
     收尾时再读一次，差值 = 本 run 真实消耗（几十跳全算；旧口径只算最后一跳 ⇒ 漏 97%）。
     拿不到起点（成员会话还没建 / 注入缺失）⇒ 全程回退旧口径，并在日志留痕。 */
  const usageBase = readMemberLedger(ctx, String(member.id))
  if (!usageBase) {
    try { ctx.log('warn', 'session', `[团队·用量] ${mName}：取不到会话账本起点（成员会话未建/未注入），本次 run 的 token 只能按"最后一条 usage"估（会偏小）`) } catch { /* ignore */ }
  }
  /** run.usage 的唯一决议入口（过程快照 / 击杀 / 异常 / 正常四条收尾路径共用） */
  const runUsageOf = (msgs: any[]) => {
    const r = resolveRunUsage({
      base: usageBase,
      now: readMemberLedger(ctx, String(member.id)),
      msgs,
      onWarn: (m) => { try { ctx.log('warn', 'session', `[团队·用量] ${mName}：${m}`) } catch { /* ignore */ } },
    })
    runRec.usageSource = r.source
    if (r.source === 'ledger' && !runRec.usageSince) runRec.usageSince = Date.now()
    return r.usage
  }

  // 看门狗：死循环/挂死检测，超时 abort 并把原因写进步骤（主 agent 收到后自行调整/打回/上抛）
  let watchdogReason: string | null = null
  const watchdog = armWatchdog(ctx, `${ctx.sessionId}/${runId}`, agent, (reason) => {
    watchdogReason = reason
    ctx.log('warn', 'session', `[团队] ${mName} ${reason}`)
  }, ac, { memberId: member.id, memberName: mName, stepId: step.id })
  // 0911 三批：巡检官（方向；与看门狗「死活」并行）——规则预筛即时评估，疑似才轻量复审；纠偏一次后仍异常则击杀
  let inspectorKillReason: string | null = null
  const inspector = armInspector({
    agent, memberName: mName, roleText, stepText: step.text, taskText, acceptance,
    log: (msg) => ctx.log('warn', 'session', `[团队·巡检] ${msg}`),
    note: (text) => {
      streamNotes.push({ kind: 'inspector', attempt: 1, reason: text })
      try {
        ctx.broadcast({
          type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
          memberId: member.id, memberName: mName, seq: ++seq,
          event: { type: 'stream_note', kind: 'inspector', attempt: 1, reason: text },
        })
      } catch { /* ignore */ }
    },
    onKill: (reason) => { inspectorKillReason = reason },
  })
  // 子 agent 事件订阅（含透传 + bb_write 计数限流 + 工具轨迹记录）
  let seq = 0
  let lastRunSnap = 0
  /** 巡检官：tool_execution_end 不带参数 → 用 start 事件按 toolCallId 暂存参数对齐 */
  const pendingCallArgs = new Map<string, unknown>()
  /** 巡检官：sub_plan 的进展信号 = 完成项数增加（全量替换语义，可能减少，取历史最大） */
  let lastPlanDone = 0
  const toolLog: Array<{ name: string; status: string; result?: string }> = []
  /** 过程快照（节流 8s / 工具完成时强制）：把"此刻能看到的东西"写进 run 记录 */
  const snapshotRunProgress = (force = false) => {
    const now = Date.now()
    /* ★1032f：节流从 8s 收到 2s —— 8s 是"落黑板存档"的节奏（够用），但过程流要的是
       "能看到在动"，8 秒一跳太僵。2s 一帧 = 单个分身约 0.5 帧/秒，3 个分身并行也就 1.5 帧/秒，
       配合 pushTurnSnapshot 自带的 100ms 合帧，帧量仍在安全区内（不会冲爆帧窗口）。 */
    if (!force && now - lastRunSnap < 2000) return
    lastRunSnap = now
    try {
      const live = (agent.state.messages || []) as any[]
      const lastTextMsg = [...live].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'text' && c.text))
      const txt = lastTextMsg ? (lastTextMsg.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : ''
      runRec.text = txt.slice(0, 8000)
      runRec.tools = toolLog.slice(0, 40)
      /* ★1036-S29：**累积合并**，不再整体替换（只增不改）—— 见 syncRunSegments 注释。 */
      syncRunSegments(runRec, buildRunSegments(live))
      runRec.usage = runUsageOf(live)   // ★tw1s：过程快照也用账本差值（否则跑动中数字一直偏小）
      runRec.timing = { llmMs: Date.now() - started }
      if (subPlanState.items.length) runRec.plan = subPlanState.items
      persistRuns()
      /* ★1032f：**同时推出实时快照** —— 投影（session.subRuns）据此在运行期间就有最新 segments。
         没有这一步，投影只在「派活 / 中止 / 全部跑完」三处更新 ⇒ 过程中一直是空壳
         （实测同一 runId：实时侧 21 段 vs 投影侧 10 段，差 11 段）。
         这里只推"本 run 自己"，不碰别的 run（并行安全）；失败不影响执行。 */
      /* ★1032-fix（团队过程流实时）：**就地过滤，不建容器** ——
         · `bb.runs` 里的 runRec 是**活对象**（:1025 push 引用，:1084-1089 运行时 mutate）
         · `runRec.callId`（:1014）就是派发归属 ⇒ 按它精确取出本批
         · 60 条上限裁的是**最旧**的，本批在**末尾**，不会被裁
         ⇒ 零容器、零拷贝、零生命周期管理。
         与分身的区别：分身靠 `startedRuns` 容器是因为 **`cloneRuntime` 没有 bb**，
         只能靠 `onRunSnapshot` 回调把 run 递出来；团队这里 `bb` 就在手上，
         不需要那层中间人 ⇒ **团队侧不再使用 `ctx.onRunSnapshot`**。
         ⚠️ 这不是"写两次"的兜底 —— 三个时刻的数据都真实：
            派活（registerSubRuns）= 空壳 segments=0，让卡先出现；
            这里（pushRunSnapshot）= 运行中每 2s 的最新快照；
            收尾（registerSubRuns）= 终态持久化。 */
      try {
        const _cid = String(callId || '')
        if (_cid && ctx.pushRunSnapshot) {
          /* ★1036-S29（**"两个分身内容来回交替、段数 12→0→12"的真正根因**）：
             原来这里从 `bb.runs` 里按 callId 过滤出"本批"再推。而**分身的 `bb` 在创建时会把
             共享黑板 `#clone` 里的历史 runs 一起装进来**（cloneRuntime:136-141，为了刷新后能回放），
             于是同一个 bb 里可能同时躺着「我自己」和「另一个分身已经落盘过的旧副本」——
             filter 会把它们一起推出去，那个**旧副本的 segments 是空的**，
             `pushRunSnapshot` 按 runId 合并时就把对方刚刚累积的内容覆盖成 0。
             日志实锤：`段数回退 runId=794a1bc8 2→0 batch=2`（batch=2 就是铁证：一次推了两条 run）。
             ⇒ 一条 run 的权威对象就是它自己的 `runRec`，**只推自己**，不去黑板里再找一遍。
             这也是"一个数据只有一个写者"的直接体现（团队侧同样成立，且更省帧）。 */
          ctx.pushRunSnapshot(_cid, [runRec])
        }
      } catch (e) {
        /* ★1036-S33（铁律：失败了就要如实报，不许静默）—— 推帧失败 = 界面会停在这一帧，
           必须留下痕迹，否则表现只是"卡片不动"，排查时无从下手。 */
        console.warn('[1036] 推 run 快照失败（界面会停在这一帧）runId=' + String(runId).slice(0, 8) + '：' + String((e as Error)?.message || e))
      }
    } catch (e) {
      console.warn('[1036] 过程快照构建失败（该 run 的段不会更新）runId=' + String(runId).slice(0, 8) + '：' + String((e as Error)?.message || e))
    }
  }
  /** ★1036-S26（实测"点了停止，分身卡还是执行中"的**结构根因**）：
   *  run 有三条收尾路径（击杀 / 异常 / 正常，见下方 `killedReason`、`caughtErr`、终帧），
   *  原来三条都只做 `persistRuns() + broadcastBB() + session/subagent-event`。
   *  而前端 **1032-C 起已明确不再消费 `session/subagent-event`**（ChatInterface:481），
   *  `broadcastBB` 是黑板帧、进不了对话流 ⇒ run 的**终态一个字节都到不了前端**，
   *  卡片只能停在最后一次 `running` 快照上（计时继续涨），直到下次 loadHistory / 对账重建。
   *  ⇒ 终态必须走**和运行中同一条通道**（`ctx.pushRunSnapshot`）：后端按 runId 合并进
   *    `session.subRuns` 并推帧（累加器在 → 整轮投影；不在 → run-snapshot 独立通道）。
   *  这是"同一件事只允许一条数据通路"的落实，不是新增兜底。
   */
  const pushRunTerminal = () => {
    try {
      const cid = String(callId || '')
      if (cid && ctx.pushRunSnapshot) ctx.pushRunSnapshot(cid, [runRec])
    } catch (e) {
      /* ★1036-S33：终态帧发不出去 ⇒ 卡片会永远停在"执行中"。这条必须报错，不能静默。 */
      console.error('[1036] 终态帧推送失败（卡片会停在执行中）runId=' + String(runId).slice(0, 8) + '：' + String((e as Error)?.message || e))
    }
  }
  agent.subscribe((event: any) => {
    /* ★1032（P45）：子 agent 的事件**先喂内容管线**（累加器 → 投影帧 → 收尾落库），
       与主 agent 同一份 `handleAgentEvent` ⇒ 窗口里的思考/工具/正文与主对话同频同形。 */
    try { ctx.feedMemberEvent?.(String(member.id), event, agent) } catch (e) { console.warn('[P45] 成员事件入管线失败:', String((e as Error)?.message || e)) }
    if (event?.type === 'tool_execution_start') {
      if (event?.toolName === 'bb_write') bbWriteState.writes++
      // 巡检官：暂存参数（end 事件不带参数），按 toolCallId 对齐
      if (event?.toolCallId) pendingCallArgs.set(String(event.toolCallId), event.args)
      /* ★1036-S27（**"派出分身时看不到它在调什么工具，停止后才一次性出现"**的结构根因）：
         快照原来只在 `tool_execution_end` 强推 + `message_update` 走节流。而**工具执行期间既没有
         end 也没有新 delta** ⇒ 在「工具开始 → 工具结束」这段（长任务里可能是几十秒到几分钟）
         run 快照**一帧都不产生** ⇒ 卡片/标签页在这段时间里看不到这个工具，
         直到工具结束或整轮收尾 `buildRunSegments` 全量重建才刷出来（用户看到的就是"停止后才出现"）。
         ⇒ 工具**一开始**就强推一帧：让"正在跑什么"立刻可见（此时 assistant 消息里的 toolCall
         已经落进 `agent.state.messages`，`buildRunSegments` 能产出一条 status='running' 的 tool 段）。 */
      snapshotRunProgress(true)
    }
    /* ★1032f（**纯文字分身也要有过程**）：原来 `snapshotRunProgress` 只在
       `tool_execution_end` 时调 ⇒ 一个只输出文字、不调工具的分身（实测"数数"任务就是）
       在整个运行期间**一次快照都不产生** ⇒ 投影侧 segments 恒空 ⇒ 气泡卡在「成员正在工作」。
       这里把 message_update（正文/思考增量）也接上：函数自带 2s 节流（见 snapshotRunProgress 的 `lastRunSnap`），
       所以不会因为 delta 频繁而爆量。`force=false` 走节流是刻意的 —— 过程快照不需要逐字实时。 */
    if (event?.type === 'message_update' || event?.type === 'message_end') {
      snapshotRunProgress(false)
    }
    if (event?.type === 'tool_execution_end' && event?.toolName) {
      const resText = (Array.isArray(event.result?.content) ? event.result.content : [])
        .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 160)
      toolLog.push({
        name: event.toolName,
        status: event.isError ? 'error' : 'done',
        result: resText,
      })
      if (toolLog.length > 60) toolLog.splice(0, toolLog.length - 60)
      snapshotRunProgress(true)
      // 0911 三批：巡检官规则预筛（零模型成本；疑似才触发轻量复审）
      const cid = String(event.toolCallId || '')
      const argsRaw = pendingCallArgs.get(cid)
      pendingCallArgs.delete(cid)
      if (pendingCallArgs.size > 80) pendingCallArgs.clear()
      let argsStr = ''
      try { argsStr = JSON.stringify(argsRaw ?? {}).replace(/\s+/g, ' ').slice(0, 160) } catch { argsStr = '' }
      let progressOverride: boolean | undefined
      if (event.toolName === 'sub_plan') {
        const dn = subPlanState.items.filter((i: any) => i.done).length
        progressOverride = dn > lastPlanDone
        lastPlanDone = Math.max(lastPlanDone, dn)
      } else if (event.toolName === 'bb_write') {
        progressOverride = !event.isError
      }
      inspector.noteCall({ name: String(event.toolName), args: argsStr, result: resText, isError: !!event.isError, progressOverride })
    }
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, memberPreset: member.preset, seq: ++seq, model: effectiveModelId || undefined,
        modelFallback: modelFallback || undefined,
        modelConfigured: member.modelMode === 'independent' ? String(member.modelId || '') : undefined,
        event,
      })
    } catch { /* ignore */ }
  })

  /* ★0930 修（实测"点停止分身卡在过程态、根本停不掉"）：**用户中止要走击杀收尾** ——
     abort 后 prompt 会以异常/返回两种方式落地，这里统一记 wasAborted，收尾归入 killedReason
     路径（status=timeout → 前端映射 interrupted，气泡定稿）+ 气泡里落一条「用户已停止」。
     ★0930b（实测残留：停止后仍有 run 卡 running 十几分钟）：abort 后 prompt 偶发**不结算**
     （工具/流的某条等待路径不落地）⇒ 加 8s 强制结算兜底：中止起算 8 秒内必须落地走收尾，
     绝不留过程态僵尸 run。计时只在 abort 后起算，正常 run 零影响。 */
  let wasAborted = false
  let caughtErr: any = null
  const settleGuard = new Promise<never>((_, rej) => {
    const fire = () => setTimeout(() => rej(new Error('用户已停止')), 8000)
    if (ac.signal.aborted) void fire()
    else ac.signal.addEventListener('abort', () => { void fire() }, { once: true })
  })
  try {
    await Promise.race([agent.prompt(`开始执行你的任务单（步骤 ${step.id}）。完成后必须用 bb_write 汇报产出摘要与产物路径并带 finish:true（finish:true 才会结束本次执行），然后立即结束（不要反复汇报）。`), settleGuard])
    wasAborted = ac.signal.aborted || !!(agent as any).signal?.aborted
  } catch (e) {
    /* ★0930d（实测残留 run 卡 running 的真凶之一）：abortSubAgents 先 abort **agent** 后 abort **ac**，
       prompt 在这个窗口里以 abort 错误落地时 ac.signal 还没置位 ⇒ 旧判定当它是真异常、跳过收尾
       ⇒ run 永远卡过程态。判定改为「两个信号任一 + 错误文本」三路兜（不放过中止，也不误吞真异常）。
       ★0930e（真凶之二，存量老洞）：**非中止异常旧代码直接 rethrow、跳过收尾** ⇒ runRec 永远 'running'
       （实测每批分身恰好一个卡过程态——就是它在 LLM 重试中抛错了）。现在先落收尾（status=error +
       错误段），再原样抛出，runCloneOnce 的失败链语义不变。 */
    const _m = String((e as any)?.message || e)
    wasAborted = ac.signal.aborted || !!(agent as any).signal?.aborted || /abort/i.test(_m)
    if (!wasAborted) caughtErr = e
  } finally {
    watchdog.disarm()
    inspector.disarm()
    /* ★1032（P19）：两张冗余表已删，注销只剩 watchdog.disarm()（它自己会把 entry 摘掉）。 */
    activeRunIds.delete(runId)
    // 0911 反馈③：run 收尾释放文件写锁（含击杀/异常路径，finally 必到）
    releaseFileLocks(runId)
    ac.abort()
    try { agent.abort() } catch { /* ignore */ }
  }
  // 0911 三批：巡检官击杀与看门狗击杀同走此路径（先到者为准，实际不会同时发生）
  const killedReason = watchdogReason || inspectorKillReason || (wasAborted ? '用户已停止' : '')
  if (killedReason) {
    // 看门狗/巡检官击杀的 run 也要落快照：否则刷新后该成员气泡丢失（黑板步骤状态还在但 runs 缺失）
    const killedMsgs = (agent.state.messages || []) as any[]
    const killedUsage = runUsageOf(killedMsgs)   // ★tw1s：击杀路径同样算全量差值
    const killedModel = [...killedMsgs].reverse().find(m => m?.role === 'assistant' && m?.model)?.model
    /* ★1036-S28（**状态单写者**，老大 2026-10-31 铁律第 11 条）：
       终态一旦被某个终结者写定（通常就是 `settleRunningRuns` —— 用户点停止那一刻，
       那代表**用户意图**、必须权威），后续收尾路径**只许补内容，不许改状态**。
       原来这里无条件 `status:'timeout' + endedAt:now`，会把已经落定的 interrupted
       改写成另一个值、还配一个新的结束时间 —— 这正是"点了停止，过一会儿有一个又变回去"的来源。
       ⇒ 写权限收缩给"第一个到达的终结者"，靠**权限**解决，不靠事后比较仲裁。 */
    const _termKilled = !!runRec.endedAt
    /* ★1036-S29：收尾段也走**累积合并**（不再整体替换）—— 收尾前界面上已经显示过的过程不会消失。 */
    syncRunSegments(runRec, [...buildRunSegments(killedMsgs, { markOrphanError: true }), ...notesToSegments(), ...(wasAborted ? [{ type: 'text', text: '—— 用户已停止 ——' }] : [])])
    Object.assign(runRec, {
      ...runFinishFields(),
      reasoning: '',
      ...(_termKilled ? {} : { status: 'timeout', endedAt: Date.now() }),
      /* ★1036-S27：**终止原因**（用户停 / 看门狗 / 巡检官）—— 卡片摘要按它给白话，
         不让前端从"最后一段正文"里猜发生了什么。已有原因（settle 写的 user）不覆盖。 */
      ...(runRec.stopReason ? {} : { stopReason: wasAborted ? 'user' : (watchdogReason ? 'watchdog' : 'inspector') }),
      tools: toolLog.slice(0, 40), model: effectiveModelId || killedModel,
      plan: subPlanState.items.length ? subPlanState.items : undefined,
      /* ★0930：用户中止时气泡尾部落「用户已停止」一行 —— 上面 syncRunSegments 已把该段并进累积数组 */
      timing: { llmMs: Date.now() - started },
      usage: killedUsage,
    })
    persistRuns()
    broadcastBB(ctx, bb)
    pushRunTerminal()
    /* ★1032-TM（P1）：中止也在成员会话里留痕 —— 否则 tab 里看起来"任务凭空消失"。 */
    try { ctx.endMemberRun?.(String(member.id), agent) } catch (e) { console.warn('[P45] 中断收尾失败:', String((e as Error)?.message || e)) }
    try { ctx.appendMemberMessage?.(String(member.id), 'assistant', `【未完成】${killedReason}`) } catch { /* ignore */ }
    /* ★1104-H：成员状态是**必需能力**（不是可选）—— `patchMemberState` 自己不会抛，这里不再套 try 吞错。 */
    ctx.setMemberState(String(member.id), 'interrupted', { unread: true, runId })
    /* ★1004b 防僵尸三保险之③：击杀/中止路径补**终态事件帧** —— 原来只发黑板帧（broadcastBB），
     * 前端 subAgent 节点收不到终态 → 永卡 running（1004 CPU 满事故僵尸源头之一）。
     * interrupted 语义随帧下发（看门狗/巡检官/用户停止都算"被打断"，不是真 error）。 */
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'error', message: killedReason, interrupted: true },
      })
    } catch { /* ignore */ }
    throw new Error(killedReason)
  }
  /* ★0930e：非中止异常的收尾 —— 先落盘+广播（status=error，气泡出错误段并定稿），
     再原样抛给 runCloneOnce 的失败链（step.result 语义不变）。 */
  if (caughtErr) {
    const errMsg = String((caughtErr as any)?.message || caughtErr)
    const errMsgs = (agent.state.messages || []) as any[]
    /* ★1036-S28：同上 —— 已定终态（用户已停止）不被"异常收尾"改写，只补错误内容。 */
    const _termErr = !!runRec.endedAt
    /* ★1036-S29：同上，累积合并。 */
    syncRunSegments(runRec, [...buildRunSegments(errMsgs, { markOrphanError: true }), ...notesToSegments(), { type: 'error', text: errMsg.slice(0, 300) }])
    Object.assign(runRec, {
      ...runFinishFields(),
      ...(_termErr ? {} : { status: 'error', endedAt: Date.now() }),
      text: errMsg.slice(0, 500), reasoning: '',
      tools: toolLog.slice(0, 40), model: effectiveModelId,
      plan: subPlanState.items.length ? subPlanState.items : undefined,
      timing: { llmMs: Date.now() - started },
      usage: runUsageOf(errMsgs),   // ★tw1s
    })
    persistRuns()
    broadcastBB(ctx, bb)
    pushRunTerminal()
    /* ★1032-TM（P1）：异常也在成员会话里留痕。 */
    try { ctx.endMemberRun?.(String(member.id), agent) } catch (e) { console.warn('[P45] 失败收尾失败:', String((e as Error)?.message || e)) }
    try { ctx.appendMemberMessage?.(String(member.id), 'assistant', `【失败】${errMsg.slice(0, 500)}`) } catch { /* ignore */ }
    ctx.setMemberState(String(member.id), 'error', { unread: true, runId })
    /* ★1004b 防僵尸三保险之③：异常路径同补终态事件帧（原只发黑板帧 → 前端节点永卡 running） */
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'error', message: errMsg.slice(0, 300), interrupted: false },
      })
    } catch { /* ignore */ }
    throw caughtErr
  }

  // 终帧：本次 run 的 usage/timing（前端持久化统计用，刷新后可回看）
  const liveMsgs = (agent.state.messages || []) as any[]
  const lastUsageMsg = runUsageOf(liveMsgs)   // ★tw1s：正常收尾 = 账本差值（全跳）
  const lastModel = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && m?.model)?.model
  const finalText = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'text' && c.text))
  const finalTextStr = finalText ? (finalText.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : ''
  const finalReasoning = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'thinking' && c.thinking))
  const finalReasoningStr = finalReasoning ? (finalReasoning.content as any[]).filter((c: any) => c.type === 'thinking').map((c: any) => c.thinking).join('') : ''
  // run 记录收尾（就地更新开工时那条：后端权威，前端只读、不做兜底拼装）
  // 0910 三批：正文为空（成员只调 bb_write 汇报、没发正文）时用汇报摘要兜底，避免气泡空白
  /* ★by1：气泡正文/产出证据只认**终态汇报**（reportState.summary 只在 finish:true 时才有值）；
     中途汇报（interim）**绝不**改当交付正文。 */
  const finalTextOut = finalTextStr.trim() ? finalTextStr : reportState.summary
  /* ★1036-S29：同上，累积合并（收尾前已显示的过程不消失）。 */
  syncRunSegments(runRec, [...buildRunSegments(liveMsgs), ...notesToSegments()])
  /* ★1032-TM（P96）：**这一趟的终态要读 `llmFailed` 这个事实** —— 重试耗尽后 LLM 层是"正常返回"的
     （不抛异常），不读这个标记就会把失败写成 done（实测：`[NIS-ERR]429` 的 run 被记成「完成」并送审核）。
     有产出也照样标 error：这趟没跑完，产物只是"跑了一半的东西"，不能当交付。 */
  const _llmFail = String((runRec as any)?.llmFailed?.reason || '')
  /* ★f1b（P0-3）：终态判决改用**与分身批次层同一个函数** —— 「没报错 **且** 有产出」才算成功。
     旧代码只看 llmFailed 就写 done，而 cloneRuntime 判成败只看 step.result 非空 ⇒
     同一个 run 出两种判决（气泡写"完成"、主 agent 收到"失败"，a2x 报的 P0）。
     产出证据 = finalTextOut（正文；为空时已用 bb_write 汇报摘要兜底）。 */
  /* ★by1（乙案）：多传一个 `finalized` —— 没有 finish:true 收尾的 run 只有"自然结束"才算完成，
     被看门狗/巡检掐断的那些由 runVerdict 判 'partial'（不是 ok）。 */
  const _verdict = judgeRunOutcome({ llmFailed: _llmFail, output: finalTextOut, finalized: reportState.finalized })
  Object.assign(runRec, {
    ...runFinishFields(),
    /* ★1036-S28：正常完成路径同样遵守"终态单写者" —— 若用户在它收尾的瞬间点了停止，
       settle 已经落定 interrupted（用户意图），这里不再改成 done。 */
    ...(runRec.endedAt ? {} : { status: _verdict.ok ? 'done' : 'error', endedAt: Date.now() }),
    ...(_verdict.ok ? {} : { error: _verdict.detail }),
    text: finalTextOut.slice(0, 8000), reasoning: finalReasoningStr.slice(0, 4000),
    tools: toolLog.slice(0, 40), model: effectiveModelId || lastModel,
    // 0910 反馈4：成员自列计划（sub_plan）随 run 落盘，刷新后气泡里可回放
    plan: subPlanState.items.length ? subPlanState.items : undefined,
    // segments 已由上面 syncRunSegments 累积合并（按消息序穿插 + 重试/巡检注释附尾）
    timing: { llmMs: Date.now() - started },
    usage: lastUsageMsg,
  })
  persistRuns()
  pushRunTerminal()
  /* ★1032-TM（P1）：本轮**产出**落进成员会话（tab 里看到"它答了什么"）——
     与派活的任务单在同一个会话里，凑成完整聊天记录。 */
  /* ★1032（P45）：**落库交给内容管线** —— 收尾那次 `agent_end` 已经 settle 进成员会话的 messages。
     这里不再单独写一遍：两套写者就是"同一段内容两份"的老病根。 */
  /* ★1032-TM（P1）：完成 → 徽标绿 N（未读）；★P96：重试耗尽 → 徽标红（与 run 的终态同一个判据）。
     ★1104-H：必需能力，不吞错（`patchMemberState` 是唯一写入口，自己不抛）。 */
  ctx.setMemberState(String(member.id), _verdict.ok ? 'done' : 'error', { unread: true, runId })
  try {
    ctx.broadcast({
      type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
      memberId: member.id, memberName: mName, seq: ++seq,
      event: {
        type: 'agent_stats',
        model: effectiveModelId || lastModel,
        timing: { llmMs: Date.now() - started },
        usage: lastUsageMsg,
      },
    })
  } catch { /* ignore */ }
}

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
 *  返回 false = 等不到（调用方必须如实记失败，不许当成跑过）。 */
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
        const got = sliceRunMessages(after, beforeLen, userMsgId).slice.some((m: any) => String(m?.role || '') === 'assistant')
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

/** ★L5：把一次派发跑在**成员会话**里（一个普通会话的一轮）。
 *  与 `runSubAgent` 的分工：这里**不建 Agent、不拼 sys、不喂事件** —— 那些都是会话自己的事。
 *  这里只做调度该做的事：拿会话 → 落 run 记录 → 发消息 → 提产出 → 收尾记账。 */
export async function runMemberTurn(
  ctx: TeamCtx,
  bb: Blackboard,
  step: BlackboardStep,
  member: TeamMember,
  runId: string,
  taskText: string,
  acceptance: string,
  callId?: string,
): Promise<void> {
  const mName = memberName(ctx.team, member.id)
  if (!ctx.ensureMemberSession || !ctx.runPromptCore) {
    /* 接线缺陷必须喊出来（不是"没事发生"）：不接线就等于这一步没执行。 */
    throw new Error('成员会话通路未接线（server 未注入 ensureMemberSession/runPromptCore）—— 本步没有执行')
  }

  /* ① 拿成员会话（与用户私聊**同一个窗口** ⇒ 用户点进去就能看到这一轮） */
  const ms: any = ctx.ensureMemberSession(member.id)
  if (!ms) throw new Error('成员会话建不出来（父会话可能没有可用工作区）—— 本步没有执行')
  const sid = String(ms.id)
  const beforeLen = (() => { try { return Array.isArray(ms.messages) ? ms.messages.length : 0 } catch { return 0 } })()

  /* ② 任务单（全放 message，不碰 system） */
  const taskMessage = buildMemberTaskMessage(ctx, bb, step, member, taskText, acceptance)

  /* ③ 模型：独立模型必须显式下发 —— 走会话以后模型由「成员会话」决定，
     不下发就等于"团队里设了独立模型却不生效"（静默降级，正是要避免的那类）。 */
  let modelArg: Record<string, string> | undefined
  let modelFallback = false
  if (String((member as any).modelMode || '') === 'independent') {
    const ov = ctx.resolveMemberModel(member)
    if (ov) modelArg = { provider: ov.providerId, model_id: ov.model, base: ov.base }
    else {
      modelFallback = true
      ctx.log('warn', 'session', `[团队] 成员 ${mName} 独立模型（${member.modelId}）解析失败，本次用成员会话自己的模型`)
    }
  }

  /* ④ 黑板 run 记录：开工即落盘（后端权威）。★L5 瘦身：只留元数据，
        过程数据（思考/工具/正文）已经在成员会话里，再抄一份就是两份真相。 */
  if (!Array.isArray((bb as any).runs)) (bb as any).runs = []
  const runRec: any = {
    runId, stepId: step.id, memberId: member.id, memberName: mName,
    task: String(taskText || ''),
    callId: callId || undefined,
    memberPreset: member.preset,
    status: 'running',
    /* 用户点成员窗口看到的就是这一轮 —— 这个字段是"去哪儿看"的唯一指针 */
    memberSessionId: sid,
    model: modelArg ? String(modelArg.model_id) : (String(ctx.sessionModel?.() || '') || undefined),
    modelFallback: modelFallback || undefined,
    t: Date.now(), startedAt: Date.now(),
  }
  ;(bb as any).runs.push(runRec)
  persistBoardRuns(bb)
  /* ★L5：登记"这批 run 还活着" —— `memberRunLive`（派发时判"要不要排队"）与 server 侧的
     `countLiveSubRuns`（判"会话还有没有子在跑"）都读这张表。不登记的话：前者会把"排队中"算成
     "立即开工"，后者会在成员还在跑时把父会话判成空闲（后台通知就会插进正在跑的轮次里）。 */
  activeRunIds.add(runId)

  /* ⑤ 派发 */
  ctx.log('info', 'session', `[团队] 派发 ${step.id} → ${mName}（走成员会话 ${sid.slice(0, 8)}${modelArg ? `，模型 ${modelArg.model_id}` : ''}）`)
  const ac = new AbortController()
  let killedReason: string | null = null
  /* 中断/看门狗/单次上限都靠这张**唯一登记表**（watchdogs）：
     · `session.stopMember` → abortSubAgentByMember 按 memberId 找到它 → agent.abort() + ac.abort()
     · `session.cancel` → abortSubAgents 全停
     · 无活动 10 分钟 / 单次上限 → 看门狗 abort 并给 reason
     拿不到 agent（server 没注入 ensureMemberAgent）就不登记，但**留痕**——否则"点了停止没反应"无从排查。 */
  const agent: any = ctx.ensureMemberAgent ? ctx.ensureMemberAgent(sid) : null
  if (!agent) ctx.log('warn', 'session', '[团队] 取不到成员会话 agent ⇒ 本次派发没有登记看门狗/中断表（停止键会失效）')
  const watchdog = agent
    ? armWatchdog(ctx, `${ctx.sessionId}/${runId}`, agent, (reason) => {
        killedReason = reason
        ctx.log('warn', 'session', `[团队] ${mName} ${reason}`)
      }, ac, {
        memberId: member.id, memberName: mName, stepId: step.id,
        /* ★c1：**动态解析"现在真正在跑"的 agent** —— 这是修复"干完活却被判已中断"的关键。
           为什么不能只用上面那个 `agent`：`runPromptCore` → `getOrCreateAgent(sid)` 会用
           `configFingerprint` 比对，**不一致就 abort 旧实例、重建新实例**（server.ts:9569-9575）。
           真正跑这一轮的是新实例，工具事件全在它身上；订阅在旧实例上的心跳一次都收不到
           ⇒ 满 5 分钟按"无任何活动"误杀（实测 b1/m2：14:34~14:39 一直在调工具，14:39:23 被杀）。
           `ensureMemberAgent` 就是 `getOrCreateAgent` 的导出，再调一次拿到的是**当前**实例（重建过就是新的）。
           ⚠️ 不新增兜底：心跳仍只来自真实事件，只是"从哪个实例收"不再靠一次性快照。 */
        resolveAgent: () => { try { return ctx.ensureMemberAgent?.(sid) || null } catch { return null } },
      })
    : null
  const usageBase = readMemberLedger(ctx, String(member.id))
  const userMsgId = `l5run-${runId}`
  let fatal: any = null
  /* ★L5 修正（第一版踩了）：`ac.signal.aborted` 不能等到 finally 之后才读 ——
     `finally` 里那句 `ac.abort()`（清理用）会把它**恒置为真** ⇒ 每个 run 都被记成 interrupted。
     ⇒ 在 finally 里**先读**这个事实，再清理。 */
  let abortedBySignal = false
  /* ★q2（修 1）：**开工即把步骤标成 running 并落盘** —— 幂等，与 runStepTask 的写法一致。
     为什么这里还要再写一次（runStepTask:3053-3057 明明已经设过）：
       · 那是**当前唯一调用方**的状态，不代表"runMemberTurn 自己负责这件事"。
         把状态机的一部分挂在上游调用方的时序上，等于**两个写者靠约定同步** —— 谁改了上游就静默退化。
         这里补上，runMemberTurn 成为"这一轮在跑"的**自证**：从它开始执行那一刻，黑板就是 running。
       · 幂等：值已经是 'running' 时这次赋值没有任何行为变化（updatedAt 刷新一次，无害）。
       · 不造第二套状态机：用的是同一个 `step` 对象、同一个 `saveBlackboard`，只是把"谁负责声明开始"
         从"调用方替我声明"变成"我自己声明"。
     ⚠️ 只声明 running（开始）。结束态（review/failed/interrupted）仍由收尾那一处唯一写，
        不在开工处碰任何终态 —— 一个事实只有一个写者。 */
  if (String((step as any).status || '') !== 'running') {
    try {
      ;(step as any).status = 'running'
      ;(step as any).updatedAt = Date.now()
      saveBlackboard(bb)
      ctx.syncPlan?.(planItems(ctx, bb))
      broadcastBB(ctx, bb)
    } catch { /* 状态落盘失败不阻断执行（最多显示滞后一轮）；真正的问题会在收尾暴露 */ }
  }
  try {
    /* ★m1p：**进入派活轮**（引用计数 +1）。
       判据从"会话上的可变单值"改成"计数 > 0"，解决两条真实失效路径：
         · 并发重叠：两轮叠着跑时先结束的那轮不会把还在跑的那轮清零；
         · 先入队、后执行：`runPromptCore` 可能立刻返回 `{queued:true}`，但那不算这一轮结束 ——
           计数在整个 runMemberTurn 生命周期内保持 >0，直到它真跑完（或真失败）才 −1。
       旧写法（`ms.__l5Dispatch = {...}` + finally `delete`）在 m2 复用旧会话时实测丢标记 ⇒
       成员跑活弹了 4.5 分钟授权卡。 */
    const _depth = ctx.enterDispatchTurn(String(sid))
    ctx.log('info', 'approval', `[团队] ${mName} 进入派活轮（会话 ${sid.slice(0, 8)}，当前派活深度 ${_depth}）`)
    const r: any = await ctx.runPromptCore(sid, {
      message: taskMessage,
      /* 这条 user 消息的**持久 id**（server 把它当消息 id）—— 提取产出的精确定位锚点 */
      clientMessageId: userMsgId,
      /* 忙就等，不许"排进队列就返回"当跑完（§2.4） */
      __busyPolicy: 'wait',
      ...(modelArg ? { model: modelArg } : {}),
    })
    if (r?.queued) {
      const ran = await waitMemberTurnRan(ctx, ms, beforeLen, userMsgId, 10 * 60_000)
      if (!ran) throw new Error('成员会话 10 分钟仍未把这一轮跑完（消息可能还在队列里）——本轮未完成')
    }
    if (r && r.ok === false) throw new Error(String(r.error || '成员会话拒绝了这一轮（runPromptCore 返回 ok=false）'))
    /* ★L5：`turnFailed` 是**这一轮以错误收尾**的权威标记（LLM 报错/网关 400 等）——
       有产出也照样算失败：跑了一半的东西不能当交付。 */
    if (r?.turnFailed) throw new Error(`成员这一轮以失败收尾：${String(r.error || '未知原因')}`)
  } catch (e) {
    fatal = e
  } finally {
    /* ★L5：**先读**"是不是用户停的"（下面 ac.abort() 是清理，会把 signal 置成 aborted） */
    abortedBySignal = ac.signal.aborted
    try { activeRunIds.delete(runId) } catch { /* ignore */ }
    /* ★m1p：**离开派活轮**（计数 −1，归零才算这一轮真结束）。与上面的 enter 成对，必达。 */
    try {
      const _left = ctx.leaveDispatchTurn(String(sid))
      ctx.log('info', 'approval', `[团队] ${mName} 离开派活轮（会话 ${sid.slice(0, 8)}，剩余派活深度 ${_left}）`)
    } catch { /* ignore */ }
    try { watchdog?.disarm() } catch { /* ignore */ }
    try { ac.abort() } catch { /* ignore */ }
  }

  /* ⑥ 提取产出（需求 A：从 transcript 提） */
  let slice: any[] = []
  let by: 'id' | 'len' = 'len'
  try {
    const msgs: any[] = Array.isArray(ms.messages) ? ms.messages : []
    const r = sliceRunMessages(msgs, beforeLen, userMsgId)
    slice = r.slice; by = r.by
    if (by === 'len') ctx.log('warn', 'session', `[团队] ${mName}：本轮 user 消息没找到持久 id（${userMsgId.slice(0, 16)}…），产出改按长度切片提取`)
  } catch (e) {
    ctx.log('warn', 'session', `[团队] ${mName}：读成员会话消息失败（${String((e as Error)?.message || e)}）`)
  }
  const lastText = lastAssistantTextOf(slice)
  /* ★p1（病根 B）：**从成员会话的真实消息重建过程成果**。
     病状（实测导出 24 个 run 的黑板 + 备份）：g2 / h1 / k1 / k2 / n1 全是 `segments=0 / tools=0 / text=0 字`，
     而日志显示它们跑了十几次 fs_read / run_command —— 也就是说成员干了活，但成果一个字都没记下来。
     根因很直接：`snapshotRunProgress` **只定义在 `runSubAgent` 里**（本文件 2091 行），
     而默认派发路径是 `runMemberTurn`（memberViaSessionEnabled() 默认 true）——
     这条路从头到尾**没有任何过程快照**，runRec 只在收尾时被 Object.assign 写 status/usage，
     segments/tools/text 永远是初值 0。于是"中断 = 成果全丢"。
     修法：不猜、不编，**直接从 `ms.messages` 里真实存在的本轮消息重建**（同一个
     `buildRunSegments`，与 runSubAgent 的过程快照同源），并记录来源标记。
     为什么在收尾做而不是运行中做：运行中要给前端推实时帧，那是另一件事（且现在没有）；
     本轮只解决"中断后别把干过的活丢掉" —— 在收集 slice 的同一处顺手重建，零额外读取。 */
  try {
    if (Array.isArray(slice) && slice.length) {
      const segs = buildRunSegments(slice, { markOrphanError: true })
      if (Array.isArray(segs) && segs.length) {
        /* syncRunSegments 是"只增不改"的累积合并（同 runSubAgent 用法）——
           它保证不会因为本次 slice 比上次短就清空已有段。 */
        syncRunSegments(runRec, segs)
        runRec.segmentsSource = 'member-session-rebuild'
      }
      const toolSegs = (runRec.segments || []).filter((s: any) => s?.type === 'tool')
      if (toolSegs.length) {
        runRec.tools = toolSegs.slice(-40).map((s: any) => ({
          name: String(s.name || ''), status: String(s.status || 'done'), result: String(s.result || '').slice(0, 160),
        }))
      }
      const txt = lastText || ''
      if (txt.trim() && !String(runRec.text || '').trim()) runRec.text = truncate(txt.trim(), 8000)
    }
  } catch (e: any) {
    /* 重建失败不阻断收尾（最多过程数据缺一段），但必须留痕 —— 静默的话下次又查不出为什么是 0。 */
    ctx.log('warn', 'session', `[团队] ${mName}：从成员会话重建过程成果失败（runRec 过程数据将不完整）：${String(e?.message || e).slice(0, 120)}`)
  }
  const usageRes = resolveRunUsage({
    base: usageBase,
    now: readMemberLedger(ctx, String(member.id)),
    msgs: slice,
    onWarn: (m) => ctx.log('warn', 'session', `[团队·用量] ${mName}：${m}`),
  })

  const aborted = abortedBySignal || !!killedReason
  /* ★L5：**中止优先**。用户点停止时 prompt 也会抛（abort 异常），不能因为"有异常"就记成 error ——
     这一趟的成因是"用户停的"，不是"跑坏了"（两者在回归通知里的说法完全不同）。 */
  const status = aborted ? 'interrupted' : (fatal ? 'error' : (lastText.trim() ? 'done' : 'error'))
  Object.assign(runRec, {
    status,
    endedAt: Date.now(),
    usage: usageRes.usage,
    ...(usageRes.source ? { usageSource: usageRes.source } : {}),
    /* 中断/看门狗 → 明确标"没有终点声明"：让 `judgeRunOutcome` 判 partial，
       半截产出**不会**被当成交付（返工单 §2.4 的"不许假报"在这里落地）。
       ⚠️ 顺序：先写 fatal 的原始错误，再写"用户停止"的结论 —— 中止时的异常文案通常是
          `AbortError` 之类的实现细节，对主 agent 没有任何信息量，覆盖掉才是对的。 */
    ...(fatal ? { error: String((fatal as any)?.message || fatal).slice(0, 500) } : {}),
    ...(aborted ? { finalized: false, stopReason: killedReason ? 'watchdog' : 'user', error: String(killedReason || '用户已停止') } : {}),
    ...(status === 'error' && !fatal && !aborted ? { error: '成员这一轮没有产出正文（既没发正文，也没说话）' } : {}),
  })
  persistBoardRuns(bb)
  broadcastBB(ctx, bb)
  /* 终态必须走**运行中同一条通道**（pushRunSnapshot），否则卡片停在 running。 */
  try {
    const cid = String(callId || '')
    if (cid && ctx.pushRunSnapshot) ctx.pushRunSnapshot(cid, [runRec])
  } catch (e) {
    console.error('[L5] 终态帧推送失败（卡片会停在执行中）runId=' + String(runId).slice(0, 8) + '：' + String((e as Error)?.message || e))
  }

  /* ⑦ 步骤收尾：方案 A —— 正文就是交付。
     空产出的情况**故意不写 step.result**：`runStepTask` 的判决口径是"有产出才算完成"，
     这里塞一句"(没有产出)"会被它读成"有产出 ⇒ 待审核" = 假报完成（单子 §2.1 那句在这里自相矛盾，按铁律改）。 */
  ctx.setMemberState(String(member.id), (status === 'done' ? 'done' : (aborted ? 'interrupted' : 'error')), { unread: true, runId })
  if (status === 'done') {
    step.status = 'review'
    step.result = truncate(lastText.trim(), 900)
    step.updatedAt = Date.now()
  } else if (aborted || fatal) {
    /* ★p1b（病根 B）：**中断不丢成果**（已批准方案 B）。
       病状（实测导出 24 个 run 的黑板 + backups）：g2/h1/k1/k2/n1 全是 segments=0 / tools=0 / text=0 字，
       而日志显示它们跑了十几次 fs_read / run_command —— 干了活，成果一个字没记。
       真因（本轮实证排除两个疑点后确定）：
         · 疑点①"agent.state.messages 是空的" —— **排除**：成员会话实测 2054/3221/143 条消息。
         · 疑点②"subscribe 收不到事件" —— **排除**：pi 的 processEvents 末尾（agent.js:432-434）
           会 `for (const listener of this.listeners) await listener(event, signal)`，广播给所有 listener。
         · 真因：`snapshotRunProgress` **只定义在 runSubAgent、且只被它调用**（3 处），
           runMemberTurn 区间内**零调用** —— 而 runMemberTurn 才是默认派发路径
           （memberViaSessionEnabled() 默认 true）⇒ 过程数据从没被写过，不是"没调 finish"。
       修法：收尾时从**成员会话的真实消息**（slice = 本轮切片）重建，复用同一个 buildRunSegments
       （与 runSubAgent 的过程快照同源，不另造一套解析）。
       落 step.result 的判据（任务单钉的）：正文 ≥200 字，或 工具 ≥1 次且正文 ≥50 字 —— 有实质产出才算"成果"，
       否则不写（避免把"啥也没干"包装成有产出 = 假报）。
       ⚠️ 开头必须标明来源，且 **step.status 保持 failed**：成果被救回来了，但这一趟的**成因**
         仍是中断/异常，不能因为救回内容就改成 review/done（那是谎报成功）。 */
    const salvaged = String(runRec.text || '').trim()
    const toolCount = Array.isArray(runRec.tools) ? runRec.tools.length : 0
    const substantial = salvaged.length >= 200 || (toolCount >= 1 && salvaged.length >= 50)
    step.status = 'failed'
    if (substantial) {
      step.result = `【未调 finish:true，以下是从成员正文恢复的产出】\n` + truncate(salvaged, 900)
        + (toolCount ? `\n（期间执行工具 ${toolCount} 次，完整轨迹见黑板 runs）` : '')
    }
    step.updatedAt = Date.now()
  } else {
    step.status = 'failed'
    step.updatedAt = Date.now()
  }
  saveBlackboard(bb)

  /* ⑧ 真失败的两种收尾：
     · `fatal`（runPromptCore 抛错：上下文超窗 / 会话被删 / 模型切换失败…）⇒ **原样抛**，
       由 `runStepTask` 的 catch 写进 step.result 与回归通知（照实说，不换成人话糊过去）；
     · 中断/无产出 ⇒ 不抛：让 `runStepTask` 的判决口径（partial / no_output）给出统一说明。 */
  /* 中止这条路**不抛**：让 `runStepTask` 的判决口径（partial）写统一说明，
     而不是把一句 "aborted" 当执行异常甩给主 agent。 */
  if (fatal && !aborted) {
    ctx.log('error', 'tool', `[团队] 成员 ${mName} 执行步骤 ${step.id} 异常：${String((fatal as any)?.message || fatal).slice(0, 200)}`)
    throw fatal
  }
}

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

/** 单步骤派发（同步阻塞：内部 await 子 agent 跑完） */
/** ★1032-C0：`callId` = 本批派发的 toolCallId，原样往下传给 runSubAgent 记进 runRec
 *  （读侧按它归属，替代跨批复用的 stepId）。 */
/** ★g1：**换段交接（handoff）的唯一拼装口** —— 纯函数，只引用黑板原文与主 agent 的提示，不编造。
 *
 *  三部分（顺序固定，都是事实）：
 *   ① 主 agent 的 `handoffHint`（有就带，原文照录）；
 *   ② 黑板里**该成员最近 2~3 条已 done 步骤**的 id + result 摘要（每条 ≤300 字，直接从 bb.steps 取）；
 *   ③ 一句固定收尾（说明旧段已归档、本轮以任务单为准）。
 *
 *  ⚠️ **禁止**在这里"再总结一遍"（不调模型、不复述成"你之前大概做了…"）：
 *     黑板里的 result 就是成员自己交的产出原文，引用它就是引用事实；
 *     再压一遍等于引入第二个真相，而且压缩正是这次要摆脱的东西。
 *  ⚠️ 黑板里一条该成员的 done 步骤都没有（第一次派）⇒ 如实写"这是你在本团队的第一批任务"，
 *     不假装有历史（这是事实陈述，不是编造）。
 *  ⚠️ 排除**本步骤自身**：它这一刻还没跑，不可能有产出。 */
export function buildFreshSessionHandoff(p: {
  handoffHint?: string
  steps: BlackboardStep[]
  memberId: string
  /** 本步骤 id（从"最近 done"里排除，避免把上一轮的旧 result 当交接） */
  currentStepId?: string
  memberName: string
}): string {
  const hint = String(p.handoffHint || '').trim()
  const parts: string[] = []
  if (hint) parts.push('## 指挥官的交接要点', hint, '')

  const done = (Array.isArray(p.steps) ? p.steps : [])
    .filter(s => String(s?.owner || '') === String(p.memberId || '')
      && String(s?.status || '') === 'done'
      && String(s?.id || '') !== String(p.currentStepId || '')
      && String(s?.result || '').trim())
    /* 取**最近** 3 条：黑板不保证顺序，按 updatedAt 排（它是每次改动都会 bump 的事实字段）；
       缺失 updatedAt 的当 0（排最后）——不按 id 猜顺序（那是命名规律，不可靠）。 */
    .sort((a, b) => Number((b as any).updatedAt || 0) - Number((a as any).updatedAt || 0))
    .slice(0, 3)

  if (done.length) {
    parts.push(`## 你在本团队已完成的步骤（黑板原文摘要，最近 ${done.length} 条）`)
    for (const s of done) parts.push(`- ${s.id}「${String(s.text || '').trim() || '(无标题)'}」：${truncate(String(s.result || ''), 300)}`)
    parts.push('')
  } else {
    /* 事实陈述：不编"你之前做过"。第一次派活就是这样。 */
    parts.push('## 你在本团队已完成的步骤', '（黑板里还没有你已 done 的步骤 —— 这是你在本团队的第一批任务）', '')
  }

  parts.push('---', '上段对话已归档（能查不能继续）。本轮从新窗口开始，**以本次任务单为准**；上面只是背景，不是命令。')
  return parts.join('\n')
}

async function runStepTask(ctx: TeamCtx, bb: Blackboard, t: any, callId: string): Promise<any> {
  const step = bb.steps.find(s => s.id === String(t.stepId || ''))!
  const member = ctx.team.members.find(m => m.id === String(t.memberId || ''))!
  const mName = memberName(ctx.team, member.id)

  // 打回上限：累计 3 次派发后拒绝（打回 ≤2）
  if (step.attempts >= 3) {
    return {
      stepId: step.id, memberId: member.id, memberName: mName, blocked: true,
      reason: `步骤 ${step.id} 已派发 ${step.attempts} 次仍未达标（打回上限 2 次）——停止循环，把各次产出对比呈现给用户请求定夺`,
    }
  }

  const runId = crypto.randomUUID()
  step.attempts += 1
  step.runId = runId
  step.status = 'running'
  step.updatedAt = Date.now()
  saveBlackboard(bb)
  ctx.syncPlan(planItems(ctx, bb))
  broadcastBB(ctx, bb)
  ctx.log('info', 'session', `[团队] 派发 ${step.id} → ${mName}（第 ${step.attempts} 次）`)

  const started = Date.now()
  /* ★g1：**换段必须发生在"往成员会话发消息之前"**（这是本单的核心顺序约束）。
     为什么放在这里而不是 team_dispatch 的 execute 里：
       `lanePush` 是**异步排队**的 —— 派发那一刻这项还没跑，可能几分钟后才轮到。
       若在派发时就换段：① 排队期间用户/成员在旧段里做的事全归到"已归档"的那段，看着像凭空消失；
       ② 同一成员排队两项都带 freshSession 时，两次换段谁先谁后就乱了。
       放在 runStepTask 开头 = **开跑的那一刻**换，与"这一项要开跑"是同一个原子事实。
     顺序不能反：`runMemberTurn` → `ctx.ensureMemberSession` 拿的是**当前未归档段**，
     先换段它自然拿到新段；后换段就是"消息发进了旧段、然后旧段被归档"。
     ⚠️ 失败必须显式抛（由 lanePump 捕获 → 这一项结算为 failed 并回回归通知），
        **绝不静默降级成旧段** —— 本该新段却发到旧段 = 主 agent 以为清干净了其实没有。 */
  if ((t as any)?.freshSession === true) {
    /* ⚠️ 换段只对"成员持久会话"这条路径有意义：`runSubAgent` 用的是**一次性私有 agent**
       （跑完即焚、没有段的概念），给它换段是空操作。此时必须**显式拒绝**，
       不能"忽略掉继续跑" —— 主 agent 会以为上下文已清空，其实它是在一个全新 agent 上跑
       （这一趟确实是干净的，但"换段"这个承诺没有兑现：旧段没归档、段号没 +1、面板上看不到）。
       如实说清，让人去关 `NIS_MEMBER_VIA_SESSION=0` 或者干脆别用这个参数。 */
    if (!memberViaSessionEnabled()) {
      throw new Error('当前后端跑在 `NIS_MEMBER_VIA_SESSION=0` 的旧派发路径上（每次派活都是全新私有 agent），`freshSession` 没有可换的段——本项未开跑。请去掉 freshSession 重派，或把开关切回默认的成员会话路径')
    }
    try {
      if (typeof ctx.newMemberSession !== 'function') {
        throw new Error('后端没有提供 newMemberSession 能力（接线缺失，不是"成员不存在"）')
      }
      const handoff = buildFreshSessionHandoff({
        handoffHint: String((t as any)?.handoffHint || ''),
        steps: Array.isArray(bb.steps) ? bb.steps : [],
        memberId: String(member.id),
        currentStepId: step.id,
        memberName: mName,
      })
      const r = ctx.newMemberSession(String(member.id), handoff)
      ctx.log('info', 'session', `[团队] ${mName} 换段 → 第 ${r.seq} 段（归档 ${r.archived} 段，交接 ${handoff.length} 字），随后派 ${step.id}`)
      /* 换段是一次真实的会话结构变更 ⇒ 立刻广播一次黑板，让成员面板的"当前段/段用量"跟上。 */
      broadcastBB(ctx, bb)
    } catch (e: any) {
      /* 换段失败 = 这一项**根本没开跑**：步骤必须落到终态，否则它会永远显示 running
         （`lanePump` 只把结果结算回主 agent，不会替我们改 step.status）。
         标 failed 而不是 interrupted：它不是"跑到一半被中断"，是"压根没开始"。 */
      step.status = 'failed'
      step.updatedAt = Date.now()
      try { saveBlackboard(bb) } catch { /* 落盘失败不影响下面的抛出 */ }
      ctx.syncPlan(planItems(ctx, bb))
      broadcastBB(ctx, bb)
      ctx.setMemberState(String(member.id), 'error', { unread: true })
      ctx.log('error', 'tool', `[团队] ${mName} 换段失败（步骤 ${step.id} 未开跑）：${String(e?.message || e)}`)
      throw new Error(`换段失败，本项未开跑：${String(e?.message || e).slice(0, 300)}`)
    }
  }
  try {
    /* ★L5（心脏手术）：**派活 = 往成员会话发一条消息**（`runMemberTurn`）。
       旧的私有 Agent 路径（`runSubAgent`）一行没删 —— `NIS_MEMBER_VIA_SESSION=0` 立刻切回。
       分身（cloneRuntime）只走 `runSubAgent`，与本开关无关、不受影响。 */
    if (memberViaSessionEnabled()) {
      await runMemberTurn(ctx, bb, step, member, runId, String(t.task || ''), String(t.acceptance || ''), callId)
    } else {
      await runSubAgent(ctx, bb, step, member, runId, String(t.task || ''), String(t.acceptance || ''), callId)
    }
  } catch (e: any) {
    step.status = 'failed'
    step.updatedAt = Date.now()
    saveBlackboard(bb)
    ctx.syncPlan(planItems(ctx, bb))
    broadcastBB(ctx, bb)   /* sp2-B3：步骤转 review/failed 时原来**不广播**，前端黑板停在 running（实测 16.7s 空档） */
    /* sp2-B5：runStepTask 异常兜底也写终态（否则 memberStates 留 running） */
    ctx.setMemberState(String(member.id), 'error', { unread: true })
    ctx.log('error', 'tool', `[团队] 成员 ${mName} 执行步骤 ${step.id} 异常：${e?.message || e}`)
    return { stepId: step.id, memberId: member.id, memberName: mName, status: 'failed', attempts: step.attempts, result: `(执行异常：${e?.message || e})` }
  }
  /* ★1032-TM（P96）：**重试耗尽 = 这一步失败**，不是"待审核"。
     实测（2026-11-03，agnes 429，重试上限临时降到 1）：日志打了「重试 1 次仍失败，放弃本轮」，
     可这一步却被记成「完成步骤 s24，待审核」，`run.status` 也是 done —— 失败被当成成功，
     主 agent 还以为拿到了产物去审核（正是老大最恨的那种"把失败说成成功"）。
     判据读 `runRec.llmFailed`（`onStreamNote('failed')` 记下的**事实**），不猜文本、不看有没有产物：
     跑了一半的内容不能当交付。 */
  {
    const _rec: any = (Array.isArray((bb as any)?.runs) ? (bb as any).runs : [])
      .find((r: any) => String(r?.runId || '') === String(runId))
    /* ★f1b（P0-3）：**这一步的成败与 run 终态用同一个函数判**（judgeRunOutcome）——「没报错 且 有产出」。
       原来只看 llmFailed：零产出的 run（收尾时 run.status 已被判成 error）在这里仍被记成"待审核"，
       主 agent 审核通过后拿到的是空产出（另一种"谎报完成"）。
       产出证据 = bb_write 落的 step.result；退化取 run.text（= 收尾时的 finalTextOut）。 */
    /* ★by1（乙案）：多传 `finalized` —— 没走 finish:true 又被中断/掐断的 run 判 'partial'，
       "半途汇报被当完工"从数据面被堵住（step.result 现在只有终态汇报能写，本身就是干净的）。 */
    const _v = judgeRunOutcome({
      llmFailed: _rec?.llmFailed?.reason,
      runStatus: String(_rec?.status || ''),
      output: String(step.result || _rec?.text || ''),
      finalized: (_rec as any)?.finalized,
    })
    if (!_v.ok) {
      step.status = 'failed'
      step.updatedAt = Date.now()
      /* ★by1：半截产出**不丢**（原来直接覆盖成一句说明，用户看不到成员做到哪了），但明确标成不可交付。 */
      const _partialOut = String(step.result || _rec?.text || '').trim()
      step.result = (`本步没有可交付的产出，未进入待审核：${_v.detail}` + (String(_v.reason) === 'partial' && _partialOut ? `\n\n—— 半截产出（不可当交付）：${_partialOut.slice(0, 600)}` : '')).slice(0, 900)
      saveBlackboard(bb)
      ctx.syncPlan(planItems(ctx, bb))
      broadcastBB(ctx, bb)   /* sp2-B3：步骤转 review/failed 时原来**不广播**，前端黑板停在 running（实测 16.7s 空档） */
      ctx.log('error', 'session', `[团队] 成员 ${mName} 步骤 ${step.id} 失败：${String(_v.reason)}（${String(_v.detail).slice(0, 120)}）`)
      return {
        stepId: step.id, memberId: member.id, memberName: mName, status: 'failed',
        attempts: step.attempts, result: step.result, artifacts: [],
      }
    }
  }
  step.status = 'review'
  /* ★by1（乙案）：**成员没走 finish:true、但 run 自然结束**（模型忘了传 finish）⇒ 这一步的交付产出
     取它**自己的终态正文**（run.text，与收尾写进 run 的 finalTextOut 同源，不新增任何声明、不编内容）。
     不这么做的后果：step.result 会是空的 ⇒ 主 agent 看到"待审核 + 零产出"，把已经做完的活重派一遍。
     注意只取**终态正文**，绝不拿 reportState.interim（中途汇报）来充数 —— interim 只活在 run 上（run.interim）。 */
  if (!String(step.result || '').trim()) {
    const _recBody: any = (Array.isArray((bb as any)?.runs) ? (bb as any).runs : [])
      .find((r: any) => String(r?.runId || '') === String(runId))
    const _body = String(_recBody?.text || '').trim()
    /* 只在**自然结束**的 run 上取（done）；被中断/掐断的 run 正文是半截的，不能当交付。 */
    if (_body && String(_recBody?.status || '') === 'done') step.result = truncate(_body, 2000)
  }
  /* ★t1x：**执行路径亲手落证据**。这三行是审核闸门唯一可信的来源之一（bb_goal/bb_write 都伪造不出来）：
     补建的步骤、重启后 run 记录被自愈/被裁掉的步骤，都能靠它证明"真的派下去跑过"。 */
  ;(step as any).executedAt = Date.now()
  step.updatedAt = Date.now()
  saveBlackboard(bb)
  ctx.syncPlan(planItems(ctx, bb))
  broadcastBB(ctx, bb)   /* sp2-B3：步骤转 review/failed 时原来**不广播**，前端黑板停在 running（实测 16.7s 空档） */
  ctx.log('info', 'session', `[团队] 成员 ${mName} 完成步骤 ${step.id}，待审核（${((Date.now() - started) / 1000).toFixed(1)}s）`)
  return {
    stepId: step.id, memberId: member.id, memberName: mName, status: 'review',
    attempts: step.attempts, result: step.result || '', artifacts: step.artifacts || [],
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
type LaneItem = { task: any; callId: string }
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

function lanePush(ctx: TeamCtx, callId: string, task: any): void {
  const key = laneKey(ctx.sessionId, String(task?.memberId || ''))
  const lane = memberLanes.get(key) || { running: false, queue: [] }
  memberLanes.set(key, lane)
  lane.queue.push({ task, callId })
  if (!lane.running) void lanePump(ctx, key)
}

/** 车道泵：串行跑队首，跑完在**同一个出口**取下一件。异常也必须把这一件结算掉（否则这批永远不通知）。 */
async function lanePump(ctx: TeamCtx, key: string): Promise<void> {
  const lane = memberLanes.get(key)
  if (!lane || lane.running) return
  lane.running = true
  try {
    while (lane.queue.length > 0) {
      const item = lane.queue.shift()!
      const mid = String(item?.task?.memberId || '')
      const stepId = String(item?.task?.stepId || '?')
      /* 每件活都**重新读一次黑板**：派活/排队可能横跨几分钟，拿调用处的旧副本写盘会把别人的成果整板覆盖
         （0929 P1 那个病的同款入口）。 */
      const bb = loadBlackboard(ctx.sessionId)
      if (!bb) {
        /* 黑板被清空 = 这件活没有落点。如实结算为失败，不假装跑过。 */
        settleCall(ctx, item.callId, { stepId, memberId: mid, memberName: memberName(ctx.team, mid), status: 'failed', result: '(黑板已被清空：这件活没有落点，未执行)' })
        continue
      }
      /* ★1104-I：排队期间计划可能被 bb_goal 全量重写（排队的步骤会随之作废）。
         这是**真实状态**，必须如实结算，不许让 runStepTask 在 undefined 上崩成 TypeError。 */
      const bbStep = (bb.steps || []).find(s => s.id === stepId)
      /* ★w1：**已作废的步骤不许再跑**。`supersededBy` 非空 = 它已被后续步骤取代
         （team_dispatch 的 supersedes / bb_goal 重写计划 / 打回自动重派前的显式取代都会写它）。
         原来这里只判"步骤不存在 / owner 变了"，漏了这条 ⇒ 排队期间被取代的步骤照样会开跑：
         白烧一轮 token，还可能把新步骤的产出覆盖掉（同一个 owner、同一处文件）。
         判据放在这里而不是派发时：`lanePush` 是异步的，排队可能横跨几分钟，
         **开跑这一刻**的计划才是权威（这也是本函数开头"每件活都重新读一次黑板"的同一个理由）。 */
      if (bbStep && String((bbStep as any).supersededBy || '').trim()) {
        settleCall(ctx, item.callId, {
          stepId, memberId: mid, memberName: memberName(ctx.team, mid), status: 'failed',
          result: `(已被取代：步骤 ${stepId} 的 supersededBy=${String((bbStep as any).supersededBy)}，这项活不再执行)`,
        })
        ctx.log('info', 'session', `[团队] 车道跳过已作废步骤 ${stepId}（被 ${String((bbStep as any).supersededBy)} 取代，未执行）`)
        continue
      }
      if (!bbStep || bbStep.owner !== mid) {
        settleCall(ctx, item.callId, {
          stepId, memberId: mid, memberName: memberName(ctx.team, mid), status: 'failed',
          result: !bbStep
            ? `(计划已被重写：步骤 ${stepId} 不在第 ${Number(bb.planRev || 0)} 版计划里，这项活没有执行)`
            : `(计划已被重写：步骤 ${stepId} 的 owner 已改为 ${bbStep.owner}，这项活没有执行)`,
        })
        continue
      }
      ctx.setMemberState(mid, 'running')
      ctx.log('info', 'session', `[团队] 车道开跑 步骤 ${stepId} → ${memberName(ctx.team, mid)}（本车道还剩 ${lane.queue.length} 项排队）`)
      let r: any
      try {
        const pending = runStepTask(ctx, bb, item.task, item.callId)
        /* **派出即见卡**：`runStepTask` 会同步跑到 `runSubAgent` 内的 `bb.runs.push` 才挂起 ⇒
           此刻 `bb.runs` 里已经有本 run，按 callId 全量登记一次（与原来分批登记是同一份数据、同一时刻）。 */
        try {
          const started = (Array.isArray(bb.runs) ? bb.runs : []).filter((x: any) => String(x?.callId || '') === item.callId)
          if (started.length) ctx.registerSubRuns?.(item.callId, started)
        } catch { /* 登记失败不拦派发 */ }
        r = await pending
      } catch (e: any) {
        r = { stepId, memberId: mid, memberName: memberName(ctx.team, mid), status: 'failed', result: `(执行异常：${String(e?.message || e).slice(0, 300)})` }
        /* sp2-B5：异常路径原来**不写终态** ⇒ memberStates 永久留 running（面板永远显示在跑） */
        ctx.setMemberState(mid, 'error', { unread: true })
      }
      settleCall(ctx, item.callId, r)
    }
  } finally {
    lane.running = false
    /* 队列已空 ⇒ 摘掉车道（不留空条目）。 */
    if (!lane.queue.length && memberLanes.get(key) === lane) memberLanes.delete(key)
  }
}

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
      { memberIds: call.results.map((x: any) => String(x?.memberId || '')).filter(Boolean) },
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

export function buildTeamTools(ctx: TeamCtx): AgentTool<any>[] {
  return [
    // ── team_dispatch：派发成员（数组参数 + deps 硬校验 + **每成员一条串行车道**） ──
    {
      name: 'team_dispatch',
      label: '派发任务',
      description: '给**团队成员**（常驻同事，每人有独立会话窗口）派活 —— 不是派分身（临时实例用 spawn_clone）。派发异步：立刻返回"已派出"，成员跑完以「团队回归」通知唤回。参数 tasks 数组一次可派多个=**不同成员并行**；**同一个成员同一时刻只干一件事**——派给正在忙的成员会排队，等它手上那件跑完自动接着做，并随那批一起回归（不会并行、不会串任务）。**新活直接派**：stepId 可省；给了但计划里没有会自动补建一步（计划卡同步）——只有"要依赖前置 / 要改派已存在步骤的 owner"时才需要先 bb_goal。步骤已 done / 正在跑 / 在队列里 / 依赖未 done 会被拒（逐项拒，好项照派）。打回用 bb_write(status=rejected) 后重新派发（同一任务最多 3 次）。派活难度要与成员档位匹配（档位/忙闲见 team_info；优先派给空闲成员；**派完立刻结束本轮**——不要用 sub_read / list_dir 去盯进度、也不要等结果，成员跑完会自动以「团队回归」通知回到本会话，那时再审核）。**给成员换干净上下文**：判定它上一阶段已收尾、或它当前段「已压缩 ≥2 次 / 占用 ≥80%」（team_info 每行的「当前段：…」）、或明显换话题时，给这一项带 `freshSession:true`；它开跑前会先归档旧段、开新段，新段只有任务单+`handoffHint`，看不到旧对话。**别在它跑任务时换**（会断成两半），同一批也只能给它换一次。',
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          stepId: Type.Optional(Type.String({ description: '步骤 id（不传、或计划里还没有 ⇒ 自动补建一步；新活不必先 bb_goal）' })),
          memberId: Type.String({ description: '成员 id（team_info 查清单）' }),
          task: Type.String({ description: '任务单：目标+边界+注意事项（精准打包；重做时必须带上打回 feedback 的解决要求）' }),
          acceptance: Type.Optional(Type.String({ description: '本步骤验收标准（逐条可检验）' })),
          /** ★hint1：重派时把被取代的旧 stepId 列出来（事实留痕，不猜 id 规律）。 */
          supersedes: Type.Optional(Type.Array(Type.String(), { description: '本次重派取代了哪些旧 stepId（如 ["dk11"]）。旧步骤会被写上 supersededBy=<本步骤 id>、status 不动，「下一步建议」不再把它当待办。只允许计划里真实存在、且不在 running 的旧步骤（不猜、不绕过校验）。' })),
          /* ★g1（设计定案）：**换段由主 agent 决定，与派活原子合一**。
             老板原话："主 agent 派任务时写得详细，其实不太需要怕没有上一条任务的上下文。判定该部分任务
             做完了，下次再给这个成员派任务就可以新窗口派；或者压缩两次感觉成员做事降智了，可以重新开…
             或者说直接开完新对话再发新任务。"
             为什么不做"自动换段"（已否决的旧方案）：真因不是"信息不够"，而是压缩是 **UPDATE 合并**
             （`CTX_SUMMARY_UPDATE`：旧摘要全部保留）⇒ 上一个任务的 Critical Context（路径/报错/参数）
             会一直留在摘要里、跟着每一跳发出去，当前任务用不上 → 干扰判断（老板称"降智"）。
             换段能**有目的地清掉**这些残留，压缩不能。
             ⇒ 所以只在主 agent 明确要求时换，且与**这一项**派活同一次调用原子完成（执行点在 runStepTask）。 */
          freshSession: Type.Optional(Type.Boolean({
            description: '给这个成员**开新段对话**再派这一项（旧段归档：能查不能继续）。用于：该成员上一个阶段已收尾、或它那段已压缩≥2次、或明显换话题。**必须配好任务单** —— 新段只有任务单+handoffHint，看不到旧的对话。',
          })),
          handoffHint: Type.Optional(Type.String({
            description: '写进新段开头的交接要点（你掌握的进度/边界/踩过的坑）。不传就自动带上黑板里该成员已 done 步骤的产出摘要。**只写事实**，不要写"你大概做过…"这类推测。',
          })),
        }), { description: '要派发的任务（数组，一次可多个=并行）' }),
      }),
      async execute(_callId, params: any) {
        const tasks = Array.isArray(params?.tasks) ? params.tasks : []
        if (tasks.length === 0) throw new Error('tasks 不能为空')
        if (tasks.length > 12) throw new Error('单次最多派发 12 项——更多请分批（留出审核间隙）')
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb || !bb.goal) throw new Error('黑板为空：先用 bb_goal 写入目标与计划，再派发。若属简单修改（单文件小改），可直接用 fs_write 完成，无需派发')
        /* 结构/owner/依赖 硬校验 —— ★1104-I 改为**逐项判定**：
           旧实现是整批原子拒绝（任一不过 ⇒ 零副作用）。实测 be4a425f 会话 73 次派发里 16 次失败，
           其中 T16 的 s5 完全合法，却因为同一批的 s6 依赖未满足被一起拒掉 ⇒ 一次坏项毁全批，
           用户观感就是"第一次派活必失败"。现在：合法的照派，不合法的逐条列名回报（不静默、不假装派出）。 */
        const _seenSteps = new Set<string>()
        const _ok: any[] = []
        const _rejects: string[] = []
        /* ★1104-K（**派发即计划**）：步骤不在当前计划里 ⇒ 就地补建，不再要求"先 bb_goal 再派"。
           病因（老大 1104-K 实锤）：主 agent 要派"手柄第四次修"，直接 team_dispatch(stepId=g2)，
           而板上只有上一轮的 g1 ⇒ 整次被拒 → 它再 bb_goal → 再派才成。
           它不是没计划，而是**计划的载体在另一个工具里**：模型得在两次调用之间记住一个外键，
           忘了就得付一次失败 + 一次重写。现在 stepId 可省；给了但板上没有 ⇒ 用任务单补建一步
           （owner = 派给谁、text = 任务单首行），计划卡同步刷新。
           ⚠️ **已存在**的步骤仍走全套硬校验（owner / 状态 / 依赖）—— 补建只解决"新活没有座位"，
              不放松"改派要写进计划""不能重复派""前置没 done 不能开工"。 */
        const _created: string[] = []
        /* ★nb1：本次真正派出去的条数 —— 用来决定"要不要为了留痕而落盘"（见下方 saveBlackboard）。 */
        let _dispatched = 0
        for (const t of tasks) {
          try {
            const member = ctx.team.members.find(m => m.id === String(t?.memberId || ''))
            if (!member) throw new Error(`成员不存在：${t?.memberId}。可用成员：${ctx.team.members.map(m => `${m.id}(${memberName(ctx.team, m.id)})`).join('、')}`)
            const _wantId = String(t?.stepId || '').trim()
            let step = _wantId ? bb.steps.find(s => s.id === _wantId) : undefined
            if (!step) {
              const id = _wantId || nextDispatchStepId(bb)
              step = {
                id,
                text: truncate(String(t?.task || '').trim().split('\n')[0] || `派发步骤 ${id}`, 60),
                deps: [],
                owner: member.id,
                status: 'pending',
                attempts: 0,
                updatedAt: Date.now(),
              }
              bb.steps.push(step)
              _created.push(id)
            }
            if (_seenSteps.has(step.id)) throw new Error(`同一次派发里重复提交了步骤 ${step.id}（会派两遍）——请去掉重复项`)
            if (step.owner !== member.id) throw new Error(`步骤 ${step.id}（「${truncate(step.text, 30)}」）的 owner 是 ${step.owner}(${memberName(ctx.team, step.owner)})，不能派给 ${member.id}——要改派就在 bb_goal 里重写该步骤的 owner，再派。owner 必须与成员职责匹配`)
            if (step.status === 'done') throw new Error(`步骤 ${step.id} 已 done，无需重复派发。若属简单修改想直接调整，可用 fs_write 完成，无需派发`)
            /* ★1104-H：**重复派发是硬错误**（同一个成员同一件事只会有一份，第二份会白跑并覆盖产出）。
               正在跑的判据是黑板事实（`step.status==='running'`，死 run 已在 loadBlackboard 里自愈成
               interrupted）；排队的判据是车道里已有同一 stepId。 */
            if (step.status === 'running') throw new Error(`步骤 ${step.id} 正在执行中（${memberName(ctx.team, member.id)}），不要重复派发——等「团队回归」通知后审核`)
            if (laneHasStep(ctx.sessionId, member.id, step.id)) throw new Error(`步骤 ${step.id} 已在 ${memberName(ctx.team, member.id)} 的队列里排队，不要重复派发——「团队回归」通知到达后再审核`)
            /* ★g1：**换段的硬前提**（换段发生在"开跑那一刻"，所以这里必须把会导致语义模糊的情况提前挡住）：
               ① 换了段，这一项就是新段的**第一条活** —— 任务单必须自带上下文（它看不到旧对话）；
               ② 该成员手上/队列里还有活时不能换段：那一刻它正在旧段里跑，换段会把"正在跑的段"
                  归档掉，语义就乱了（旧段 archiving 与在跑的 agent 打架）。
                  正确做法：等它这批跑完（「团队回归」通知到达）再派带 freshSession 的新活。
               ③ 同一批里给同一成员两项都标 freshSession ⇒ 会连开两段，后一段把前一段归档 ⇒ 前一项白跑。
                  （前面 `_seenSteps` 已挡"同一步骤重复"，这里挡"同一成员重复换段"。）
               ⚠️ 三条都是**拒绝**，不是降级：本该新段却发到旧段 = 主 agent 以为清干净了其实没有。 */
            const _fresh = (t as any)?.freshSession === true
            if (_fresh) {
              const _hint = String((t as any)?.handoffHint || '').trim()
              if (!String((t as any)?.task || '').trim()) throw new Error(`步骤 ${step.id} 标了 freshSession，但没有任务单 —— 新段看不到旧的对话，任务单必须自带目标/边界/上下文`)
              if (_hint.length > 4000) throw new Error(`步骤 ${step.id} 的 handoffHint 太长（${_hint.length} 字）—— 它只是交接要点，请精简到 4000 字以内（细节写进任务单或落成文件让它自己读）`)
              if (memberRunLive(ctx.sessionId, member.id, bb)) {
                throw new Error(`${memberName(ctx.team, member.id)} 手上还有活没跑完，此刻不能换段（换段要等它这批收尾，否则正在跑的旧段会被归档掉）——等「团队回归」通知到达后再派这一项，届时带上 freshSession`)
              }
              const _freshAlready = _ok.some((x: any) => String(x?.memberId || '') === member.id && (x as any)?.freshSession === true)
              if (_freshAlready) throw new Error(`同一批里 ${memberName(ctx.team, member.id)} 被标了两次 freshSession（步骤 ${step.id}）——一次派发只能给它开一段新对话；把要在这个新段里做的事合并成一项，或分两批派`)
            }
            for (const dep of step.deps) {
              const d = bb.steps.find(s => s.id === dep)
              if (!d) throw new Error(`步骤 ${step.id} 依赖的 ${dep} 不在计划里`)
              /* ★y1（前后端口径对齐）：**依赖被取代时，要跟到最终接手者再判**，而不是直接放行。
                 病（前端 w2 记下来的差异）：原来这里只判 `d.status !== 'done'`，
                 所以 deps 里躺着一条被取代的僵尸（比如 p1 被 p1d 取代）时，
                 后端硬拦「依赖硬校验失败：p1 状态是 rejected」，而前端 blockingDepsOf 认为"被取代=不阻塞"
                 ⇒ 前端显示可派、一点派发就报错，两边对外表现自相矛盾。

                 **为什么选"跟链"而不是"被取代就放行"**（语义 A vs B 的取舍）：
                   后端是**开工硬闸门**，放行了就真烧钱、真改文件。旧步骤作废 ≠ 那件活已经做完 ——
                   `supersededBy` 只说明"这件事改由别人做了"，不说明"做完了"。
                   如果直接放行：C 依赖 A、A 被 B 取代、而 B 还没做完 ⇒ C 会基于**未完成的前置**开工，
                   写出来的东西要返工。前端可以乐观（它只是展示"能不能点"），后端不行。
                 ⇒ 所以跟链：C 依赖 A，A 被 B 取代 ⇒ 判 B 是否 done（B 又被取代就继续跟）。

                 **四个必须处理的边界**（下面逐条实现）：
                   a) **环**：A→B→A。防死循环 —— `seen` 集合 + 上限，命中即按"阻塞"处理（宁可拦住不放行）。
                   b) **接手者不存在**：实测黑板里真有这种（g2 → supersededBy='plan-rev'，而 plan-rev 不是步骤）。
                      这不是数据损坏，是"方向级作废"的合法写法（w1 用它表达整条方向被回退）。
                      这种**没法跟到任何可判定的接手者** ⇒ 视为**不阻塞**：
                      既然连接手者都没有，就不存在"没做完的接手者"让后继去等。
                      ⚠️ 与 (a) 的处理相反 —— 环是"有接手者但追不到底"（可疑，拦住），
                         不存在是"压根没有接手者"（无依赖可等，放行）。这个区别是刻意的。
                   c) **链太长**：超过上限按阻塞（同上，可疑就拦住）。
                   d) **中间某环 done 了但最终没 done**：以**链尾**为准（终态接手者干完才算真完成）。
                      中间态 done 不代表后续接手者的工作做完 —— 但那件活确实被后一手接走了。 */
              if (String((d as any).supersededBy || '').trim()) {
                const { final, cycle } = resolveSupersededTail(bb.steps, d)
                if (cycle) throw new Error(`依赖硬校验失败：步骤 ${step.id} 依赖的 ${dep} 的 supersededBy 链成环（${dep} → … → ${final?.id || '?'}），无法判定前置是否完成——请修正计划后再派`)
                if (!final) {
                  /* b) 链尾不存在（如 g2 → 'plan-rev'）= 方向级作废、没有接手者 ⇒ 无依赖可等，放行。
                     留痕：这条依赖实际被"没有接手者的取代"吸收了，排查时需要看见。 */
                  try { ctx.log('info', 'session', `[团队] 步骤 ${step.id} 的依赖 ${dep} 被取代且无接手者（supersededBy=${String((d as any).supersededBy)}）⇒ 视为不阻塞`) } catch { /* ignore */ }
                  continue
                }
                if (final.status !== 'done') {
                  throw new Error(`依赖硬校验失败：步骤 ${step.id} 依赖的 ${dep} 已被 ${final.id} 接手，但 ${final.id} 状态是 ${final.status}（需 done）——等接手的那一步完成，或修正计划`)
                }
                continue
              }
              if (d.status !== 'done') throw new Error(`依赖硬校验失败：步骤 ${step.id} 依赖的 ${dep} 状态是 ${d.status}（需 done）——先等前置完成或修正计划`)
            }
            /* ★hint1（bug2·甲案）：**取代留痕** —— 重派用新 stepId 时，旧步骤由指挥官在任务单里
               显式写 `supersedes:['旧id']`，这里把它标上 supersededBy=<本步骤 id>（status 不动）。
               校验从严：只认计划里真实存在的旧步骤、不许取代自己、正在跑的不许取代（等于自欺）；
               任一不合法 ⇒ 这一项照常被拒（逐项拒，其余项不受影响，绝不静默吞掉）。 */
            const _supIds = (Array.isArray((t as any)?.supersedes) ? (t as any).supersedes : [])
              .map((x: any) => String(x || '').trim()).filter(Boolean)
            for (const _oldId of _supIds) {
              if (_oldId === step.id) throw new Error(`supersedes 不能包含步骤 ${step.id} 自己`)
              const _old = bb.steps.find(s => s.id === _oldId)
              if (!_old) throw new Error(`supersedes 指向的 ${_oldId} 不在计划里（不猜、也不影响同批其它项）`)
              if (_old.status === 'running') throw new Error(`supersedes 指向的 ${_oldId} 正在执行中，不能标为已取代（等它回归或先中断它）`)
            }
            for (const _oldId of _supIds) {
              const _old = bb.steps.find(s => s.id === _oldId) as any
              _old.supersededBy = step.id
              _old.updatedAt = Date.now()   // bump：合并落盘时按 updatedAt 取较新者，确保这标记不被旧副本盖回
            }
            /* 只有**全部校验通过**才占号：前一项被判非法时，同一 stepId 出现在后面的合法项里不算重复。 */
            _seenSteps.add(step.id)
            /* stepId 可能来自自动补建：回填给任务对象，后面的任务单/回执/结算都按真实 id 走。 */
            t.stepId = step.id
            /* ★nb1：**派发即留痕** —— 派出去了就在 step 上打 `dispatchedAt`（唯一能区分"排队中/没派过"的持久证据）。
               ⚠️ 必须落盘才管用：回归通知里的「下一步建议」读的是 settleCall 里 `loadBlackboard` 重读的**盘上**副本，
                  只写内存等于没留痕（这就是老板看到的误报的直接成因）。
               bump updatedAt = 让合并落盘（同代次按 id 取 updatedAt 较新者）认本地这一份。 */
            ;(step as any).dispatchedAt = Date.now()
            step.updatedAt = Date.now()
            _dispatched += 1
            _ok.push(t)
          } catch (e) {
            _rejects.push(String((e as Error)?.message || e))
          }
        }
        if (_ok.length === 0) {
          throw new Error(`本次 ${tasks.length} 项全部被拒（一项都没派出去）：\n- ${_rejects.join('\n- ')}`)
        }
        /* ★1104-K：补建的步骤**必须先落盘再入车道** —— lanePump 每件活都会重读黑板
           （防旧副本整板覆盖），没落盘的话它读不到刚补建的步骤，会把这项判成
           "计划已被重写"直接结算成未执行。 */
        /* ★nb1：`_dispatched > 0` 也要落盘 —— 派发留痕（dispatchedAt）不落盘，「下一步建议」永远判不出"排队中"。 */
        if (_created.length || _dispatched > 0) saveBlackboard(bb)
        /* ★1032（P16，需求）：**并行上限 = 成员数**（一个成员同一时刻只干一件事），
           不再有独立的"并行预算"。派不派、派几个交给主 agent 判断，但**同一成员的多件事一律排队**。 */
        /* 0911 反馈③：同批任务的文件边界重叠预检（warn-only：派发回执与回归通知里都带，不阻断） */
        const overlapWarn = detectDispatchOverlap(_ok.map((t: any) => ({
          text: `${String(t?.task || '')}\n${String(t?.acceptance || '')}`,
          label: `步骤 ${String(t?.stepId || '?')}`,
        })))
        /* ★1104-H（**派活不阻塞**）：execute 立刻回执，整批跑完由 `settleCall` 经 `ctx.notifyDone`
           （= `injectSessionNotice`，与"分身回归"同一条通路）回到主会话。
           派活 = 入车道 → 车道空闲立刻跑、忙就排队（排队状态见的回执与计划卡，不编造"已开工"）。
           ★1104-I：结算只统计**真派出去**的 _ok —— 被拒项不算"本批"，否则回归通知的条数会虚高。 */
        const _cid = String(_callId)
        beginCallSettle(ctx.sessionId, _cid, overlapWarn, _ok)
        let _queued = 0
        for (const t of _ok) {
          const _mid = String((t as any)?.memberId || '')
          /* ★1032-TM（P1）：派活的**任务单**写进成员会话 —— 打开它的 tab 就看到"主 agent 派了什么活"
             （"成员 = 一个对话窗口"的写侧；读侧是前端 `member:` tab）。与"何时开跑"无关，派出即写。
             ★L5：**走成员会话的路径下要跳过这一步** —— 那一轮的任务单是 `runMemberTurn` 通过
             `runPromptCore` 真发出去的一条 user 消息（`# 你的身份（本次派活）…`）。再写一条 `【任务】`
             就是同一个事实两份数据（用户点进去会看到两条"派活"）、而且它的 id 与真正的
             user 消息不同 ⇒ 会干扰"本轮产出从哪儿开始"的定位。旧路径（回滚开关）仍然需要这条留痕。 */
          if (!memberViaSessionEnabled()) {
            try {
              const _acc = String((t as any)?.acceptance || '').trim()
              ctx.appendMemberMessage?.(_mid, 'user',
                `【任务】${String((t as any)?.task || '').trim()}${_acc ? `\n\n【验收标准】${_acc}` : ''}\n\n（步骤 ${String((t as any)?.stepId || '?')}）`,
                { kind: 'dispatch' })
            } catch (e) { console.warn('[1032-TM] 写成员会话失败（任务单）:', String((e as Error)?.message || e)) }
          }
          /* 判"排队"必须在 lanePush **之前**（push 会把车道同步置忙）。 */
          if (memberRunLive(ctx.sessionId, _mid, bb)) _queued += 1
          lanePush(ctx, _cid, t)
        }
        /* 计划卡立刻反映"已派出"；之后的 step 状态变化由后台更新 + 各自推帧驱动。 */
        ctx.syncPlan(planItems(ctx, bb))
        /* ★g1：换段信息必须在**回执**里如实说清（换段发生在开跑那一刻，主 agent 看不到那一刻）。
           为什么重要：换段=清空上下文，是**不可撤销**的动作；主 agent 必须知道哪几项真的被标了换段，
           否则它会以为"顺手换了一下"而漏掉后续该补的背景。
           ⚠️ 只说"将在开跑这一刻换"，不说"已换段" —— 换段还没发生（排队中可能等几分钟），
              这一刻确定的事只有"答应了要换"。真实结果见该 member 的成员会话段号与回归通知。 */
        const _freshList = _ok.filter((x: any) => (x as any)?.freshSession === true)
        const freshNote = _freshList.length
          ? `\n\n换段：${_freshList.map((x: any) => `${String(x?.stepId || '')}→${String(x?.memberId || '')}`).join('、')} 将在**该成员开跑那一刻**换新段（旧段归档：能查不能继续）。新段只有任务单+交接要点，看不到旧对话。`
          : ''
        return {
          content: [{ type: 'text', text: `已派出 ${_ok.length} 项（${_ok.length - _queued} 项立即开工${_queued > 0 ? `，${_queued} 项排在成员当前任务之后（同一成员不并行）` : ''}）：${_ok.map((t: any) => String(t?.stepId || '')).join('、')}。\n` +
            (_created.length ? `（其中 ${_created.join('、')} 是本次新补建进计划的步骤——原计划里没有，已同步到计划卡）\n` : '') +
            '请**就此收轮挂起**：一两句告知用户即可，不要自己接着做、不要重复派发、不要现在就去 bb_write 审核（成员还没跑完）。' +
            '「团队回归」通知到达后再逐项审核（bb_write step done / rejected）。' +
            (_rejects.length ? `\n\n⚠ 另有 ${_rejects.length} 项**没派出去**（其余项照常开工，不用重发这一批）：\n- ${_rejects.join('\n- ')}` : '') +
            (overlapWarn ? `\n\n${overlapWarn}` : '') + freshNote }],
          details: { launched: _ok.map((t: any) => String(t?.stepId || '')), created: _created, queued: _queued, rejected: _rejects, fileOverlapWarn: overlapWarn || undefined, freshSession: _freshList.map((x: any) => String(x?.stepId || '')) || undefined },
        }
      },
    },

    // ── member_tell：给**正在做这一件事**的成员追加补充（插话，不重派） ──
    {
      name: 'member_tell',
      label: '给成员补充',
      description: '给**正在执行某一步**的成员追加补充/修正（插话，不打断、不重派）。用户在你派完活后又补了要求、或你发现任务单漏了关键约束时用它。成员没在跑（空闲/已收工）会直接报错——那种情况该用 team_dispatch 派新的一步，不要用本工具"留个言"。**不要说重复的内容**：只给增量（新约束、新证据、改口径）。',
      parameters: Type.Object({
        memberId: Type.String({ description: '成员 id（team_info 查）' }),
        message: Type.String({ description: '补充内容（增量：新约束/新证据/纠正），不要重复原任务单' }),
        stepId: Type.Optional(Type.String({ description: '针对哪一步（不传 = 它当前正在做的那一步）' })),
      }),
      async execute(_callId, params: any) {
        const mid = String(params?.memberId || '').trim()
        const msg = String(params?.message || '').trim()
        if (!mid) throw new Error('memberId 不能为空')
        if (!msg) throw new Error('message 不能为空——补充要么说清新增了什么约束，要么就别发')
        if (!ctx.team.members.some(m => m.id === mid)) throw new Error(`成员不存在：${mid}。可用：${ctx.team.members.map(m => m.id).join('、')}`)
        const wantStep = String(params?.stepId || '').trim()
        const mName = memberName(ctx.team, mid)

        /* ① 正在跑：走 pi 的 steer（与主会话「插话」同一机制），它在下一跳就能看到。
              找不到活的 agent 就**如实报错**，不假装送达（补充丢了比没发更糟）。 */
        let hit: { agent: Agent; stepId?: string } | null = null
        let runningOther = ''
        const runMap = watchdogs.get(ctx.sessionId)
        if (runMap) {
          for (const [, ent] of runMap) {
            if (String(ent.memberId || '') !== mid) continue
            if (wantStep && String(ent.stepId || '') && String(ent.stepId) !== wantStep) { runningOther = String(ent.stepId); continue }
            hit = { agent: ent.agent, stepId: ent.stepId }
            break
          }
        }
        if (!hit && runningOther) {
          throw new Error(`${mName} 正在做的是步骤 ${runningOther}，不是 ${wantStep}——补充只能针对它手上那件事；要加新活请用 team_dispatch（它会排在后面）`)
        }
        if (hit) {
          hit.agent.steer({
            role: 'user',
            content: [{ type: 'text', text: `【补充（主 agent）】用户在你开工后补了信息，把它当作本步骤的增量约束，不要从头重做：\n${msg}` }],
            timestamp: Date.now(),
          } as any)
          try { ctx.appendMemberMessage?.(mid, 'user', `【补充】${msg}\n\n（步骤 ${hit.stepId || wantStep || '?'}）`, { kind: 'supplement' }) } catch (e) { swallowed(`补充已插给成员但没写进它的窗口（${mid}）——成员看得到、用户回看时看不到这条`, e) }
          return {
            content: [{ type: 'text', text: `补充已插给 ${mName}（步骤 ${hit.stepId || wantStep || '?'}，正在执行）——它会在这一轮里带着这条继续做完，**不要重派**，等「团队回归」通知即可。` }],
            details: { delivered: 'running', memberId: mid, stepId: hit.stepId || wantStep || '' },
          }
        }

        /* ② 还没开工（在自己的车道队列里）：把补充**追加到那件活的作业单**上 ——
              等它开跑时自然会带上；steer 在这里无处可送，不能谎称已送达。 */
        const lane = memberLanes.get(laneKey(ctx.sessionId, mid))
        const queued = lane?.queue.find(q => !wantStep || String(q?.task?.stepId || '') === wantStep)
        if (queued) {
          queued.task = { ...queued.task, task: `${String(queued.task?.task || '')}\n\n【补充（主 agent，用户后来补的）】${msg}` }
          try { ctx.appendMemberMessage?.(mid, 'user', `【补充】${msg}\n\n（步骤 ${String(queued.task?.stepId || '?')}，还没开工，已并入任务单）`, { kind: 'supplement' }) } catch (e) { swallowed(`补充已并入成员任务单但没写进它的窗口（${mid}）`, e) }
          return {
            content: [{ type: 'text', text: `补充已并入 ${mName} 的待办任务单（步骤 ${String(queued.task?.stepId || '?')}，还没开工）——它开跑时会带上这条。**不要重派**。` }],
            details: { delivered: 'queued', memberId: mid, stepId: String(queued.task?.stepId || '') },
          }
        }

        /* ③ 空闲/已收工：没有落点。如实拒绝，并告诉模型正确出口。 */
        throw new Error(`${mName} 现在没有正在执行的任务（空闲或已收工）——补充没有落点。要让它干活就用 team_dispatch 派新的一步；如果只是想让用户知道进展，用一两句话回复即可，不要发空补充。`)
      },
    },

    // ── member_new_session：给成员开新对话（换新窗口 + 交交接） ──
    {
      name: 'member_new_session',
      label: '给成员开新对话',
      description: '给某个成员开一段**新对话**（旧那段自动归档：还能查、不能继续）。这个成员聊得太长、或要换话题时用它：在 handoff 里写清它之前做过什么、当前状态、这次要注意什么，它在新窗口里带着这份交接继续干。handoff 必须写 —— 它是成员唯一的记忆延续。',
      parameters: Type.Object({
        memberId: Type.String({ description: '成员 id（team_info 查）' }),
        handoff: Type.String({ description: '交接：它之前做过什么（A/B/C）、当前进展与结论、这次要注意的边界' }),
      }),
      async execute(_callId, params: any) {
        const mid = String(params?.memberId || '').trim()
        const handoff = String(params?.handoff || '').trim()
        if (!mid) throw new Error('memberId 不能为空')
        if (!handoff) throw new Error('handoff 不能为空 —— 成员换窗口后只剩这份交接，空交接等于让它失忆')
        const r = ctx.newMemberSession?.(mid, handoff)
        if (!r) throw new Error('后端没接入 newMemberSession（能力缺失，不是成员不存在）')
        return {
          content: [{
            type: 'text',
            text: '已给 ' + memberName(ctx.team, mid) + ' 开第 ' + r.seq + ' 段对话（旧段已归档：能查不能继续）。交接已写进新窗口第一条。',
          }],
          details: { ...r, memberId: mid },
        }
      },
    },

    // ── bb_goal：写黑板目标与计划（同步用户计划卡） ──
    {
      name: 'bb_goal',
      label: '写黑板目标',
      description: '开工前写黑板：目标 + 总验收标准 + 计划步骤（每步标 owner 成员与 deps 依赖）。全量替换语义——重写时传完整计划。计划同步显示为用户可见的计划卡',
      parameters: Type.Object({
        goal: Type.String({ description: '本任务的总目标（一句话）' }),
        acceptance: Type.Optional(Type.String({ description: '总验收标准（逐条可检验）' })),
        plan: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: '步骤 id（如 s1；不传自动生成 s1/s2…）' })),
          text: Type.String({ description: '步骤描述（一句话，具体可执行）' }),
          owner: Type.String({ description: '负责成员 id（team_info 查清单）' }),
          deps: Type.Optional(Type.Array(Type.String(), { description: '依赖的前置步骤 id（派发硬校验：未 done 不能开工）' })),
        }), { description: '计划步骤（全量）' }),
      }),
      async execute(_callId, params: any) {
        const goal = String(params?.goal || '').trim()
        if (!goal) throw new Error('goal 不能为空')
        const plan = Array.isArray(params?.plan) ? params.plan : []
        if (plan.length === 0) throw new Error('plan 不能为空——纯咨询任务不需要团队，直接回复即可')
        if (plan.length > 12) throw new Error('计划最多 12 步——拆得更细不如先做起来')
        // ── 单步计划启发校验（拒绝一次 + 申辩通道；通过时零成本，不加系统提示词） ──
        // 背景：弱模型常把"N 个独立页面"整包拆 1 步派 1 人串行做，白白浪费多成员并行。
        // 强模型若确属单步任务，singleton:true 申明即过——不束缚正确决策
        if (plan.length === 1 && !params?.singleton) {
          const only = plan[0]
          const text = `${only?.text || ''} ${goal}`
          const multiOutput = /[1-9一-九两三四五六七八]\s*[个份页张条块]/.test(text) && ctx.team.members.length >= 3
          if (multiOutput) {
            // 拒绝信息按团队实际成员构成动态生成（铁律 32：约束在边界条件下要自洽——
            // 成员不足时"分给不同成员"是谎言，会把弱模型逼出职责错派）
            const presetCount = new Map<string, number>()
            for (const m of ctx.team.members) presetCount.set(m.preset, (presetCount.get(m.preset) || 0) + 1)
            const samePreset = [...presetCount.entries()].find(([, n]) => n > 1)
            const splitAdvice = samePreset
              ? `① 按独立产出物拆成多步，分派给同职责的多个成员（${samePreset[0]} 配了 ${samePreset[1]} 名）并行，deps 留空`
              : `① 多个产出物可合并为一步派给对应职责的成员（**同一成员同一时刻只干一件事**：多步派给同一人会排队依次做，不会并行——想真并行就得有多个成员）；或到团队设置添加同预设成员后再拆分并行`
            throw new Error([
              '单步计划被拒绝（启发式预警，非硬性）：',
              `任务描述疑似包含多个独立产出物（"${truncate(text, 80)}"）。`,
              '两种处理方式（二选一）：',
              splitAdvice + '；确需验收的补一步测试。拆分/合并后，独立步骤必须在【同一次 team_dispatch 调用】里以 tasks 数组一次性提交',
              '② 若确属单步任务（产出物强耦合不可拆，或量小不值得并行），重写本工具调用并带上 singleton:true 参数申明，即可通过',
              '注意：owner 必须与成员职责匹配（参照各成员职责描述），不要为凑数派给不相关成员',
            ].join('\n'))
          }
        }
        const steps: BlackboardStep[] = []
        const usedIds = new Set<string>()
        plan.forEach((p: any, i: number) => {
          const id = String(p?.id || '').trim() || `s${i + 1}`
          if (usedIds.has(id)) throw new Error(`步骤 id 重复：${id}`)
          usedIds.add(id)
          const owner = String(p?.owner || '').trim()
          if (!ctx.team.members.some(m => m.id === owner)) {
            throw new Error(`步骤 ${id} 的 owner「${owner}」不在团队成员里。可用：${ctx.team.members.map(m => m.id).join('、')}`)
          }
          steps.push({
            id,
            text: String(p?.text || '').trim().slice(0, 160),
            deps: (Array.isArray(p?.deps) ? p.deps : []).map((d: any) => String(d)),
            owner,
            status: 'pending',
            attempts: 0,
            updatedAt: Date.now(),
          })
        })
        for (const s of steps) {
          for (const d of s.deps) {
            if (!usedIds.has(d)) throw new Error(`步骤 ${s.id} 依赖的 ${d} 不在计划里`)
          }
        }
        const cycle = detectCycle(steps)
        if (cycle) throw new Error(`计划存在循环依赖：${cycle}`)
        // 0910 反馈6：重写计划时保留已有 runs——旧实现全量替换 blackboard 对象，把成员执行记录
        // 一起抹掉（刷新后子 agent 气泡无法从 transcript.subRuns 恢复的另一半根因）。
        const prevBb = readBlackboardRaw(ctx.sessionId)
        const prevRuns = Array.isArray(prevBb?.runs) ? prevBb.runs : []
        const bb: Blackboard = {
          sessionId: ctx.sessionId,
          teamId: ctx.team.id,
          goal,
          acceptance: String(params?.acceptance || '').trim() || undefined,
          steps,
          findings: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          /* ★1104-I：这是"全量替换"的代次凭据 —— 落盘时高于盘上一版才允许整份换掉 steps。
             没有它，saveBlackboard 的按 id 合并会把旧计划的步骤永久留在板上（幽灵步骤）。 */
          planRev: Number(prevBb?.planRev || 0) + 1,
        }
        if (prevRuns.length) (bb as any).runs = prevRuns
        /* ★bd1：bb_goal 是"全量替换**计划**"—— 待确认清单**不属于计划**，必须原样带过来。
           否则每重写一次计划就把用户还没答的问题静默抹掉（观感＝问题自己消失了）。 */
        const prevTombs = mergeDecisionTombstones((prevBb as any)?.decisionTombstones, undefined)
        ;(bb as any).decisionTombstones = prevTombs
        ;(bb as any).decisions = mergeDecisions((prevBb as any)?.decisions, undefined, prevTombs)
        saveBlackboard(bb)
        broadcastBB(ctx, bb)
        ctx.syncPlan(planItems(ctx, bb))
        ctx.log('info', 'session', `[团队] 黑板目标已写入（${steps.length} 步）`)
        const readyNow = steps.filter(s => s.deps.length === 0)
        const parallelHint = readyNow.length > 1
          ? `【并行提示】${readyNow.length} 个独立步骤（${readyNow.map(s => `${s.id}→${s.owner}`).join('、')}）无相互依赖：把它们放在【同一次 team_dispatch 调用】的 tasks 数组里一次性提交 —— **不同成员之间**才并行；**同一个成员同一时刻只干一件事**，多派给它的会排队依次做（不会并行）。`
          : '进入下一步：用 team_dispatch 派发。'
        return {
          content: [{ type: 'text', text: `黑板已建立：目标「${goal}」，计划 ${steps.length} 步（已同步用户计划卡）。计划不要重复写——直接派发。${parallelHint}` }],
          details: { ok: true, steps: steps.map(s => ({ id: s.id, owner: s.owner, deps: s.deps, status: s.status })) },
        }
      },
    },

    // ── bb_write：审核打回 / 发现 / 最终汇总（指挥官用） ──
    {
      name: 'bb_write',
      label: '写黑板',
      description: '写黑板：kind=step 标记步骤 done/rejected（打回必须带 feedback）；kind=finding 记录发现；kind=final 写最终汇总；'
        + 'kind=decision 处理「待确认」事项（只有 open 一种状态、答完即删）：只传 question ⇒ 新增一条（记下来等用户拍板，**不阻塞计划**）；'
        + '带 decisionId+answer ⇒ 记下用户答案并删掉这条（要落地就再用 bb_goal/bb_write 变成步骤）；带 decisionId+remove:true ⇒ 直接删（用户答"不做"）。',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('step'), Type.Literal('finding'), Type.Literal('final'), Type.Literal('decision')], { description: '写入类型' }),
        stepId: Type.Optional(Type.String({ description: 'kind=step 时必填' })),
        status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('rejected')], { description: 'kind=step 时必填' })),
        result: Type.Optional(Type.String({ description: 'kind=step&status=done 时可修正产出摘要' })),
        feedback: Type.Optional(Type.String({ description: 'kind=step&status=rejected 时必填：打回反馈（具体可执行）' })),
        text: Type.Optional(Type.String({ description: 'kind=finding/final 时必填' })),        /* ★bd1：kind=decision 的参数（新增/回答/删除都走这一个工具，**不新增工具**） */
        question: Type.Optional(Type.String({ description: 'kind=decision 新增时必填：一句话问清要用户拍板的事' })),
        context: Type.Optional(Type.String({ description: 'kind=decision 新增时可选：影响/代价（为什么要拍板）' })),
        options: Type.Optional(Type.Array(Type.String(), { description: 'kind=decision 新增时可选：候选答案（如 ["现在做","排后面","不做"]）' })),
        decisionId: Type.Optional(Type.String({ description: 'kind=decision 回答/删除时必填：dec1/dec2…（不存在会报错并列出现有 id）' })),
        answer: Type.Optional(Type.String({ description: 'kind=decision：用户怎么答的（原话/要点）——答"做"要再用 bb_goal/bb_write 变成步骤' })),
        remove: Type.Optional(Type.Boolean({ description: 'kind=decision：true=直接删掉这条（用户答"不做"或作废时用）' })),
      }),
      async execute(_callId, params: any) {
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb) throw new Error('黑板为空：先用 bb_goal 建立目标与计划')
        const kind = String(params?.kind || '')
        /* ★bd1：待确认清单 —— 只记/答/删，**绝不等待**用户回答（计划卡不能阻塞） */
        if (kind === 'decision') return bbDecisionWrite(ctx, bb, params)
        if (kind === 'step') {
          const step = bb.steps.find(s => s.id === String(params?.stepId || ''))
          if (!step) throw new Error(`步骤不存在：${params?.stepId}`)
          const status = String(params?.status || '')
          if (status === 'done') {
            /* 审核校验：步骤必须真的被执行过才能标 done —— 防主 agent 对从未派发的步骤直接"审核通过"
               （0901 c5d8b964 实锤：s2-s4 无成员执行被批量标 done，5 步计划假完成）。
               ★t1x：旧判据只认 `run.status ∈ {done,timeout}`，实测把**真执行过**的步骤永久卡死
               （be4a425f：51 个 review 步骤里 19 个的 run 终态是 interrupted —— 用户点停止 / 后端重启
               自愈写成的，而成员其实跑完并上报了，step.result 有产出）。
               现在三条证据**任一**成立即算执行过，且三条全都只有执行路径能写、bb_goal/bb_write 伪造不出来：
                 a) runs 里有该步的终态记录（interrupted 也算，running 不算）；
                 b) 步骤停在 review（= 成员跑完上报，runStepTask:1764 亲手写的）；
                 c) step.executedAt（执行路径落的持久证据，runs 被封顶裁掉/被自愈覆盖也查得到）。
               「从未派发过」的步骤：没有 run、不是 review、没有 executedAt ⇒ 照旧拒绝。 */
            const executed = stepHasExecutionEvidence(step, bb.runs)
            if (!executed && step.status !== 'done') {
              /* ★gg1：文案按**真实原因**分支（rejected / interrupted / 有 runs 都不达标 / runs 被裁 /
                 真·从未派发 / 其它 status），每支都带处理方式。旧版一句话把"被中断/被打回"也说成
                 "从未派发" ⇒ 主 agent 照着错的方向排查。分支逻辑集中在 explainNoExecutionEvidence。 */
              throw new Error(explainNoExecutionEvidence(step, bb.runs))
            }
            step.status = 'done'
            if (params?.result) step.result = truncate(params.result, 2000)
            step.updatedAt = Date.now()
            saveBlackboard(bb)
            broadcastBB(ctx, bb)
            ctx.syncPlan(planItems(ctx, bb))
            ctx.log('info', 'session', `[团队] 步骤 ${step.id} 审核通过`)
            const doneN = bb.steps.filter(s => s.status === 'done').length
            const allDone = doneN === bb.steps.length
            return {
              content: [{ type: 'text', text: `步骤 ${step.id} → done（${doneN}/${bb.steps.length}）。${allDone ? '全部完成：核对各成员产出，用 bb_write(kind=final) 写最终汇总，然后整合答复用户。' : '继续派发有依赖的后续步骤（deps 已满足）。'}` }],
              details: { ok: true, attemptsLeft: 3 - step.attempts },
            }
          }
          if (status === 'rejected') {
            const fb = String(params?.feedback || '').trim()
            if (!fb) throw new Error('打回必须带 feedback（具体可执行的修改要求）')
            step.status = 'rejected'
            step.feedback = truncate(fb, 600)
            step.updatedAt = Date.now()
            saveBlackboard(bb)
            broadcastBB(ctx, bb)
            ctx.syncPlan(planItems(ctx, bb))
            const left = 3 - step.attempts
            ctx.log('warn', 'session', `[团队] 步骤 ${step.id} 打回（剩余派发机会 ${left}）`)

            /* ★v1（老板要的闭环）：**打回即自动重派**，交给同一 owner 去修。
               病（老板原话）：「打回了，但点进对话没有任何变化，还是停留上一次交付的状态」——
               原来 `rejected` 只写状态+feedback，**没有任何重派动作**，得等主 agent 想起来手动
               `team_dispatch`；忘了就永远停在"已打回"。
               ⇒ 这里复用**现有车道/派发路径**（`lanePush` → `lanePump` → `runStepTask`），
                 不另写执行器（另写一套就会有两套 attempts 计数、两套状态机）。

               **次数保护怎么走的**（任务单要求，明确一下）：
                 `runStepTask` 开头就有 `if (step.attempts >= 3) return { blocked: true }`（:3175），
                 而 `step.attempts += 1` 也在那里（:3181）⇒ 自动重派走同一条路，
                 **第 4 次必然被拦下**（返回 blocked，不会执行）。这里不复制一份判据，
                 避免"两处上限不一致"这种经典坑。

               **supersededBy 边界**（任务单要求想清楚的）：
                 主 agent 可能打回后**立刻 bb_goal 重写计划**把这一步作废（或用 team_dispatch(supersedes)
                 标上 `supersededBy`）。已作废的步骤绝不能再去跑 —— 否则白烧一轮钱、还会覆盖新计划的产出。
                 拦法：重派入队**前**检查（见下），命中任一就不派：
                   · `step.supersededBy` 非空（已被显式取代）
                   · 该 step 已不在当前黑板计划里（bb_goal 全量重写会换掉 steps 数组）
                   · `step.status` 已经不是 'rejected'（说明主 agent 在同一次调用里又改了它）
                 ⚠️ 注意时序：`lanePush` 是**异步**的（`void lanePump`），真正开跑前还会重读黑板，
                    所以这里只能挡住"入队这一刻已经作废"的情况；若在排队期间被作废，
                    `lanePump` 每次取活都会重读黑板（见其注释"防旧副本整板覆盖"），届时该 step 已不在计划中。 */
            let reposted = false
            let repostNote = ''
            /* ★v2（实测：今天白烧了 3 轮）：**自动重派必须收紧** —— 只有"真的跑过、且还值得再跑"的步骤才重派。
               v1 的判据是"只要 bb_write(rejected) 就无条件 lanePush"，只挡了次数上限和 supersededBy。
               实测三次白烧（都是这一条造成的）：
                 · h1x —— **从没跑过**（方案改了就作废）⇒ 被自动重派，白跑一趟
                 · f2（第 1 次）—— 跑了但零代码产出（它在等后端字段）⇒ 重派 = 空转
                 · u1x —— 从没跑过（发现后端已有现成 RPC）⇒ 又要白跑
               现在四条判据（全部是**结构判据**，一条都不靠解析 feedback 文案 ——
               文案是自由文本，靠它判"是不是作废"等于把判据建在措辞上，模型换个说法就失效）：

                 ① 主 agent **显式说不要派**（`repost:false`）—— 最高优先级，意图由调用方明确表达；
                 ② 步骤**从未执行过**（`stepHasExecutionEvidence` 为假）—— 没跑过的步骤被打回，
                    通常意味着"方案变了/不要了"，而不是"做错了要重做"（重做的前提是先做过）；
                 ③ 已被 `team_dispatch(supersedes)` 标为取代 —— 那件事已由别的步骤接手；
                 ④ 次数用尽（`left <= 0`）—— 老规矩，`runStepTask` 里还有一道 `attempts >= 3` 的硬闸。
               ⚠️ ②直接用审核闸门那个同一个函数（`:4618` 的 done 分支在用）——
                  判据只有一份，避免"打回这里认为没跑过、审核那里认为跑过"这种自相矛盾。 */
            const _repostFlag = (params as any)?.repost
            if (_repostFlag === false) {
              repostNote = '不重派（主 agent 指定 repost:false）'
              ctx.log('info', 'session', `[团队] 步骤 ${step.id} 打回且不重派（主 agent 指定）`)
            } else if (left <= 0) {
              repostNote = '已达派发上限，不再自动重派'
            } else if (!stepHasExecutionEvidence(step, bb.runs)) {
              /* 判据②：从未执行过。注意判据要在 `step.status = 'rejected'` 之后读 ——
                 `stepHasExecutionEvidence` 里"review 即算跑过"那一支此时已不成立（status 刚改成 rejected），
                 剩下的 executedAt / runs 都是**执行路径亲手落的持久事实**，bb_write 伪造不出来。 */
              repostNote = '不重派（该步骤从未执行过——没跑过的步骤被打回通常意味着不要了，不是要重做）'
              ctx.log('info', 'session', `[团队] 步骤 ${step.id} 打回且不重派（从未执行过：无 executedAt、runs 里也没有它的终态记录）`)
            } else {
              const superseded = String((step as any).supersededBy || '').trim()
              if (superseded) {
                repostNote = `该步骤已被 ${superseded} 取代，不自动重派`
                ctx.log('info', 'session', `[团队] 步骤 ${step.id} 打回且不重派（已被 ${superseded} 取代）`)
              } else {
                /* 重新读一次计划：bb_goal 可能刚把 steps 换掉（防"给已不存在的步骤派活"）。 */
                const fresh = loadBlackboard(ctx.sessionId)
                const stillThere = !!fresh?.steps?.some((s: any) => String(s?.id || '') === step.id && String(s?.status || '') === 'rejected')
                if (!stillThere) {
                  repostNote = '该步骤已不在当前计划中（计划被重写），不自动重派'
                } else {
                  /* 重派用**独立的 callId**：它是新的一批活，要有自己的结算账本
                     （`settleCall` 没有账本时会当"迟到结果"丢弃 ⇒ 主 agent 收不到回归通知）。 */
                  const _cid = `rep-${crypto.randomUUID()}`
                  const _task = {
                    stepId: step.id,
                    memberId: String(step.owner || ''),
                    /* 任务单原文没有单独存放，用步骤正文重建 —— 与 `team_dispatch` 的任务单口径一致。
                       feedback 由 `buildMemberTaskMessage` 从 `step.feedback` 自动拼进去（:1914 已有先例），
                       这里不重复拼，避免同一条反馈出现两次。 */
                    task: String((step as any).text || ''),
                    acceptance: String((step as any).acceptance || ''),
                  }
                  try {
                    /* 状态先回 running：前端跑马灯就是认这个（老板：「边框改成运行中同款流动，直到下一次交付」）。 */
                    step.status = 'running'
                    step.updatedAt = Date.now()
                    saveBlackboard(bb)
                    broadcastBB(ctx, bb)
                    ctx.syncPlan(planItems(ctx, bb))
                    /* 登记这批的结算账本（1 项）—— 没有它，跑完不会发回归通知。 */
                    beginCallSettle(ctx.sessionId, _cid, null, [_task])
                    lanePush(ctx, _cid, _task)
                    reposted = true
                    ctx.log('info', 'session', `[团队] 步骤 ${step.id} 被打回，自动重派（第 ${step.attempts + 1} 次；反馈：${truncate(fb, 80)}）`)
                  } catch (e) {
                    /* 重派失败不能把"打回"这个事实吞掉 —— 打回本身已经生效，这里只是没派成。 */
                    step.status = 'rejected'
                    step.updatedAt = Date.now()
                    saveBlackboard(bb)
                    broadcastBB(ctx, bb)
                    repostNote = `自动重派失败（${String((e as any)?.message || e).slice(0, 120)}）——请手动 team_dispatch`
                    ctx.log('error', 'session', `[团队] 步骤 ${step.id} 打回后自动重派失败：${String((e as any)?.message || e).slice(0, 200)}`)
                  }
                }
              }
            }

            return {
              content: [{ type: 'text', text: reposted
                ? `步骤 ${step.id} 已打回，**已自动重派给 ${memberName(ctx.team, String(step.owner || ''))} 去修**（第 ${step.attempts + 1} 次，带上你的反馈）。请就此收轮挂起，等「团队回归」通知后再审核。`
                : (left > 0
                  ? `步骤 ${step.id} 已打回，反馈已记录；但**没有自动重派**：${repostNote}`
                  : `步骤 ${step.id} 已打回并记录反馈。注意：它已派发 ${step.attempts} 次达到上限（${repostNote}）——把各次产出对比呈现给用户请求定夺`) +
                /* ★v2：**不重派时给出下一步动作** —— 只说"没重派"主 agent 会干等。
                   三种"不重派"的后续动作完全不同，所以按 note 分派，不笼统给一句（那句一定有一半是错的）。 */
                (!reposted && left > 0 && _repostFlag !== false
                  ? `\n\n下一步：这项不会自己再跑了。要它重做就手动 team_dispatch 重派（写入上面反馈的解决要求）；不需要了就 bb_goal 重写计划把它移除。`
                  : (!reposted && _repostFlag === false
                    ? '\n\n下一步：按你说的不再派。不需要它了就用 bb_goal 重写计划移除，或直接继续别的事。'
                    : '')) }],
              details: { ok: true, attemptsLeft: left, reposted, repostNote: repostNote || undefined },
            }
          }
          throw new Error('status 只能是 done/rejected')
        }
        if (kind === 'finding') {
          const text = String(params?.text || '').trim()
          if (!text) throw new Error('text 不能为空')
          bb.findings.push({ t: Date.now(), by: '指挥官', text: truncate(text, 600) })
          if (bb.findings.length > 30) bb.findings = bb.findings.slice(-30)
          saveBlackboard(bb)
          broadcastBB(ctx, bb)
          return { content: [{ type: 'text', text: '发现已记录到黑板' }], details: { ok: true } }
        }
        if (kind === 'final') {
          const text = String(params?.text || '').trim()
          if (!text) throw new Error('text 不能为空')
          bb.finalResult = truncate(text, 4000)
          saveBlackboard(bb)
          broadcastBB(ctx, bb)
          ctx.log('info', 'session', '[团队] 最终汇总已写入黑板')
          return {
            content: [{ type: 'text', text: '最终汇总已写入黑板。请把它整合成给用户的答复（引用成员产出与产物路径，黑板是事实源）。' }],
            details: { ok: true },
          }
        }
        throw new Error('kind 只能是 step/finding/final/decision')
      },
    },

    // ── bb_read：读黑板快照 ──
    {
      name: 'bb_read',
      label: '读黑板',
      /* ★1032-TM（P102）：描述里明确"默认是摘要" —— 否则模型不知道有分级，永远拿全文（一次 ~10k tokens）。 */
      description: '读取黑板快照（目标/计划进度/发现/汇总）。**默认摘要视图**（每步一行+产出摘要），够用来判断派谁/打回谁；要看某一步的完整产出用 stepId，要看全部细节用 detail=true',
      parameters: Type.Object({
        stepId: Type.Optional(Type.String({ description: '只看这一步的完整内容（含打回反馈）' })),
        detail: Type.Optional(Type.Boolean({ description: 'true=给每个步骤的完整产出（默认只给一行+摘要）' })),
      }),
      async execute(_callId: string, params: any) {
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb) return { content: [{ type: 'text', text: '黑板为空（尚未 bb_goal 建立目标）' }], details: { empty: true } }
        /* ★e1：**bb_read 也要拿账本口径** —— 这是本单的核心之一。
           病：`loadBlackboard` 填进内存的 `memberTotals` 是 `computeMemberTotals` 的 **runs 口径**
           （`loadBlackboard:467`），而 `memberTotalsLine`（formatBB 里用的）会优先取 `board.memberTotals`
           ⇒ bb_read 读到的就是 runs 残值，与前端广播帧（已补账本口径）**对不上**。
           ★d1 只在 `broadcastBB` 与 `blackboard.read` 两处补了账本口径，这里第三处漏了。
           用同一个 `mergeMemberUsageLedger` 补 —— 不复制算法，两处/三处永远同源。
           ⚠️ 只改内存这份 bb（就地），不落盘（`memberTotals` 本来就不落盘了）。 */
        try { mergeMemberUsageLedger(ctx, bb) } catch { /* 补不上就用 runs 口径（memberTotalsLine 会如实显示） */ }
        /* ★f1：bb_read 也要带**当前段用量** —— 与广播帧同源（否则模型读到的卡片数和前端看到的不是一个口径）。 */
        try { mergeMemberSegUsage(ctx, bb) } catch { /* 补不上就不写这两个键（如实缺失） */ }
        const text = formatBB(bb, { detail: params?.detail === true, stepId: String(params?.stepId || '') })
        /* ★1107：**不要把整块黑板塞进 details**。
           黑板带 `runs`（成员每次运行的完整 transcript，实测 8.33MB），而 server.ts 会把整个
           `event.result` JSON.stringify 进 tool_result.content、再把 details 单独存一份 ——
           一次 bb_read 就在会话文件里落约 19MB 的**重复副本**。
           实测会话 7b6cc931 昨晚 22 次 bb_read 把文件撑到 556MB，越过 Node 字符串上限
           (0x1fffffe8 ≈ 512MB) ⇒ session.state / session.history 全部抛 ERR_STRING_TOO_LONG
           ⇒ 前端拿不到数据，永远停在骨架。
           权威黑板本来就在 backend/data/blackboard/<sid>.json；模型只读 content[0].text
           （formatBB 摘要），前端也不读 details.blackboard —— 这份内嵌副本零信息价值。 */
        return { content: [{ type: 'text', text }], details: { ok: true } }
      },
    },

    // ── sub_read：读某个执行实例的对话/过程（**只读**）──
    /* ★1036-S3（需求「主 agent 要能读用户和成员的聊天、要管进度」）：
       指挥官只看黑板不够 —— 用户会在单聊里对成员提新要求、成员也会在单聊里补充说明，那些信息不进黑板。
       这个工具把「某次执行的过程」与「该成员的单聊记录」一起给它，它才能判断进度要不要调整。
       **纯读**：不写黑板、不改任何状态。
       参数二选一：给 runId 看某一次执行；给 memberId 看某个人的全部执行 + 单聊记录；
       两个都不给 ⇒ 全部执行概览（谁在跑 / 跑完没 / 一句话产出）。 */
    {
      name: 'sub_read',
      label: '读执行详情',
      description: '读某个成员/某次执行的过程与单聊记录（只读）。给 runId 看单次执行；给 memberId 看这个人所有执行+你与TA的单聊；都不给=全部执行概览。判断进度、决定要不要补派/打回前用它',
      parameters: Type.Object({
        runId: Type.Optional(Type.String({ description: '执行 id（派活后黑板里的 runId）' })),
        memberId: Type.Optional(Type.String({ description: '成员 id（看这个人的全部执行+单聊记录）' })),
      }),
      async execute(_callId: string, params: any) {
        const wantRun = String(params?.runId || '').trim()
        const wantMember = String(params?.memberId || '').trim()
        const bb = loadBlackboard(ctx.sessionId)
        /* ★1036-S37：**全量来源** —— `session.subRuns`（按 callId 分组、随会话落盘、无窗口上限）。
           黑板 `bb.runs` 只保留最近 60 条（persistRuns 的 slice(-60)），长会话里早期子任务会被挤掉。
           两边按 runId 合并：会话侧优先（全量），黑板侧覆盖（它是活对象、内容更新）。 */
        const _fromBoard: any[] = Array.isArray((bb as any)?.runs) ? ((bb as any).runs as any[]) : []
        const _fromSession: any[] = ctx.listAllRuns ? ctx.listAllRuns() : []
        const _runById = new Map<string, any>()
        for (const r of _fromSession) { const id = String(r?.runId || ''); if (id) _runById.set(id, r) }
        for (const r of _fromBoard) { const id = String(r?.runId || ''); if (id) _runById.set(id, r) }
        const runs: any[] = [..._runById.values()]
        const oneLine = (r: any) => {
          const body = String(r?.text || r?.result || '').replace(/\s+/g, ' ').trim()
          return `· ${String(r?.runId || '').slice(0, 8)}｜${memberName(ctx.team, String(r?.memberId || ''))}｜${String(r?.status || '?')}｜${truncate(body, 160) || '(无产出)'}`
        }

        if (wantRun) {
          const r = runs.find(x => String(x?.runId || '') === wantRun)
          if (!r) return { content: [{ type: 'text', text: `没有这次执行：${wantRun}（不带参数调用我，先看全部执行概览）` }], details: { ok: false } }
          const toolLines = (Array.isArray(r?.tools) ? r.tools : [])
            .map((t: any) => `  - ${String(t?.name || '?')}（${String(t?.status || '?')}）${t?.result ? '：' + truncate(String(t.result).replace(/\s+/g, ' '), 160) : ''}`)
            .join('\n')
          const segTexts = (Array.isArray(r?.segments) ? r.segments : [])
            .filter((sg: any) => sg?.kind === 'text' || sg?.type === 'text')
            .map((sg: any) => truncate(String(sg?.text || ''), 240))
            .filter(Boolean)
            .slice(-6)
          const txt = [
            `执行 ${String(r.runId)}`,
            `成员：${memberName(ctx.team, String(r.memberId || ''))}｜状态：${String(r.status || '?')}${r.stepId ? `｜步骤：${r.stepId}` : ''}`,
            r.startedAt ? `开始：${new Date(Number(r.startedAt)).toLocaleString()}` : '',
            r.endedAt ? `结束：${new Date(Number(r.endedAt)).toLocaleString()}` : '',
            '',
            '【产出/汇报】',
            truncate(String(r.text || r.result || '(无)'), 1200),
            toolLines ? '\n【工具调用】\n' + toolLines : '',
            segTexts.length ? '\n【过程正文（末尾几段）】\n' + segTexts.join('\n---\n') : '',
          ].filter(Boolean).join('\n')
          return { content: [{ type: 'text', text: txt }], details: { runId: r.runId } }
        }

        if (wantMember) {
          const mine = runs.filter(x => String(x?.memberId || '') === wantMember)
          /* ★P102：**真的把单聊读出来**（原来这里只写了一句"去成员窗口看"，与工具描述不符）。 */
          const chats = ctx.readMemberChat ? (ctx.readMemberChat(wantMember, 12) || []) : []
          const chatText = chats.length
            ? chats.map((c) => `· ${c.role === 'user' ? '用户' : 'TA'}：${truncate(String(c.text || '').replace(/\s+/g, ' '), 200)}`).join('\n')
            : '（暂无单聊记录）'
          const txt = [
            `成员：${memberName(ctx.team, wantMember)}（${wantMember}）`,
            mine.length ? '【派活执行】\n' + mine.map(oneLine).join('\n') : '【派活执行】无',
            '【单聊记录（最近 12 条，用户在该成员窗口里直接说的话 + 成员的回复）】',
            chatText,
          ].join('\n')
          return { content: [{ type: 'text', text: txt }], details: { memberId: wantMember, chats: chats.length } }
        }

        if (!runs.length) return { content: [{ type: 'text', text: '还没有任何执行记录（尚未派活）' }], details: { empty: true } }
        const recent = runs.slice(-12)
        /* ★P102：把**总数**说出来 —— 原来只列最近 12 条，模型看到 12 条会以为这就是全部
           （长会话里它因此重复派活/误判"没做过"）。 */
        const more = runs.length > recent.length ? `（共 ${runs.length} 次，这里只列最近 ${recent.length} 次；看某个成员用 memberId）` : `（共 ${runs.length} 次）`
        return { content: [{ type: 'text', text: `最近执行${more}：\n` + recent.map(oneLine).join('\n') }], details: { count: runs.length } }
      },
    },

    // ── team_info：读团队清单 ──
    {
      name: 'team_info',
      label: '读团队信息',
      description: '查看团队成员清单（id/名称/职责/可用工具/模型模式）——拆解任务、分配 owner 前先读',
      parameters: Type.Object({}),
      async execute() {
        const bbNow = loadBlackboard(ctx.sessionId)
        const members = ctx.team.members.map(m => {
          const p = readAgentPreset(m.preset)
          // 0910 反馈4/5：独立模型"是否真的可用"必须暴露给指挥官——不可用=实际跑会话模型，
          // 拆任务/评估产出时必须知道（弱模型成员要配更细的任务单与验收标准）
          let modelText: string
          if (m.modelMode === 'independent') {
            const ok = !!ctx.resolveMemberModel(m)
            modelText = `独立(${m.modelId || '未填'}${ok ? '' : ' ⚠不可用→实际使用会话模型'}${(m as any).effort ? `｜思考挡位:${(m as any).effort}` : ''})`
          } else {
            modelText = '跟随会话'
          }
          // ★1036：`并行上限` 概念随 maxInstances 一起取消 —— 成员就是一个人，同一成员的任务串行
          /* ★1104-K：把"正在做哪一步 / 队列里排着哪几步"写出来 —— 主 agent 判"用户补充的是不是
             它手上那件事"必须有这个事实，否则只能靠猜（补充发错步骤=白干扰）。 */
          const runningRun = (bbNow?.runs || []).find(r => r.memberId === m.id && r.status === 'running' && activeRunIds.has(String(r.runId)))
          const _queuedIds = (memberLanes.get(laneKey(ctx.sessionId, m.id))?.queue || []).map(q => String(q?.task?.stepId || '?'))
          const stateText = runningRun ? `忙（正在做 ${String(runningRun.stepId || '?')}）` : '空闲'
          const queueText = _queuedIds.length ? `｜排队：${_queuedIds.join('、')}（等手上的跑完自动接着做）` : ''
          /* ★g1：**当前段的运行体征** —— 主 agent 判"该不该给它换段"必须有据可依，否则只能靠感觉。
             老板的判据原话："压缩两次感觉成员做事降智了，可以重新开" ⇒ 这里就把次数摆出来。
             三个数都来自既有权威字段（见 TeamCtx.memberSegSigns 的注释），拿不到就写「—」：
             ⚠️ 不写 0 —— 假 0 会让主 agent 以为"这段很干净、不用换"，正好反了。
             占用率复用 memberCtxUsage 的同一个 probe（不复制算法）；
             段号/压缩次数/run 数来自 memberSegSigns。 */
          const _ctxU = ctx.memberCtxUsage?.(m.id) || null
          const _signs = ctx.memberSegSigns?.(m.id) || null
          const _ctxPct = _ctxU && _ctxU.ctxWindow > 0
            ? `${Math.round((_ctxU.ctxUsed / _ctxU.ctxWindow) * 100)}%`
            : '—'
          const _segNo = _signs && _signs.segSeq > 0 ? `第${_signs.segSeq}段` : '段次未知'
          /* 压缩次数=0 是**真实且有用的信息**（这段还很干净），所以只有拿不到整条记录才写「—」；
             拿得到就照实写数字（含 0）——这是"0 是真值"与"0 是缺失"必须分开的又一处。 */
          const _compactText = _signs ? `已压缩 ${_signs.compactions} 次` : '已压缩 — 次'
          const _runsText = _signs ? `已跑 ${_signs.runs} 个 run` : '已跑 — 个 run'
          /* 该换了：老板给的经验线 —— 压缩≥2 次或占用≥80%。这是**事实提示**（不是替主 agent 决定），
             算不出来时不给提示（宁可不提示，也不给一个基于假数的基础）。 */
          const _shouldRotate = (_signs && _signs.compactions >= 2) || (_ctxU && _ctxU.ctxWindow > 0 && _ctxU.ctxUsed / _ctxU.ctxWindow >= 0.8)
          const _rotateHint = _shouldRotate ? '｜⚠此段建议换（freshSession）' : ''
          const segText = `｜当前段：${_segNo} 占用 ${_ctxPct} · ${_compactText} · ${_runsText}${_rotateHint}`
          return `- ${m.id}：${memberName(ctx.team, m.id)}｜职责：${truncate(m.role || p?.description || '', 120)}｜工具：${(p?.tools || []).join('、')}｜模型：${modelText}｜${stateText}${queueText}${segText}${ctx.memberSkills(m.id).length ? `｜技能：${ctx.memberSkills(m.id).join('、')}` : ''}`
        }).join('\n')
        /* ★1104-H：口径与实现严格一致 —— 并行只发生在**不同成员之间**；同一成员的多条任务**排队**，
           前一件跑完自动接着做，并随那一批一起回归（不再说"串行/并行"两种说法）。 */
        const text = `团队「${ctx.team.name}」（${ctx.team.id}）\n模式：${ctx.team.mode}｜并行方式：成员之间并行，**同一成员同一时刻只干一件事**（多派的任务排队，前一件跑完自动接着做）｜黑板：${ctx.team.blackboard ? '开' : '关'}\n派发规则：tasks 数组一次可提交多个；不同成员各自立刻开工，**同一个成员的多项会按提交顺序排队**（不会并行、不会串任务），并随着那一批一起回归。重复派发正在跑/已排队的步骤会被硬拒绝。新活可以直接派（stepId 可省，工具会自动补建步骤）。\n给忙成员补一句话：用 member_tell（不重派、不打断）——用户补充的要求、你发现的任务单遗漏都走它；成员空闲时它会报错，那种情况才该派新步骤。\n派活原则：任务难度要与成员「档位」匹配——fast 档只派边界清晰的小任务，strong 档可派需要判断与设计的复杂任务。「空闲」的立刻开工，「忙」的排到它当前任务之后（排队进度看「排队：…」）。\n换段（freshSession）：成员的上下文会随它干过的活越来越长，压缩只是**合并**旧摘要、不会丢掉上一个任务的细节 ⇒ 上一个任务的路径/报错/参数会一直留在它脑子里干扰判断（表现为"变笨"）。判定这个成员**上一阶段已收尾**、或它当前段「已压缩 ≥2 次 / 占用 ≥80%」（见下面每行的「当前段：…」）、或明显换话题时，下一次派活给它带上 freshSession:true + handoffHint（一两句交接要点），它就会开一段干净的新对话再开工。旧段归档、能查不能继续。**同一成员手上还有活时不能换段**（等它回归后再派），且一次派发只能给它换一段。\n主指挥官：${ctx.team.mainPreset}\n成员：\n${members}`
        return { content: [{ type: 'text', text }], details: { team: JSON.parse(JSON.stringify(ctx.team)) } }
      },
    },
  ]
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

/**
 * browserRetirement.ts —— **AI 临时页退场判定**（纯函数，无 IO、无 Electron/Playwright 依赖）
 *
 * 依据（老板 2026-11-18 定案，见 0812745a L281）：
 *   > 用户的标签页不该由 AI 猜着关；AI 明确为任务开的临时页，才适合随任务回收。
 *   > 自动关闭必须**同时满足**：①创建时标为 AI 临时页 ②任务已结束 ③当前没人用 ④用户没接管或要求保留。
 *   > 用户手开的、正在看的、主动点进或操作过的、来源不明的，一律不自动关。
 *   > **不按域名、标签年龄或数量猜该关谁。**
 *
 * 为什么单独成文件：这是**唯一**决定"关哪一页"的地方。它必须能脱离真实宿主单测 ——
 * 之前那版原型（m6-ai-temp-retirement）就是靠这一点在三次打回后仍然 62/62。
 * 判定只用后端已有的结构化事实（origin / ownerTaskId / watchedTabId / controlledBy），
 * **不看 URL、不看打开时间、不看数量**。
 */
import type { BrowserTabInfo } from './browserEngine.ts'

/** 退场时的会话事实（由调用方从宿主取，本文件不查任何东西） */
export interface RetireContext {
  /** 本轮任务 id（= 触发退场的那一轮）。只有 ownerTaskId 与它相等的页才可能被退 */
  taskId: string
  /** 面板当前正在渲染的那一页（页级观看事实） */
  watchedTabId: string
  /** 是否有人在看（会话级）。**为 true 但 watchedTabId 为空 ⇒ 整会话不退**：
   *  不知道用户在看哪一页时，任何一页都可能正被他盯着 —— 宁可不关。 */
  watching?: boolean
  /** 占用权：'user' = 用户正在操作（整会话不关） */
  controlledBy: 'user' | 'ai' | ''
}

export type RetireReject =
  /** 不是 AI 开的页（用户页 / 来源不明）—— 永远不关 */
  | 'not-ai'
  /** 是 AI 开的，但不是本轮任务的 */
  | 'other-task'
  /** 面板正在看这一页 */
  | 'watched'
  /** 用户接管中（整会话） */
  | 'controlled'
  /** 保底：退完就没有页面了（至少留一页可交互） */
  | 'last-resident'

export interface RetireDecision {
  retire: boolean
  reason?: RetireReject
}

/** 单页判定（**不含**"保底留一页"，那是批量层面的约束） */
export function decideRetire(tab: BrowserTabInfo, ctx: RetireContext): RetireDecision {
  if (String(tab?.origin || '') !== 'ai') return { retire: false, reason: 'not-ai' }
  const owner = String(tab?.ownerTaskId || '')
  if (!owner || owner !== String(ctx.taskId || '')) return { retire: false, reason: 'other-task' }
  if (ctx.controlledBy === 'user') return { retire: false, reason: 'controlled' }
  /* ★1132：**当前激活的标签不退**（= 用户正在看的那一页）。
     这是引擎的权威事实（`activeTabId`），不依赖前端上报 —— 实测前端全仓没有任何 `browser.watch`
     调用（那是条死 RPC），所以"用户在看哪一页"只能从引擎取。 */
  if (tab.active === true) return { retire: false, reason: 'watched' }
  /* 有人在看、但不知道在看哪一页 ⇒ 每一页都可能是他正盯着的 ⇒ 全不退。 */
  if (ctx.watching && !ctx.watchedTabId) return { retire: false, reason: 'watched' }
  if (ctx.watchedTabId && String(tab.id) === String(ctx.watchedTabId)) return { retire: false, reason: 'watched' }
  return { retire: true }
}

export interface SweepPlan {
  /** 可以退场的页（已满足"保底留一页"约束） */
  retire: BrowserTabInfo[]
  /** 被跳过的页及原因（留痕用，不静默） */
  skipped: Array<{ id: string; reason: RetireReject }>
}

/**
 * 批量规划：只处理 `origin==='ai' && ownerTaskId===当前任务` 的页，并且**保底留一页**。
 *
 * 保底口径：resident（要保住的页）只算**当前仍在的**页；如果候选把所有页都退完，
 * 就留下候选里的**最后一个**（不按 URL/页龄挑，纯粹"至少留一页"）。
 * 注：本函数只做规划，真正关闭由调用方逐页执行（失败不重试、写回执原因）。
 */
export function planSweep(tabs: BrowserTabInfo[], ctx: RetireContext): SweepPlan {
  const list = Array.isArray(tabs) ? tabs : []
  const skipped: Array<{ id: string; reason: RetireReject }> = []
  const candidates: BrowserTabInfo[] = []
  for (const t of list) {
    const d = decideRetire(t, ctx)
    if (d.retire) candidates.push(t)
    else if (d.reason) skipped.push({ id: String(t.id || ''), reason: d.reason })
  }
  /* 保底：全部被退 ⇒ 剩 0 页时面板就空了。留一页（候选里的最后一个）。 */
  if (candidates.length && candidates.length >= list.length) {
    const keep = candidates[candidates.length - 1]
    candidates.pop()
    skipped.push({ id: String(keep.id || ''), reason: 'last-resident' })
  }
  return { retire: candidates, skipped }
}

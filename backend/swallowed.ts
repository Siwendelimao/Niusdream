/**
 * swallowed —— 「降级必须留痕」的统一出口（后端版，★1005 清兜底批次）。
 *
 * 与前端 `frontend/src/utils/swallowed.ts` 同一套口径（见那里的完整说明），只是跑在 Node 上。
 *
 * ## 口径（三分类）
 * 1. **真·无害的尽力而为** → 允许静默（关流、杀已退出进程、删临时文件、纯内存赋值），但要注明原因。
 *    ⚠️ **★1104-nb2 更正**：原先这里把「`broadcastMux/writeMuxTo` 周围的 catch」整类判为可静默，
 *    实测**错了**——广播丢了前端永远不更新，而后端零痕迹（c4* 系列排查成本的主因）。
 *    现在广播失败**必须留痕**，但它会随 WS 断开成批出现 ⇒ 一律用下面的
 *    `swallowedThrottled('broadcast', e, key)`（同会话+同帧类型 60s 只报 1 条 + 全局预算），别用裸 `swallowed`。
 *    仍属真·无害、可静默的：`schedulePersist()` 周围的 catch（它只是防抖，不可能抛；
 *    真正的落盘失败由 `persistSessions` 自己的 `console.error('[persist] sessions failed:')` 负责）、
 *    关流/杀已退出进程/删临时文件。
 * 2. **用户可见结果可能因此不对** → 必须走本函数（例：直接写 settings/ui-state 失败、
 *    回填 agent 上下文失败、IM 回执没发出去）。
 * 3. **协议字段缺失/类型不符** → 不许默认成"成功"，要显式报错（不要用本函数掩盖）。
 *
 * ## 输出契约
 * 统一前缀 `[nis:swallowed]`；**第 1 次必报**，之后每当计数是 `every` 的整数倍再报（默认 20）。
 * 重复报时带「第 N 次」，便于判断偶发还是高频。
 */
const seen = new Map<string, number>()

export function swallowed(scene: string, e: unknown, every = 20): void {
  const n = (seen.get(scene) || 0) + 1
  seen.set(scene, n)
  if (n !== 1 && n % Math.max(1, every) !== 0) return
  const msg = e instanceof Error ? (e.message || String(e)) : String(e)
  // 用 warn（不是 error）：这些是"降级但已留痕"，不是崩溃
  console.warn(`[nis:swallowed] ${scene}${n > 1 ? `（第 ${n} 次）` : ''}：${msg}`, e)
}

/** 只读快照（给"想知道频率"或调试用） */
export function swallowedCount(): ReadonlyArray<{ scene: string; count: number }> {
  return [...seen.entries()].map(([scene, count]) => ({ scene, count }))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * swallowedThrottled —— 高频降级点的限频留痕（★1104-nb2）
 *
 * 病因：`broadcastMux/writeMuxTo` 的 catch 全仓 41 处都是空的（`catch { /* ignore *\/ }`）。
 * WS 一断，一次 turn 就能抛几十次 —— 既"不允许静默失败"（老板铁律）又不能刷屏。
 *
 * 策略（三层，任何一层单独都能兜住"不爆炸"）：
 *  ① **同 key 窗口限频**：同一 `scene|key`（key = 帧类型|会话 id）在 `windowMs`（默认 60s）
 *     内只报第 1 条，其余只累加"被静默次数"，下次报的时候一并带上 ⇒ 100 次连败 = 1 条日志。
 *  ② **全局预算**：所有场景合计每 60s 最多 `GLOBAL_BUDGET_MAX` 条 —— 42 处 × 几百个会话同时
 *     失败时也不会把日志刷爆（WS 断线是"整机级"故障，不需要逐会话报）。
 *  ③ **频控表有上限**：`throttleSeen` 最多 `THROTTLE_MAX_KEYS` 个 key，满了淘汰最久没报的那个
 *     ⇒ 不随会话数/随机 key 无界增长（内存安全）。
 *
 * 用法：`swallowedThrottled('broadcast', e, 'session/projection|' + sessionId)`
 *      索引漂移：`swallowedThrottled('index-drift', e, 'hydrate|' + id)`
 * 口径：只报 `console.warn` 一行（不 dump 整个 Error 栈，避免日志量变大）。
 * ═══════════════════════════════════════════════════════════════════════════ */
const THROTTLE_MAX_KEYS = 128
const THROTTLE_WINDOW_MS = 60_000
const GLOBAL_BUDGET_MAX = 12
const GLOBAL_BUDGET_WINDOW_MS = 60_000

interface ThrottleRec { n: number; lastReport: number; muted: number }
const throttleSeen = new Map<string, ThrottleRec>()
let budgetWindowStart = 0
let budgetUsed = 0

export function swallowedThrottled(scene: string, e: unknown, key = '', windowMs = THROTTLE_WINDOW_MS): void {
  const now = Date.now()
  const k = key ? `${scene}|${key}` : scene
  let rec = throttleSeen.get(k)
  if (!rec) {
    // ③ 上限：满了淘汰"最久没报"的那条（不无界增长）
    if (throttleSeen.size >= THROTTLE_MAX_KEYS) {
      let oldestKey = ''
      let oldestAt = Infinity
      for (const [kk, v] of throttleSeen) if (v.lastReport < oldestAt) { oldestAt = v.lastReport; oldestKey = kk }
      if (oldestKey) throttleSeen.delete(oldestKey)
    }
    rec = { n: 0, lastReport: 0, muted: 0 }
    throttleSeen.set(k, rec)
  }
  rec.n++
  // ① 窗口内静默（只累加，不输出）
  if (rec.lastReport && now - rec.lastReport < windowMs) { rec.muted++; return }
  // ② 全局预算
  if (!budgetWindowStart || now - budgetWindowStart >= GLOBAL_BUDGET_WINDOW_MS) {
    budgetWindowStart = now
    budgetUsed = 0
  }
  if (budgetUsed >= GLOBAL_BUDGET_MAX) { rec.muted++; return }
  budgetUsed++

  const muted = rec.muted
  rec.muted = 0
  rec.lastReport = now
  const msg = e instanceof Error ? (e.message || String(e)) : String(e)
  console.warn(
    `[nis:swallowed] ${scene}${key ? `（${key}）` : ''}` +
    `${rec.n > 1 ? ` 第 ${rec.n} 次` : ''}${muted ? `，本窗口已静默 ${muted} 次` : ''}：${msg}`,
  )
}

/** 频控/预算只读快照（自检脚本与调试用；不参与业务逻辑） */
export function swallowedThrottledStats(): {
  keys: number
  keyCap: number
  budgetUsed: number
  budgetMax: number
  windowMs: number
} {
  return { keys: throttleSeen.size, keyCap: THROTTLE_MAX_KEYS, budgetUsed, budgetMax: GLOBAL_BUDGET_MAX, windowMs: THROTTLE_WINDOW_MS }
}

/** 仅供测试：把频控状态清零（生产代码不要调） */
export function __resetSwallowedThrottleForTest(): void {
  throttleSeen.clear()
  budgetWindowStart = 0
  budgetUsed = 0
}

/**
 * 1035 · C′（agent-event 瘦身）—— 纯函数，可单测
 *
 * 依据（实测，不是猜）：
 *   ① `/api/ws-stats` 采样 37 帧：`partial` 44.5% + `message` 44.5% = 89% 的字节都在同一份内容上；
 *      `delta` 只有 0.2%。
 *   ② 前端唯一消费路径 `NiusDreamChat.handleAgentEvent`：
 *      · `message_update` 分支**只读 `event.assistantMessageEvent`**，从不读 `event.message`；
 *      · `ae.partial` 的两个使用点都写着 `.filter(c => c.type === 'toolCall')`
 *        （NiusDreamChat.ts:2188 / :2223）⇒ **正文与思考的快照从头到尾没被用过**。
 *   ③ `message_start` / `message_end` 才需要 `event.message`（各一次，量小），所以**只瘦 message_update**。
 *
 * 结果（预期）：每帧从 ~3KB 降到几百字节，且**前端零改动**。
 *
 * 纪律：
 *   · 只删"**已经证明没有消费者**"的字段；证明不了的一个都不动。
 *   · `message_update` 缺 `assistantMessageEvent` 时**不许删 message**（那才是唯一数据源）——
 *     保留 + 报违约，让问题可见，而不是让它悄悄渲染不出来。
 */

export interface SlimOutcome {
  event: unknown
  changed: boolean
  /** 违约留痕（空数组 = 一切正常） */
  violations: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SlimOptions {
  onViolation?: (message: string) => void
}

/**
 * 瘦身一个 pi 原始事件（不修改入参，返回新对象）。
 * 只处理 `message_update`，其余原样返回。
 */
export function slimAgentEvent(event: unknown, opts: SlimOptions = {}): SlimOutcome {
  const report = opts.onViolation ?? ((m: string) => console.warn(m))
  const violations: string[] = []

  if (!isObj(event)) return { event, changed: false, violations }
  if (String(event.type || '') !== 'message_update') return { event, changed: false, violations }

  const ae = event.assistantMessageEvent
  if (!isObj(ae)) {
    const msg = '[1035] message_update 缺 assistantMessageEvent —— 保留 event.message 不删（否则前端没有任何数据源）'
    violations.push(msg)
    report(msg)
    return { event, changed: false, violations }
  }

  const partial = ae.partial
  const hasPartial = isObj(partial) && Array.isArray(partial.content)
  if (!hasPartial) {
    const msg = '[1035] message_update 的 assistantMessageEvent 没有 partial.content —— 保留 event.message 不删'
    violations.push(msg)
    report(msg)
    return { event, changed: false, violations }
  }

  const content = (partial as { content: unknown[] }).content
  const toolOnly = content.filter((c) => isObj(c) && String(c.type || '') === 'toolCall')

  const slimPartial: Record<string, unknown> = { ...(partial as Record<string, unknown>), content: toolOnly }
  const slimAe: Record<string, unknown> = { ...ae, partial: slimPartial }

  /* 删掉 event.message：message_update 分支从不读它（已逐行确认）。
     ⚠️ 用展开复制而不是 delete，避免改到 pi 交进来的原对象（可能还有别的监听方）。 */
  const slimEvent: Record<string, unknown> = { ...event, assistantMessageEvent: slimAe }
  delete slimEvent.message

  return { event: slimEvent, changed: true, violations }
}

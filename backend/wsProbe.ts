/**
 * 1035 阶段0 · 帧体积探针（只读、可重置、带采样）
 *
 * 为什么单独成模块：
 *   ① server.ts 已经 2.3 万行，诊断代码不该再往里塞；
 *   ② 这里要回答一个具体问题：**agent-event 那 6.4KB/帧里，到底是哪一部分占的**
 *      （实测 12 秒 1018 帧 / 5.9MB，其中 922 帧是 session/agent-event ⇒ 优化方向全看这个拆解）。
 *
 * 纪律：
 *   · 纯诊断，绝不改变任何投递行为；
 *   · **采样**（默认 1/10）——对超大帧做 JSON.stringify 只为量尺寸是有成本的，不许让探针自己变成瓶颈；
 *   · 不吞异常：出错计数 + 留痕，但不许打断业务（探针崩了不该让人收不到消息）。
 */

export interface SizeStat {
  n: number
  sum: number
  max: number
}

export interface AgentBreak {
  /** 参与拆解的帧数（采样后） */
  sampled: number
  /** 各字段累计字节（按采样帧估算） */
  partialBytes: number
  messageBytes: number
  deltaBytes: number
  otherBytes: number
  totalBytes: number
  maxPartialBytes: number
  /** 拆解失败的次数（不许静默） */
  errors: number
}

const sizes = new Map<string, SizeStat>()
const agent: AgentBreak = {
  sampled: 0,
  partialBytes: 0,
  messageBytes: 0,
  deltaBytes: 0,
  otherBytes: 0,
  totalBytes: 0,
  maxPartialBytes: 0,
  errors: 0,
}

let frameSeq = 0
let sampleEvery = 10
/* ★1035 可观测性：**每帧 emit 成本**（重建全量投影 + 组装 dshMsg 的耗时）。
   与帧体积探针不同：这里**不做任何额外序列化**，所以可以常开——用来回答
   "合并窗口能不能降到 50/30ms"（算术题：emit 均值 × 频率 < 1 才算跟得上）。 */
const emitStat = { n: 0, sum: 0, max: 0 }
export function noteEmitCost(ms: number): void {
  const v = Number(ms) || 0
  emitStat.n += 1
  emitStat.sum += v
  if (v > emitStat.max) emitStat.max = v
}
/**
 * 探针总开关：默认**关闭**。
 * 为什么：量尺寸要对整帧 `JSON.stringify` 一次，等于把序列化成本翻倍 ——
 * 这是我自己差点引进来的性能回归（阶段0 只该在测量窗口开）。
 * 打开方式：`<数据根>/.ws-probe` 文件存在，或 NIS_PROBE=1。
 */
let enabled = false
export function setProbeEnabled(on: boolean): void {
  enabled = on
}
export function probeEnabled(): boolean {
  return enabled
}

export function setSampleEvery(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`setSampleEvery 非法: ${String(n)}`)
  sampleEvery = n
}

const byteLen = (v: unknown): number => {
  if (v === undefined || v === null) return 0
  try {
    return JSON.stringify(v).length
  } catch {
    return 0
  }
}

/**
 * 记一帧。
 * @param type 帧类型（老 MuxFrame 的 frame.type）
 * @param bytes 整帧实际写出的字节数（含 SSE 包装/JSON 信封）
 * @param frame 老帧本体（可选；给了才能做 agent-event 的字段拆解）
 */
export function noteFrame(type: string, bytes: number, frame?: unknown): void {
  if (!enabled) return
  const key = type || 'unknown'
  const cur = sizes.get(key) ?? { n: 0, sum: 0, max: 0 }
  cur.n++
  cur.sum += bytes
  if (bytes > cur.max) cur.max = bytes
  sizes.set(key, cur)

  if (key !== 'session/agent-event' || !frame) return
  frameSeq++
  if (frameSeq % sampleEvery !== 0) return

  try {
    const f = frame as { event?: unknown }
    const ev = f.event as { message?: unknown; assistantMessageEvent?: unknown } | undefined
    const ae = ev?.assistantMessageEvent as { partial?: unknown; delta?: unknown } | undefined
    const partialB = byteLen(ae?.partial)
    const msgB = byteLen(ev?.message)
    const deltaB = byteLen(ae?.delta)
    agent.sampled++
    agent.partialBytes += partialB
    agent.messageBytes += msgB
    agent.deltaBytes += deltaB
    agent.totalBytes += bytes
    agent.otherBytes += Math.max(0, bytes - partialB - msgB - deltaB)
    if (partialB > agent.maxPartialBytes) agent.maxPartialBytes = partialB
  } catch (e) {
    agent.errors++
    console.warn('[1035probe] agent-event 拆解失败:', String((e as Error)?.message || e))
  }
}

export interface ProbeSnapshot {
  frames: Record<string, { n: number; avg: number; max: number }>
  agentBreak: AgentBreak
  /** ★1035：每帧 emit 成本（毫秒）—— 决定合并窗口能压到多少的核心数据 */
  emit: { n: number; avgMs: number; maxMs: number }
}

export function readProbe(): ProbeSnapshot {
  const frames: ProbeSnapshot['frames'] = {}
  for (const [k, v] of sizes) frames[k] = { n: v.n, avg: Math.round(v.sum / Math.max(1, v.n)), max: v.max }
  return { frames, agentBreak: { ...agent }, emit: { n: emitStat.n, avgMs: Number((emitStat.sum / Math.max(1, emitStat.n)).toFixed(3)), maxMs: Number(emitStat.max.toFixed(3)) } }
}

export function resetProbe(): void {
  sizes.clear()
  frameSeq = 0
  agent.sampled = 0
  agent.partialBytes = 0
  agent.messageBytes = 0
  agent.deltaBytes = 0
  agent.otherBytes = 0
  agent.totalBytes = 0
  agent.maxPartialBytes = 0
  agent.errors = 0
  emitStat.n = 0
  emitStat.sum = 0
  emitStat.max = 0
}

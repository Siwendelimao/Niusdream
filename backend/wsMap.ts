/**
 * 1035 B-2 · 老帧 → 新协议帧的**唯一映射点**（纯函数，可单测）
 *
 * 为什么单独抽出来：
 *   它是"哪类帧算事实（要 seq 连续）、哪类算镜像（可覆盖可丢）"的唯一裁决处。
 *   放在 server.ts 里就只能靠肉眼验 —— 已经吃过一次亏：流式中间帧（expectFinal=false）
 *   本来就不入事件日志、没有 seq，我第一版把这种正常情况当成"上游违约"打了 error。
 *
 * 铁律落地：
 *   · 事实帧（入日志、有 seq）→ kind:'event'，客户端按 seq 判连续性
 *   · 流式中间态（expectFinal=false，不入日志）→ kind:'frame'，可丢、下一帧覆盖
 *   · 该是事实却**没有 seq** → 真正的违约：留 error，且**绝不编一个 seq**（降级成 frame 类）
 */

import type { DownKind } from './wsProtocol.ts'

export interface MuxFrameLike {
  type?: string
  sessionId?: string
  seq?: unknown
  expectFinal?: unknown
  [k: string]: unknown
}

export interface WsMappedFrame {
  v: number
  stream: 'session' | 'host'
  sid: string
  kind: DownKind
  seq?: number
  logEpoch: string
  payload: Record<string, unknown>
}

export interface MapOptions {
  sessionId: string
  frame: MuxFrameLike
  stream: 'session' | 'host'
  logEpoch: string
  protocolV: number
  /** 违约留痕回调（默认 console.error）。单独暴露是为了让测试能断言"该报的有没有报" */
  onViolation?: (message: string) => void
}

export function mapToWsFrame(opts: MapOptions): WsMappedFrame {
  const { sessionId, frame, stream, logEpoch, protocolV } = opts
  const report = opts.onViolation ?? ((m: string) => console.error(m))

  const type = String(frame.type || 'unknown')
  const sid = stream === 'host' ? '' : String(frame.sessionId || sessionId || '')
  const rawSeq = frame.seq
  const hasSeq = typeof rawSeq === 'number' && Number.isFinite(rawSeq)

  const isFactType = type === 'session/event'
  /* 流式中间态：后端注释（server.ts:8596-8608）写明 expectFinal===false 的帧**不入日志、不分配 seq**。
     这不是违约，是设计。只有 expectFinal===undefined 或 true 才算"该有 seq 的事实帧"。 */
  const isLiveDelta = isFactType && frame.expectFinal === false
  const isFact = isFactType && !isLiveDelta

  if (isFact && !hasSeq) {
    report(
      `[1035] 事实帧缺 seq（上游违约，已按 frame 类下发；session=${sid ? sid.slice(0, 8) : '(空)'} type=${type}）`,
    )
  }

  const kind: DownKind = isFact && hasSeq ? 'event' : 'frame'

  const out: WsMappedFrame = {
    v: protocolV,
    stream,
    sid,
    kind,
    logEpoch,
    /* payload 原样带上老帧字段（前端在迁移期还要读 payload.type / payload.value 等），
       type 显式补一次：老帧里 type 一定存在，但让类型上确定可见。 */
    payload: { ...frame, type },
  }
  if (isFact && hasSeq) out.seq = rawSeq as number
  return out
}

/* videoGen.ts —— 视频生成适配器（★1126）
 *
 * 与图片最大的不同：**上游是异步任务制**（实测 UnifyLLM + grok-imagine-video-1.5）：
 *   ① POST /videos/generations {model,prompt}   → 1.7s 返回 {"request_id":"task_xxx"}
 *   ② GET  /video/generations/{task_id}         → {status:"IN_PROGRESS", progress:"94%"}
 *   ③ 完成后                                    → {status:"SUCCESS", data:{video:{url, duration}}}
 *   ④ GET  {video.url}                          → video/mp4（实测 7.33MB，直链无鉴权）
 * 总耗时实测 ~140 秒（8 秒视频）。
 *
 * 所以这里**不阻塞**：只负责 submit / 查一次 / 下载，轮询循环与任务生命周期归 backgroundTasks 管。
 *
 * 轮询节奏按业界口径（腾讯云/火山引擎多篇接入实践一致）：起步 10s，60s 后放慢到 20~30s ——
 * 固定 1 秒一次纯属浪费配额。
 */
import fs from 'node:fs'
import path from 'node:path'
import { proxiedFetch } from './providers.ts'
import type { ResolvedMediaTarget } from './mediaTools.ts'

export interface VideoSubmitResult {
  /** 上游任务 id（task_xxx） */
  taskId: string
}

export type VideoPollState = 'pending' | 'running' | 'success' | 'failed'

export interface VideoPollResult {
  state: VideoPollState
  /** 原始状态串（IN_PROGRESS / SUCCESS / …），写进任务日志便于排查 */
  rawStatus: string
  /** 0~100 的整数百分比；拿不到就是 undefined（**不编**） */
  percent?: number
  /** 成功时的成品直链 */
  videoUrl?: string
  /** 视频秒数（上游给了才有） */
  duration?: number
  /** 失败原因 */
  failReason?: string
}

const SUBMIT_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/* ★1126：**上游支持的参数与取值** —— 全部来自实测报错信息（不是猜的）：
     · aspect_ratio  must be one of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9, 5:2
     · resolution    must be one of 480p, 720p, 1080p
     · duration      must be an integer between 1 and 15
     · image         接受 base64 dataURL（首帧图 / 图生视频）
   在本地先钳一遍，免得把非法值发给上游换一个 400 回来。 */
export const VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] as const
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
export const VIDEO_DURATION_MIN = 1
export const VIDEO_DURATION_MAX = 15

export interface VideoSubmitOpts {
  prompt: string
  /** 秒数，1~15（超出会被钳，不报错） */
  duration?: number
  /** 画面比例，必须是 VIDEO_ASPECT_RATIOS 之一 */
  aspectRatio?: string
  /** 分辨率，必须是 VIDEO_RESOLUTIONS 之一 */
  resolution?: string
  /** ★1126：**首帧图（图生视频）** —— base64 dataURL。
   *  上游实测会真的解码校验（传坏数据报 `invalid image image Base64`），
   *  所以这条是「图生视频」的正路：给它一张图当第一帧 + prompt 描述动作/镜头。 */
  image?: string
}

/** 把上游各种进度写法（94 / "94%" / "94.5"）统一成 0~100 整数 */
function parsePercent(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const m = /(\d+(?:\.\d+)?)/.exec(String(v))
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 提交生成任务 → 上游任务 id */
export async function submitVideo(target: ResolvedMediaTarget, opts: VideoSubmitOpts): Promise<VideoSubmitResult> {
  const prompt = String(opts.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const url = `${target.base}/videos/generations`
  const body: Record<string, unknown> = { model: target.modelId, prompt }

  /* 三个数值/枚举参数都先本地钳一遍（上游对非法值直接 400，没必要浪费一次往返） */
  if (opts.duration != null && Number.isFinite(Number(opts.duration))) {
    const d = Math.round(Number(opts.duration))
    body.duration = Math.max(VIDEO_DURATION_MIN, Math.min(VIDEO_DURATION_MAX, d))
  }
  if (opts.aspectRatio && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(opts.aspectRatio)) {
    body.aspect_ratio = opts.aspectRatio
  }
  if (opts.resolution && (VIDEO_RESOLUTIONS as readonly string[]).includes(opts.resolution)) {
    body.resolution = opts.resolution
  }
  /* 首帧图：必须是完整 dataURL（`data:image/png;base64,...`）；只给裸 base64 会被上游判 invalid */
  if (opts.image) {
    const img = String(opts.image)
    body.image = img.startsWith('data:') ? img : `data:image/png;base64,${img}`
  }

  const res = await proxiedFetch(target.proxyUrl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  })
  const txt = await res.text()
  if (!res.ok) throw new Error(`提交视频任务失败：HTTP ${res.status} ${txt.replace(/\s+/g, ' ').slice(0, 300)}`)
  let j: any
  try { j = JSON.parse(txt) } catch { throw new Error(`提交视频任务返回非 JSON：${txt.slice(0, 200)}`) }
  const taskId = String(j?.request_id || j?.task_id || j?.id || '')
  if (!taskId) throw new Error(`提交视频任务没拿到任务 id：${txt.slice(0, 200)}`)
  return { taskId }
}

/** 查一次任务状态（不轮询 —— 轮询节奏由调用方控制） */
export async function pollVideoOnce(target: ResolvedMediaTarget, taskId: string): Promise<VideoPollResult> {
  /* /video/generations/{id} 这条信息最全（有 status / progress / data.video.url） */
  const url = `${target.base}/video/generations/${encodeURIComponent(taskId)}`
  const res = await proxiedFetch(target.proxyUrl, url, {
    headers: { authorization: `Bearer ${target.apiKey}` },
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  })
  const txt = await res.text()
  if (!res.ok) {
    /* 查状态失败不直接判死：调用方会重试（网络抖动/网关 5xx 很常见） */
    throw new Error(`查询视频任务失败：HTTP ${res.status} ${txt.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  let j: any
  try { j = JSON.parse(txt) } catch { throw new Error(`查询视频任务返回非 JSON：${txt.slice(0, 200)}`) }

  const d = j?.data && typeof j.data === 'object' ? j.data : j
  const rawStatus = String(d?.status || j?.status || '').toUpperCase()
  const percent = parsePercent(d?.progress ?? j?.progress)
  const videoUrl = String(d?.data?.video?.url || d?.video?.url || d?.result_url || '')
  const duration = Number(d?.data?.video?.duration || d?.video?.duration) || undefined
  const failReason = String(d?.fail_reason || j?.fail_reason || '')

  let state: VideoPollState = 'pending'
  if (/SUCCESS|SUCCEEDED|COMPLETED|DONE/i.test(rawStatus)) state = 'success'
  else if (/FAIL|ERROR|CANCEL/i.test(rawStatus)) state = 'failed'
  else if (/PROGRESS|RUNNING|PROCESSING/i.test(rawStatus)) state = 'running'

  return {
    state,
    rawStatus,
    ...(percent !== undefined ? { percent } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    ...(duration ? { duration } : {}),
    ...(failReason ? { failReason } : {}),
  }
}

/** 流式下载成品到本地（**不走 base64**：实测 7.33MB，转 base64 再走 RPC 又慢又吃内存）。
 *  `onProgress(percent)` 可选 —— 有 Content-Length 才算，算不出就只报已下字节。 */
export async function downloadVideoTo(
  proxyUrl: string | undefined,
  videoUrl: string,
  destAbs: string,
  onProgress?: (info: { percent?: number; bytes: number }) => void,
): Promise<{ bytes: number }> {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true })
  const res = await proxiedFetch(proxyUrl, videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`下载成品失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0) || 0
  const body = res.body
  if (!body) throw new Error('下载成品失败：响应没有 body')

  const ws = fs.createWriteStream(destAbs)
  let got = 0
  let lastReport = 0
  try {
    /* Web ReadableStream → Node 写流（Node 18+ 的 fetch 返回 WHATWG ReadableStream） */
    const reader = (body as any).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      got += buf.length
      if (!ws.write(buf)) await new Promise<void>(r => ws.once('drain', () => r()))
      const now = Date.now()
      if (onProgress && now - lastReport > 1000) {
        lastReport = now
        onProgress({ ...(total ? { percent: Math.min(99, Math.round((got / total) * 100)) } : {}), bytes: got })
      }
    }
  } finally {
    await new Promise<void>(r => ws.end(() => r()))
  }
  if (!got) {
    try { fs.unlinkSync(destAbs) } catch { /* 空文件删掉 */ }
    throw new Error('下载成品失败：拿到 0 字节')
  }
  return { bytes: got }
}

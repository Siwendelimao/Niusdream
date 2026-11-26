/* imageGen.ts —— 生图适配器（★1126）
 *
 * 两种协议族，按 target.api 分派（由「端点形态」决定，不是猜模型能力）：
 *   ① openai-images     POST {base}/images/generations        —— OpenAI 官方 / 中转站 / 多数兼容网关
 *   ② chat-modalities   POST {base}/chat/completions + modalities:["image"] —— OpenRouter 那一族
 *
 * 统一出口：返回 **base64**（调用方只管落盘）。两种上游返回形态都在这里消化掉：
 *   · `b64_json`（OpenAI 规范）→ 直接用
 *   · `url`（UnifyLLM 实测返回这个）→ 后端下载转 base64（实测外链无鉴权、1.5MB PNG、3s）
 *   这不是兜底：OpenAI Images 规范本身就允许这两种响应形态。
 */
import { proxiedFetch } from './providers.ts'
import type { ResolvedMediaTarget } from './mediaTools.ts'

export interface GenerateImageRequest {
  prompt: string
  /** 如 1024x1024。留空 = 用供应商默认 */
  size?: string
  /** 张数，1~4（工具层已限） */
  n?: number
  /** 参考图（图生图）：base64 + mime。仅 chat-modalities 族支持 */
  refs?: Array<{ data: string; mimeType: string }>
}

export interface GeneratedImage {
  /** base64（不含 data: 前缀） */
  data: string
  mimeType: string
}

export interface GenerateImageResult {
  images: GeneratedImage[]
  /** 上游顺带返回的文字（有些模型出图同时给说明） */
  text?: string
}

const DEFAULT_TIMEOUT_MS = 180_000

/** 从 data URL / 纯 base64 里取出 {data,mimeType} */
function parseDataUrl(s: string): GeneratedImage {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(s || ''))
  if (m) return { mimeType: m[1], data: m[2] }
  return { mimeType: 'image/png', data: String(s || '') }
}

/** 按字节头判图片类型（下载回来的图没有可靠 mime 时的**事实判定**，不是猜） */
function mimeOfBuffer(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 11 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.length > 5 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  return 'image/png'
}

async function downloadAsBase64(proxyUrl: string | undefined, url: string): Promise<GeneratedImage> {
  const r = await proxiedFetch(proxyUrl, url, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok) throw new Error(`图片外链下载失败：HTTP ${r.status}（${String(url).slice(0, 120)}）`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error(`图片外链下载为空（${String(url).slice(0, 120)}）`)
  return { data: buf.toString('base64'), mimeType: mimeOfBuffer(buf) }
}

/** 非 2xx 统一成一句人话（带端点与响应片段，便于排查是"没权限"还是"参数不对"） */
async function fail(name: string, url: string, res: any): Promise<never> {
  let snippet = ''
  try { snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 400) } catch { /* 读不出就算了 */ }
  throw new Error(`${name}：HTTP ${res.status} ${snippet}\n端点：${url}`)
}

/** 把 `/images/generations` 与 `/images/edits` 的响应统一成 GeneratedImage[]
 *  （两者的返回形态一致：`data[].b64_json` 或 `data[].url`） */
async function parseImagesResponse(target: ResolvedMediaTarget, j: any, url: string): Promise<GeneratedImage[]> {
  const items: any[] = Array.isArray(j?.data) ? j.data : []
  if (!items.length) throw new Error(`接口没有返回图片：${JSON.stringify(j).slice(0, 300)}\n端点：${url}`)
  const out: GeneratedImage[] = []
  for (const it of items) {
    if (typeof it?.b64_json === 'string' && it.b64_json) out.push(parseDataUrl(it.b64_json))
    else if (typeof it?.url === 'string' && it.url) out.push(await downloadAsBase64(target.proxyUrl, it.url))
    else throw new Error(`响应里既没有 b64_json 也没有 url：${JSON.stringify(it).slice(0, 200)}`)
  }
  return out
}

/** ★1126：**图生图** —— POST {base}/images/edits（multipart/form-data）
 *  字段按 OpenAI 规范：model / prompt / image（多图用 image[]）/ size / n。
 *  ⚠️ 用 FormData 时**不能手动设 content-type**：boundary 由 fetch 自动生成，写死会 400。 */
export async function editImage(
  target: ResolvedMediaTarget,
  req: GenerateImageRequest & { refs: Array<{ data: string; mimeType: string }> },
  opts: { timeoutMs?: number } = {},
): Promise<GenerateImageResult> {
  const prompt = String(req.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  if (!req.refs?.length) throw new Error('图生图需要至少一张参考图')
  const url = `${target.base}/images/edits`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const fd = new FormData()
  fd.append('model', target.modelId)
  fd.append('prompt', prompt)
  const multi = req.refs.length > 1
  req.refs.forEach((r, i) => {
    const buf = Buffer.from(String(r.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (!buf.length) throw new Error(`第 ${i + 1} 张参考图是空的`)
    const ext = r.mimeType.includes('jpeg') ? 'jpg' : r.mimeType.includes('webp') ? 'webp' : 'png'
    /* 单图用 `image`、多图用 `image[]`（OpenAI 规范） */
    fd.append(multi ? 'image[]' : 'image', new Blob([buf], { type: r.mimeType }), `ref${i + 1}.${ext}`)
  })
  if (req.size) fd.append('size', req.size)
  if (req.n && req.n > 1) fd.append('n', String(req.n))

  const res = await proxiedFetch(target.proxyUrl, url, {
    method: 'POST',
    /* 只给鉴权头，content-type 交给 fetch（multipart boundary） */
    headers: { authorization: `Bearer ${target.apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) await fail('图生图失败', url, res)
  const j: any = await res.json()
  return { images: await parseImagesResponse(target, j, url) }
}

export async function generateImage(
  target: ResolvedMediaTarget,
  req: GenerateImageRequest,
  opts: { timeoutMs?: number } = {},
): Promise<GenerateImageResult> {
  const prompt = String(req.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` }

  if (target.api === 'openai-images') {
    if (req.refs?.length) {
      throw new Error(
        `供应商「${target.providerId}」的出图接口（/images/generations）不支持参考图。` +
        `需要图生图请换 OpenRouter 那类支持 chat+modalities 的供应商；或先用纯文字描述。`,
      )
    }
    const url = `${target.base}/images/generations`
    const body: Record<string, unknown> = { model: target.modelId, prompt }
    if (req.size) body.size = req.size
    if (req.n && req.n > 1) body.n = req.n
    const res = await proxiedFetch(target.proxyUrl, url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) await fail('生图失败', url, res)
    const j: any = await res.json()
    return { images: await parseImagesResponse(target, j, url) }
  }

  // ── chat-modalities：OpenRouter 一族 ──
  const url = `${target.base}/chat/completions`
  const content: any[] = [{ type: 'text', text: prompt }]
  for (const r of req.refs || []) {
    content.push({ type: 'image_url', image_url: { url: `data:${r.mimeType};base64,${r.data}` } })
  }
  const body = {
    model: target.modelId,
    messages: [{ role: 'user', content }],
    modalities: ['image'],
    stream: false,
  }
  const res = await proxiedFetch(target.proxyUrl, url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) await fail('生图失败', url, res)
  const j: any = await res.json()
  const msg = j?.choices?.[0]?.message || {}
  const rawImages: any[] = Array.isArray(msg.images) ? msg.images : []
  const out: GeneratedImage[] = []
  for (const it of rawImages) {
    const u = it?.image_url?.url ?? it?.url ?? (typeof it === 'string' ? it : '')
    if (!u) continue
    if (/^https?:/i.test(u)) out.push(await downloadAsBase64(target.proxyUrl, u))
    else out.push(parseDataUrl(u))
  }
  // 有些实现把图塞在 content 数组里（OpenAI 多模态返回形态）
  if (!out.length && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c?.type === 'image_url' && c?.image_url?.url) out.push(parseDataUrl(String(c.image_url.url)))
    }
  }
  if (!out.length) throw new Error(`生图接口没有返回图片：${JSON.stringify(j).slice(0, 300)}`)
  const text = typeof msg.content === 'string' ? msg.content : undefined
  return { images: out, ...(text ? { text } : {}) }
}

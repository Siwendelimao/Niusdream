/* mediaTools.ts —— 生成模型（生图 / 视频）的**唯一配置源**（★1126）
 *
 * 为什么单开一份文件、而不是塞进 providers.json：
 *   provider 表达的是「凭据 + 端点」（谁家、什么 key、什么代理），模型才是「能干什么」。
 *   把"用哪个模型出图"记在 provider 上会变成第二份使用层状态（每个会话/成员再选一次），
 *   用户要配 N 遍。这里只存**一个指针** `{providerId, modelId}`，key/base/代理全部复用 providers.json —— 
 *   既没有第二套凭据，也不会出现"同一个 OpenAI key 填两遍"。
 *
 * 纪律：本文件不做任何"猜"。
 *   · 配置了但模型不存在 / 类型不匹配 / 没 key → **抛明确错误**并指出该去哪修；
 *   · 没配置 → 抛"未配置"，由工具层原样转给模型（模型会去提示用户，不会瞎重试）。
 */
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, persistJson } from './jsonStore.ts'
import { getState, plainKeyById, endpointBase, resolveModelKind } from './providers.ts'

export type MediaKind = 'image' | 'video'

/** 生成模型的配置：只存指针，不存凭据 */
export interface MediaTargetRef {
  providerId: string
  modelId: string
}

export interface MediaToolsState {
  image?: MediaTargetRef
  video?: MediaTargetRef
}

const FILE = path.join(DATA_ROOT, 'media-tools.json')

/** 读配置（文件损坏走 jsonStore 的备份+降级，绝不静默当成"没配置"后覆盖用户设置） */
export function getMediaTools(): MediaToolsState {
  const r = loadJsonOrBackup<MediaToolsState>(FILE, () => ({}))
  const d = r.data && typeof r.data === 'object' ? r.data : {}
  const norm = (v: any): MediaTargetRef | undefined => {
    if (!v || typeof v !== 'object') return undefined
    const providerId = String(v.providerId || '').trim()
    const modelId = String(v.modelId || '').trim()
    return providerId && modelId ? { providerId, modelId } : undefined
  }
  return { image: norm(d.image), video: norm(d.video) }
}

/** 写配置（kind=null/空指针 = 清除该项）。写完回读返回最新状态。 */
export function setMediaTarget(kind: MediaKind, ref: MediaTargetRef | null): MediaToolsState {
  const cur = getMediaTools()
  const next: MediaToolsState = { ...cur }
  if (!ref || !ref.providerId || !ref.modelId) {
    delete next[kind]
  } else {
    /* 写入前先校验一次：宁可当场报错，也别把"选了个不能出图的模型"存进配置 —— 
       那种错会等到用户真去出图时才炸，且症状（400/无图）和配置错误看起来毫无关系。 */
    assertTargetUsable(kind, ref.providerId, ref.modelId)
    next[kind] = { providerId: ref.providerId, modelId: ref.modelId }
  }
  /* isEmpty 恒 false：这份文件永远有语义（confirm 默认值也是配置），不能因为"没配生图模型"就跳过写入。
     （jsonStore 的 isEmpty 是给"历史为空时拒绝回写"用的，这里不适用 —— 传错了会导致关掉开关后重启又弹卡。） */
  const ok = persistJson(FILE, next, { isEmpty: () => false })
  if (!ok) throw new Error(`写入 ${FILE} 失败（磁盘不可写？）`)
  return getMediaTools()
}

/** 解析出可调用的目标：base / key / 代理 / 用哪个适配器。未配置或不合法 → 明确错误。 */
export interface ResolvedMediaTarget extends MediaTargetRef {
  kind: MediaKind
  /** 已按协议剥好版本段的调用根（如 https://xxx/v1） */
  base: string
  apiKey: string
  proxyUrl: string
  protocol: string
  /** 生图适配器族：中转/OpenRouter 走 chat/completions + modalities，其余走 OpenAI 的 /images/generations */
  api: 'chat-modalities' | 'openai-images'
}

function assertTargetUsable(kind: MediaKind, providerId: string, modelId: string): void {
  const p = getState().providers.find(x => x.id === providerId)
  if (!p) throw new Error(`供应商「${providerId}」不存在 —— 请到「设置 → 供应商」添加`)
  if (!p.apiKey) throw new Error(`供应商「${p.name || p.id}」还没填 API Key —— 请到「设置 → 供应商」补上`)
  const m = (p.models || []).find(x => x.id === modelId)
  if (!m) throw new Error(`供应商「${p.name || p.id}」下没有模型「${modelId}」—— 请先在供应商卡片里「获取模型」或手动添加`)
  const actual = resolveModelKind(providerId, modelId)
  if (actual !== kind) {
    const label = kind === 'image' ? '生图' : '视频'
    throw new Error(
      `模型「${modelId}」当前类型是「${actual === 'text' ? '文本' : actual === 'image' ? '生图' : actual === 'video' ? '视频' : '语音'}」，` +
      `不能当${label}模型用 —— 请到「设置 → 供应商」打开该模型行右侧的 ✎，把「模型类型」改成「${label}」后保存`,
    )
  }
}

export function resolveMediaTarget(kind: MediaKind): ResolvedMediaTarget {
  const ref = getMediaTools()[kind]
  const label = kind === 'image' ? '生图' : '视频'
  if (!ref) {
    throw new Error(`还没配置${label}模型 —— 请到「设置 → 供应商 → 生成模型」里选一个可用的${label}模型`)
  }
  assertTargetUsable(kind, ref.providerId, ref.modelId)
  const p = getState().providers.find(x => x.id === ref.providerId)!
  const protocol = p.protocol || 'openai-completions'
  /* 生图端点是 /images/generations，跟"说话用哪个协议"不是一回事：
     UnifyLLM 说话走 openai-responses、出图仍是 OpenAI 风格 —— 所以 completions/responses 都放行。
     真正不支持的是 Anthropic / Gemini 原生（它们没有这个端点，作图接口形态完全不同）。 */
  if (protocol === 'anthropic-messages' || protocol === 'google-generative-ai') {
    throw new Error(
      `供应商「${p.name || p.id}」是 ${protocol} 原生协议，生成接口目前只接 OpenAI 形态的 /images/generations —— ` +
      `请换一家 OpenAI 兼容的供应商（OpenRouter / 聚合中转），或用该家自己的原生接口另行接入`,
    )
  }
  return {
    ...ref,
    kind,
    base: endpointBase(p.base, protocol),
    apiKey: plainKeyById(ref.providerId),
    proxyUrl: String((p as any).proxyUrl || ''),
    protocol,
    /* 适配器族判定：OpenRouter 的生图是「chat/completions + modalities:["image"]」，
       其余（OpenAI 官方 / 中转站 / 各家兼容网关）走 POST /images/generations。
       这不是猜模型能力，是**端点形态**——由 base 决定的协议事实。 */
    api: /openrouter\.ai/i.test(p.base || '') ? 'chat-modalities' : 'openai-images',
  }
}

/** 供设置页下拉用：把「所有供应商 × 能出该类内容的模型」平铺出来（只读，不写） */
export function listMediaCandidates(kind: MediaKind): Array<{ providerId: string; providerName: string; modelId: string; modelName: string }> {
  const out: Array<{ providerId: string; providerName: string; modelId: string; modelName: string }> = []
  for (const p of getState().providers) {
    if (!p.apiKey) continue                       // 没 key 的选了也发不出去，不列
    for (const m of p.models || []) {
      if (resolveModelKind(p.id, m.id) !== kind) continue
      out.push({ providerId: p.id, providerName: p.name || p.id, modelId: m.id, modelName: m.name || m.id })
    }
  }
  return out
}

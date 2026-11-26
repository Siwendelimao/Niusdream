/**
 * envSources —— 「软件环境」安装源**远程可配**。
 *
 * 为什么要有它：环境包（npm / Git Bash / 记忆模型）的下载地址原来**硬编码**在 server.ts 里。
 * 结果就是：想加一个自建 OSS 源、换一个镜像、或者镜像挂了要换 —— 全都得改后端 → **重新打 194MB 安装包** → 让所有用户重下。
 *
 * 现在的口径：
 *   ① 安装某项环境时，先拉一次 `ENV_SOURCES_URL`（托管在官网 gh-pages 的静态 JSON）；
 *   ② 拉到就用它给的源列表（**域名必须在 allowHosts 白名单内**，否则整份丢弃）；
 *   ③ 拉不到 / 校验不过 → 用本文件里的 `DEFAULT_SOURCES`（就是原来硬编码那份）；
 *   ④ 300 秒缓存，不每次安装都拉。
 *
 * ⚠️ 安全边界（必须守）：
 *   · 远程 JSON 能决定"从哪下什么"，被篡改就等于给用户塞任意二进制。所以：
 *     - `allowHosts` 同时写在**代码里**（`PINNED_HOSTS`）和远程里，**只取交集** —— 远程只能收窄，不能扩充；
 *     - 只允许 https；
 *     - 每项可选 `sha256`，给了就必须匹配，不匹配直接判失败（不落盘）。
 *   · 这是"配置下发"，不是"远程执行"：这里只能影响下载地址，不能带任何代码/命令。
 */

const ENV_SOURCES_URL = 'https://siwendelimao.github.io/Niusdream/env-sources.json'

/** 代码里钉死的主机白名单 —— 远程 JSON 只能在这个集合内选，无法扩充（防篡改） */
export const PINNED_HOSTS = [
  'siwendelimao.github.io',
  'github.com',
  'objects.githubusercontent.com',
  'registry.npmmirror.com',
  'registry.npmjs.org',
  'hf-mirror.com',
  'huggingface.co',
]

export interface EnvSourceItem {
  url: string
  label: string
  sha256?: string
}

export interface EnvSources {
  npm: EnvSourceItem[]
  gitbash: EnvSourceItem[]
  /** 记忆模型的 HuggingFace 端点（国内镜像优先） */
  embedHfEndpoint: string
  /** 是否来自远程（false = 用的内置兜底） */
  fromRemote: boolean
  /** 为什么没用远程（排查用） */
  note: string
}

/** 内置兜底 —— 与改造前硬编码的源**逐条一致**，保证远程不可达时行为不变 */
export const DEFAULT_SOURCES: EnvSources = {
  /* 版本号由 server.ts 的 NPM_VER / GITBASH_VER 拼，这里只放"源模板" */
  npm: [
    { url: 'https://registry.npmjs.org/npm/@@NPM@@.tgz', label: '官方源' },
    { url: 'https://registry.npmmirror.com/npm/@@NPM@@.tgz', label: 'npmmirror 镜像' },
  ],
  gitbash: [
    { url: 'https://github.com/git-for-windows/git/releases/download/v@@VER@@.windows.1/@@FILE@@', label: 'GitHub 官方' },
  ],
  embedHfEndpoint: 'https://hf-mirror.com',
  fromRemote: false,
  note: '内置兜底（未拉远程）',
}

let _cache: { at: number; v: EnvSources } | null = null
const CACHE_MS = 300_000

function hostOf(u: string): string {
  try { return new URL(u).hostname.toLowerCase() } catch { return '' }
}

/** 只认 https + 白名单主机 */
function safeUrl(u: unknown, allow: Set<string>): string {
  const s = String(u || '').trim()
  if (!/^https:\/\//i.test(s)) return ''
  const h = hostOf(s)
  return allow.has(h) ? s : ''
}

function normalize(raw: any, allow: Set<string>): EnvSources | null {
  if (!raw || typeof raw !== 'object') return null
  const pickList = (arr: any): EnvSourceItem[] => {
    if (!Array.isArray(arr)) return []
    const out: EnvSourceItem[] = []
    for (const it of arr) {
      const url = safeUrl(it?.url, allow)
      if (!url) continue
      out.push({
        url,
        label: String(it?.label || hostOf(url)).slice(0, 24),
        ...(typeof it?.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(it.sha256) ? { sha256: it.sha256.toLowerCase() } : {}),
      })
    }
    return out
  }
  const npm = pickList(raw.npm)
  const gitbash = pickList(raw.gitbash)
  const hfRaw = String(raw.embedHfEndpoint || '').trim()
  const hf = /^https:\/\//i.test(hfRaw) && allow.has(hostOf(hfRaw)) ? hfRaw : ''
  if (!npm.length && !gitbash.length && !hf) return null
  return {
    npm,
    gitbash,
    embedHfEndpoint: hf || DEFAULT_SOURCES.embedHfEndpoint,
    fromRemote: true,
    note: '远程配置（v=' + String(raw.version || '?') + '）',
  }
}

/**
 * 取环境源配置（带 300s 缓存；失败静默回落内置）。
 * 注意：**不抛错** —— 安装流程不应该因为"配置源挂了"而失败。
 */
export async function loadEnvSources(fetchImpl?: typeof fetch): Promise<EnvSources> {
  const now = Date.now()
  if (_cache && now - _cache.at < CACHE_MS) return _cache.v

  const doFetch = fetchImpl || globalThis.fetch
  let result: EnvSources = { ...DEFAULT_SOURCES }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await doFetch(ENV_SOURCES_URL, { signal: ctrl.signal, cache: 'no-store' } as any)
    clearTimeout(timer)
    if (!res.ok) {
      result = { ...DEFAULT_SOURCES, note: '远程配置 HTTP ' + res.status + '，用内置兜底' }
    } else {
      const raw = await res.json()
      /* 交集：远程的 allowHosts 只能**收窄**，不能扩充代码里钉死的那份 */
      const remoteAllow = Array.isArray(raw?.allowHosts) ? raw.allowHosts.map((x: any) => String(x).toLowerCase()) : []
      const allow = new Set(PINNED_HOSTS.filter(h => !remoteAllow.length || remoteAllow.includes(h)))
      const norm = normalize(raw, allow)
      result = norm || { ...DEFAULT_SOURCES, note: '远程配置不合法（主机不在白名单/无可用源），用内置兜底' }
    }
  } catch (e: any) {
    result = { ...DEFAULT_SOURCES, note: '远程配置拉取失败（' + String(e?.message || e).slice(0, 60) + '），用内置兜底' }
  }

  _cache = { at: Date.now(), v: result }
  return result
}

/** 清缓存（测试/调试用） */
export function resetEnvSourcesCache(): void { _cache = null }

/** 把模板里的 @@NPM@@ / @@VER@@ / @@FILE@@ 替换成实际版本 */
export function fillTemplate(u: string, vars: Record<string, string>): string {
  let out = u
  for (const [k, v] of Object.entries(vars)) out = out.split('@@' + k + '@@').join(encodeURIComponent(v))
  return out
}

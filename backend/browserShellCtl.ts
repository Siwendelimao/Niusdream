/**
 * 后端 ↔ 桌面壳（Electron 主进程）控制面客户端 —— C2 · driver='shell' 专用。
 *
 * 为什么要这份东西（都是实测结论，别再"猜"一遍）：
 *  - `_electron-probe/c2-attach/RESULT.md` P0-1/P0-7：attach 到 Electron 后 **`context.newPage()` 直接报错**
 *    （`Target.createTarget: Not supported` -32000）⇒ 新建页面只能请壳做。
 *  - P0-7：`Target.closeTarget` 会**真销毁 webContents**（不是"关标签页"）⇒ 关标签也必须请壳做。
 *  - P0-3：`setVisible(false)` 的 view 上 `page.screenshot()` 不可靠（静态页 1/4）⇒ 截图走壳的 /capture。
 *  - P0-2：`context.pages()` 里混着 UI 宿主页、顺序不稳 ⇒ 认领视图一律靠 preload 标记，禁止按索引猜。
 *
 * 壳侧实现（C2-a①，m1 的 `frontend/electron/shellCtl.cjs`，本文件按它写死并对齐）：
 *   GET  /health                       {ok,pid,uptimeMs,cdpPort,protocol}   免 token
 *   GET  /state?key=<key>              snapshot（含 realVisible/visible/url/title/viewId）
 *   GET  /list                         所有 view 的数组（key/url/title/visible/viewId…）
 *   POST /capture  {key,timeoutMs}     截图 → {ok,png:<base64>,bytes,width,height}（也可能回 file）
 *   POST /rebuild  {key,url,rect,profileDir}   按 key 重建 view（旧 webContents 会被销毁！）
 *   POST /ua /proxy /cookies           其余能力
 *   鉴权头：`x-nis-token`（除 /health）
 * 兼容：/tab/new、/tab/close、/view/ensure 是"多标签壳"才有的端点（C2-2），现在没有 ⇒ 被调时抛 not-found，
 *       由引擎按"单视图壳"语义降级（复用当前视图 / 明确拒绝），**绝不自己 newPage**。
 *
 * 描述文件（壳写、后端读，1s 缓存）：<DATA_ROOT>/browser-shell.json
 *   { cdpPort, port, ctlPort, token, pid, startedAt, version, protocol, cdpEnabled,
 *     dataRoot, profileRoot, marks:{globalName:'__NIS_MARK',viewKind:'view',uiKind:'ui'}, profileSessionSuffix:'Default' }
 *
 * 环境变量（回退开关**只有这一个**，别再加第二个）：
 *   NIS_BROWSER_DRIVER=local   → 强制本地内核（今天的行为）
 *   NIS_BROWSER_DRIVER=shell   → 强制桌面壳（壳没跑就明确报错，**绝不静默回退**）
 *   不设                       → 自动：有活着的壳就当 shell，否则 local（网页版永远走 local）
 *   NIS_BROWSER_SHELL_FILE=<path> → 覆盖描述文件路径（自检/联调用）
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { DATA_ROOT } from './paths.ts'

export type BrowserDriver = 'local' | 'shell'

export interface ShellDescriptor {
  cdpPort: number
  ctlPort: number
  token: string
  pid: number
  startedAt: number
  version: string
  /** 'view' / 'ui'（壳侧 marks.uiKind）：宿主页 kind 用这个值，认领时显式排除 */
  viewKind: string
  uiKind: string
  /** 壳侧 profile 的 session 子目录名（P0-4：必须指到 <key>/Default，否则静默 0 cookie） */
  profileSessionSuffix: string
  file: string
}

export type ShellCtlCode =
  | 'no-descriptor'      // 没找到描述文件 / pid 已死
  | 'no-cdp'             // 壳没开 CDP（cdpEnabled:false）⇒ 引擎根本 attach 不上
  | 'no-ctl-port'        // 壳没提供控制面端口
  | 'timeout'
  | 'not-found'          // 404/405：壳版本还没实现这个端点
  | 'http-error'
  | 'bad-json'
  | 'net'

export class ShellCtlError extends Error {
  code: ShellCtlCode
  endpoint: string
  status: number
  constructor(code: ShellCtlCode, message: string, endpoint = '', status = 0) {
    super(message)
    this.name = 'ShellCtlError'
    this.code = code
    this.endpoint = endpoint
    this.status = status
  }
}

/* ── 描述文件定位 ─────────────────────────────────────────────────────────── */

/** The owning shell passes an exact path to its sidecar. A standalone dev backend
 * uses its own data root. Never scan another installation/profile as a substitute. */
export function shellDescriptorPaths(): string[] {
  const envFile = String(process.env.NIS_BROWSER_SHELL_FILE || '').trim()
  return [envFile ? path.resolve(envFile) : path.join(DATA_ROOT, 'browser-shell.json')]
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) {
    return String(e?.code || '') === 'EPERM'   // 进程在但没权限发信号：也算活着
  }
}

function normalizeDescriptor(raw: any, file: string): ShellDescriptor | null {
  if (!raw || typeof raw !== 'object') return null
  const num = (v: any): number => {
    const n = typeof v === 'string' ? parseInt(v, 10) : Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  }
  const cdpPort = num(raw.cdpPort ?? raw.port ?? raw.remoteDebuggingPort)
  const ctlPort = num(raw.ctlPort ?? raw.controlPort ?? raw.httpPort)
  // 至少要有一样：只开控制面（没开 CDP）也算"壳在"，attach 时会明确报 no-cdp，绝不悄悄回退本地内核
  if (!cdpPort && !ctlPort) return null
  const marks = raw.marks && typeof raw.marks === 'object' ? raw.marks : {}
  return {
    cdpPort,
    ctlPort,
    token: String(raw.token || ''),
    pid: num(raw.pid),
    /* 壳侧写的是 ISO 字符串（main.cjs writeShellDescriptor）；也兼容毫秒数 */
    startedAt: (() => {
      const v: any = raw.startedAt
      if (typeof v === 'string' && v.trim() && !/^\d+$/.test(v.trim())) {
        const t = Date.parse(v)
        return Number.isFinite(t) ? t : 0
      }
      return num(v)
    })(),
    version: String(raw.version || ''),
    viewKind: String(marks.viewKind || 'view'),
    uiKind: String(marks.uiKind || 'ui'),
    profileSessionSuffix: String(raw.profileSessionSuffix || 'Default'),
    file,
  }
}

let cache: { at: number; desc: ShellDescriptor | null } | null = null
const CACHE_MS = 1000

/**
 * 读壳描述文件（1s 缓存）。
 * 判活口径：文件存在 + JSON 可解析 + 有 cdpPort/ctlPort + （有 pid 时）pid 还活着。
 * ⚠️ 有进程但 CDP/控制面探不通的情况**不在这里**判死（要联网探），交给 probeShellCdp / shellCtl 报错。
 */
export function readShellDescriptor(force = false): ShellDescriptor | null {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.desc
  let found: ShellDescriptor | null = null
  for (const file of shellDescriptorPaths()) {
    try {
      if (!fs.existsSync(file)) continue
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const d = normalizeDescriptor(raw, file)
      if (!d) continue
      const samePath = (a: string, b: string) => {
        const norm = (s: string) => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s)
        return norm(a) === norm(b)
      }
      if (!raw.dataRoot || !samePath(String(raw.dataRoot), DATA_ROOT)) continue
      const parentPid = Number(process.env.NIS_PARENT_PID || 0)
      if (parentPid && d.pid !== parentPid) continue
      if (!pidAlive(d.pid)) continue
      found = d
      break
    } catch { /* 单个候选读失败就试下一个 */ }
  }
  cache = { at: Date.now(), desc: found }
  return found
}

/** 清缓存（壳重启后想让后端立刻看到新端口时用） */
export function clearShellDescriptorCache(): void { cache = null }

/**
 * 驱动判定（唯一入口）。
 *  · 显式 NIS_BROWSER_DRIVER=local/shell ⇒ 照办（local 就是回退开关）
 *  · 不设 ⇒ 恒 shell（1107 起 local 已下线：内核与 agent-reach 均已删除）
 * ⚠️ 「壳没跑」的判定只看描述文件；一旦判成 shell，后面 attach 失败必须**报错**，
 *    不许回到 local（否则人看 A、AI 操作 B —— 最危险的失败模式，见施工设计 D5）。
/**
 * 1107 变更：默认不再回落到 local。
 *   原因：local 用的 Chromium 内核已随换壳下线删除（省 698MB），回落只会得到
 *   「executablePath 找不到」这种看不懂的错误。宁可直接说「把桌面客户端跑起来」。
 *   NIS_BROWSER_DRIVER=local 仍保留（显式请求，browserEngine 里有内核检查会给明确提示）。
 */
export function resolveDriver(): BrowserDriver {
  const forced = String(process.env.NIS_BROWSER_DRIVER || '').trim().toLowerCase()
  if (forced === 'local' || forced === 'shell') return forced
  return 'shell'  /* 1107：local 已下线（内核删除），默认恒 shell；壳没跑时由 startShell 给明确报错 */
}

/** 当前是否有活着的壳（给状态展示用，纯同步、不联网） */
export function shellPresence(): { present: boolean; file: string; cdpPort: number; ctlPort: number } {
  const d = readShellDescriptor()
  return { present: !!d, file: d?.file || '', cdpPort: d?.cdpPort || 0, ctlPort: d?.ctlPort || 0 }
}

/* ── HTTP 底座（CDP 探活 + 控制面共用）──────────────────────────────────── */

function httpJson(port: number, method: 'GET' | 'POST', pathname: string, body: any, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = method === 'POST' ? Buffer.from(JSON.stringify(body || {}), 'utf-8') : null
    const req = http.request(
      {
        host: '127.0.0.1', port, path: pathname, method, agent: false, timeout: timeoutMs,
        headers: Object.assign(
          payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {},
          headers || {},
        ),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          const code = res.statusCode || 0
          if (code === 404 || code === 405) return reject(new ShellCtlError('not-found', `${method} ${pathname} → HTTP ${code}（壳未实现该端点）`, pathname, code))
          if (code >= 400) return reject(new ShellCtlError('http-error', `${method} ${pathname} → HTTP ${code} ${text.slice(0, 200)}`, pathname, code))
          try { resolve(text ? JSON.parse(text) : {}) } catch { reject(new ShellCtlError('bad-json', `${method} ${pathname} 返回非 JSON：${text.slice(0, 120)}`, pathname, code)) }
        })
      },
    )
    req.on('timeout', () => { req.destroy(new ShellCtlError('timeout', `${method} ${pathname} 超时 ${timeoutMs}ms（壳主进程可能被卡住）`, pathname)) })
    req.on('error', (e: any) => reject(e instanceof ShellCtlError ? e : new ShellCtlError('net', `${method} ${pathname} 失败：${String(e?.message || e)}`, pathname)))
    req.end(payload || undefined)
  })
}

/** 探活：CDP 的 /json/version 有响应才算壳体真的在（描述文件可能是崩溃残留） */
export async function probeShellCdp(cdpPort: number, timeoutMs = 3000): Promise<{ browser: string; webSocketDebuggerUrl: string }> {
  if (!cdpPort) throw new ShellCtlError('no-cdp', '壳描述文件里没有 cdpPort（壳以 --no-cdp 启动？）：引擎无法 attach。请用默认方式启动桌面客户端')
  try {
    const v = await httpJson(cdpPort, 'GET', '/json/version', null, {}, timeoutMs)
    return { browser: String(v?.Browser || ''), webSocketDebuggerUrl: String(v?.webSocketDebuggerUrl || '') }
  } catch (e: any) {
    throw new ShellCtlError('net', `壳的 CDP 端口 ${cdpPort} 探活失败（${String(e?.message || e)}）。桌面壳可能没开/已退出/端口被占`)
  }
}

/* ── 控制面 ─────────────────────────────────────────────────────────────── */

function descOrThrow(desc?: ShellDescriptor | null): ShellDescriptor {
  const d = desc === undefined ? readShellDescriptor() : desc
  if (!d) throw new ShellCtlError('no-descriptor', '壳未运行（读不到 browser-shell.json / 进程已退）')
  if (!d.ctlPort) throw new ShellCtlError('no-ctl-port', `壳没提供控制面端口（${d.file} 里没有 ctlPort）：该壳版本只支持 CDP attach，不支持建视图/截图/列表`)
  return d
}

const authHeaders = (d: ShellDescriptor): Record<string, string> => (d.token ? { 'x-nis-token': d.token } : {})

/** GET 控制面（m1 的壳用 GET /state、GET /list） */
export async function shellCtlGet(pathname: string, timeoutMs = 2000, desc?: ShellDescriptor | null): Promise<any> {
  const d = descOrThrow(desc)
  return await httpJson(d.ctlPort, 'GET', pathname, null, authHeaders(d), timeoutMs)
}

/** POST 控制面 */
export async function shellCtlPost(pathname: string, body: Record<string, any> = {}, timeoutMs = 5000, desc?: ShellDescriptor | null): Promise<any> {
  const d = descOrThrow(desc)
  return await httpJson(d.ctlPort, 'POST', pathname, body, authHeaders(d), timeoutMs)
}

/**
 * 通用调用：`paths` 可给多个候选端点名，**只在 not-found 时**换下一个
 * （避免"其实已执行"的重放：/tab/new 之类不幂等的端点尤其要小心）。
 */
export async function shellCtl(paths: string | string[], body: Record<string, any> = {}, opts: { timeoutMs?: number; desc?: ShellDescriptor | null; method?: 'GET' | 'POST' } = {}): Promise<any> {
  const list = Array.isArray(paths) ? paths : [paths]
  const timeoutMs = opts.timeoutMs || 5000
  const method = opts.method || 'POST'
  let last: any = null
  for (const p of list) {
    try {
      return method === 'GET' ? await shellCtlGet(p, timeoutMs, opts.desc) : await shellCtlPost(p, body, timeoutMs, opts.desc)
    } catch (e: any) {
      last = e
      if (e instanceof ShellCtlError && e.code === 'not-found') continue
      throw e
    }
  }
  throw last instanceof Error ? last : new ShellCtlError('not-found', '没有可用的控制面端点')
}

/* ── 语义化封装（引擎只用这几个；端点名改一处即可）───────────────────────── */

export interface ShellViewInfo {
  /** 壳侧的 view key（= 后端 sessionId） */
  key: string
  /** 壳侧的 view 编号（browserHost 的 viewId；多标签壳将来还会有 tabId） */
  viewId: string
  tabId: string
  url: string
  title: string
  active: boolean
  /** 壳侧真实可见性（realVisible 优先）——截图通道选择题就靠它 */
  visible: boolean
}

function normalizeViewItem(v: any, fallbackKey: string): ShellViewInfo | null {
  if (!v || typeof v !== 'object') return null
  const key = String(v.key || fallbackKey || '')
  if (!key) return null
  const viewId = String(v.viewId || '')
  const tabId = String(v.tabId || viewId || 'main')
  return {
    key,
    viewId,
    tabId,
    url: String(v.url || ''),
    title: String(v.title || ''),
    active: !!(v.active ?? v.attached ?? false),
    visible: v.realVisible !== undefined && v.realVisible !== null ? !!v.realVisible : !!v.visible,
  }
}

function normalizeViewList(raw: any, fallbackKey: string): ShellViewInfo[] {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.views) ? raw.views : (Array.isArray(raw?.list) ? raw.list : []))
  const out: ShellViewInfo[] = []
  for (const v of list) {
    const item = normalizeViewItem(v, fallbackKey)
    if (item) out.push(item)
  }
  return out
}

/**
 * 壳里的视图列表（含"人手动开的"那些——引擎自己看不到它们，否则 AI 会以为浏览器里只有它开的页）
 * 主用 `GET /list`（m1 的实现）；没有就退回 `/views` 之类的候选。
 */
export async function shellViews(key: string, timeoutMs = 2000): Promise<ShellViewInfo[]> {
  let raw: any
  try { raw = await shellCtlGet('/list', timeoutMs) } catch (e: any) {
    if (e instanceof ShellCtlError && e.code === 'not-found') raw = await shellCtl(['/views', '/view/list'], { key }, { timeoutMs })
    else throw e
  }
  const all = normalizeViewList(raw, '')
  return key ? all.filter((v) => v.key === key || v.key === '') : all
}

/** 单个 view 快照（可见性判定 / 排查用） */
export async function shellState(key: string, timeoutMs = 1500): Promise<ShellViewInfo | null> {
  try {
    const raw = await shellCtlGet('/state?key=' + encodeURIComponent(key), timeoutMs)
    return normalizeViewItem(raw, key)
  } catch { return null }
}

export interface ShellShot { data: string; mime: string; width: number; height: number; ms: number }

/**
 * 壳侧截图通道（隐藏 view 唯一可靠出画；P0-3：capturePage 9~28ms、5/5 成功）。
 * 必须带超时：壳内部自带硬超时（默认 5s），这里再兜一层，绝不能让工具队列挂死。
 */
export async function shellShot(key: string, timeoutMs = 8000, tabId?: string): Promise<ShellShot> {
  const r = await shellCtl('/capture', { key, tabId, timeoutMs: Math.min(Math.max(timeoutMs - 500, 500), 20000) }, { timeoutMs })
  if (r && r.ok === false) {
    throw new ShellCtlError('http-error', `壳截图失败：${String(r.reason || 'unknown')}${r.error ? '（' + String(r.error) + '）' : ''}`, '/capture')
  }
  const data = String(r?.png || r?.data || r?.base64 || '')
  if (!data) throw new ShellCtlError('bad-json', '壳截图返回空数据', '/capture')
  return {
    data,
    mime: String(r?.mime || 'image/png'),
    width: Number(r?.width) || 0,
    height: Number(r?.height) || 0,
    ms: Number(r?.ms) || 0,
  }
}

/**
 * 新建视图/标签。
 * ⚠️ 当前壳（C2-a①）**没有**多标签能力 ⇒ 这里抛 not-found，由引擎降级成"复用当前视图"；
 *    等到 C2-2 壳加了 `/tab/new` 就自动生效（调用方不用改）。
 * 🔴 绝不能用 `/rebuild` 冒充新建——它会先 destroy 旧 view（旧 webContents 直接销毁，引擎手里的 page 变废纸）。
 */
export async function shellNewTab(key: string, url: string, profileDir: string, timeoutMs = 15000, background = false): Promise<{ tabId: string }> {
  const r = await shellCtl(['/tab/new', '/view/new', '/new-tab'], { key, url, profileDir, background }, { timeoutMs })
  const tabId = String(r?.tabId || r?.id || '')
  if (!tabId) throw new ShellCtlError('bad-json', '壳建了视图但没回 tabId', '/tab/new')
  return { tabId }
}

/** 关闭视图/标签（必须请壳做：P0-7 说 closeTarget 会绕过壳真销毁 webContents） */
export async function shellCloseTab(key: string, tabId: string, timeoutMs = 8000): Promise<void> {
  await shellCtl(['/tab/close', '/view/close', '/close-tab'], { key, tabId }, { timeoutMs })
}

/**
 * 确保该会话有视图（面板没打开 / 视图被外部关掉时给 AI 用）。
 * 顺序：先查 /list —— 已有就不动（`/rebuild` 会销毁旧 view，绝不能乱调）；确实没有才 /view/ensure（未来）
 * 或 `/rebuild` 建一个（这是壳支持的"按 key 复活"语义，browserHost.rebuild）。
 */
export async function shellEnsureView(key: string, url: string, profileDir: string, timeoutMs = 8000): Promise<{ tabId: string }> {
  try {
    const existing = await shellViews(key, 1500)
    if (existing.length) return { tabId: existing[0].tabId }
  } catch { /* 查不到就往下试 */ }
  try {
    const r = await shellCtl(['/view/ensure', '/ensure'], { key, url, profileDir }, { timeoutMs })
    return { tabId: String(r?.tabId || r?.id || '') }
  } catch (e: any) {
    if (!(e instanceof ShellCtlError && e.code === 'not-found')) throw e
  }
  // 壳只支持 rebuild（=按 key 销毁并重建）——只在"确认没有 view"之后才走到这里
  const r2 = await shellCtlPost('/rebuild', { key, url, profileDir }, timeoutMs)
  if (r2 && r2.ok === false) throw new ShellCtlError('http-error', `壳重建视图失败：${String(r2.reason || 'unknown')}`, '/rebuild')
  return { tabId: String(r2?.viewId || 'main') }
}

/** 壳侧 profile 的 session 目录（P0-4：必须指到 <key>/Default，否则静默 0 条 cookie） */
export function shellSessionDir(profileDir: string, desc?: ShellDescriptor | null): string {
  const d = desc === undefined ? readShellDescriptor() : desc
  const suffix = (d && d.profileSessionSuffix) || 'Default'
  return path.join(profileDir, suffix)
}

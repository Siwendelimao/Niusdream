/**
 * 内置浏览器引擎（0905 七批起按会话隔离）——每个对话窗口一个独立实例（独立 Chromium profile/标签页/登录态）。
 *
 * 设计对齐 docs/handover/HANDOVER-20260905-浏览器.md：
 *  - launchPersistentContext → data/browser-profile/<sessionKey>（会话隔离的持久登录态）；
 *  - 多标签（Page），activeTabId 跟随；导航/前进后退/刷新/停止/截图/cookies；
 *  - PC/移动/自适应视口走 CDP Emulation（热切换）；'auto' 跟随面板尺寸；
 *  - input() 为人接管反传原语（click/key/insertText/hover/wheel/down/up…）；
 *  - onFrame 钩子按实例挂 CDP screencast（server 按 sessionId 广播给对应前端桶）；
 *  - idle 计时：有观看者挂起，离开视图起算 90s 自动 close 释放 Chromium。
 * 渲染/反爬/直播参数（render/cast）是全局共享（设置页改一次全体生效）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import {
  readShellDescriptor, resolveDriver, probeShellCdp, shellPresence, ShellCtlError,
  shellViews, shellShot, shellNewTab, shellCloseTab, shellEnsureView, shellCtlPost,
  type BrowserDriver, type ShellDescriptor,
} from './browserShellCtl.ts'
import { DATA_ROOT } from './paths.ts'
import { CdpBrowserClient, WebviewCdpPage, listWebviewTargets } from './browserWebview.ts'

const PROFILE_BASE = path.join(DATA_ROOT, 'browser-profile')
const IDLE_MS = 90_000

/* ★ 0921b 修「浏览器点启动**还是**失败」（用户 0.0.18 复测）—— 真因是**赋值时机**，不是路径没设：
   server.ts 里 `process.env.PLAYWRIGHT_BROWSERS_PATH = envDir` 那行**确实执行了**
   （证据：后端子进程能继承到该变量），但 **playwright-core 在模块加载那一刻就把 registry
   缓存目录算好并缓存了** —— ESM 静态 `import` 全部提升到文件顶部，那行赋值永远晚于 import
   ⇒ 启动仍去 `%LOCALAPPDATA%\ms-playwright` 找，报
   `Executable doesn't exist at C:\...\ms-playwright\chromium_headless_shell-1234\...`。
   实测坐实（`backend/_probe_pw_envorder.mjs`，先清掉继承来的变量）：
     先 import 再设 env  → chromium.executablePath() = <用户目录>\...\AppData\Local\ms-playwright\...  ✗
     先设 env 再 import  → chromium.executablePath() = <测试环境目录>\env\chromium-1234\chrome-win64\...    ✓
   ⇒ 修法：**别让 playwright 自己找内核**。启动时按 envDir 显式解析 `executablePath`
   （安装 / 探测 / 启动三方同源），既不依赖 env 生效时机，也不依赖 playwright 版本。
   server 那行 env 赋值**继续保留** —— 装内核的 playwright CLI 是**子进程**，它靠这个变量定位。 */
let browserEnvDir = ''
/** server 启动 / 设置变更时同步进来（= 设置里的「环境安装目录」envDir） */
export function setBrowserEnvDir(dir: string): void { browserEnvDir = String(dir || '').trim() }

/** 在 envDir 里扫出 Chromium 可执行文件；找不到返回 ''（调用方不传 executablePath，退回 playwright 默认解析） */
function resolveChromiumExe(headless: boolean): string {
  const dir = (browserEnvDir || String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim())
  if (!dir) return ''
  try {
    if (!fs.existsSync(dir)) return ''
    const isShell = (n: string) => n.startsWith('chromium_headless_shell') || n.startsWith('chromium-headless-shell')
    // 无头优先 headless-shell（官方为无头裁剪，启动更快）；找不到再退完整版 chrome.exe（也支持 headless）
    const exeNames = headless ? ['chrome-headless-shell.exe', 'chrome.exe'] : ['chrome.exe']
    const cands = fs.readdirSync(dir)
      .filter((n) => n.startsWith('chromium'))
      .filter((n) => (headless ? true : !isShell(n)))   // 有头模式绝不用 headless-shell
      .sort((a, b) => Number(isShell(b) === headless) - Number(isShell(a) === headless))
    for (const d of cands) {
      const base = path.join(dir, d)
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub)
        try { if (!fs.statSync(p).isDirectory()) continue } catch { continue }
        for (const exe of exeNames) {
          const f = path.join(p, exe)
          if (fs.existsSync(f)) { console.log('[browser] chromium exe → ' + f); return f }
        }
      }
    }
  } catch { /* 目录读不动 = 当作没装，交给 playwright 默认解析兜底 */ }
  return ''
}

interface BrowserTabInfo { id: string; title: string; url: string; active: boolean; isHome?: boolean }
interface ViewportPreset { key: string; label: string; width: number; height: number; dpr: number; mobile: boolean; touch: boolean; userAgent: string }

/** 设备下拉预设（前端只发 key；'auto'=跟随面板尺寸） */
export const VIEWPORTS: Record<string, ViewportPreset> = {
  auto: { key: 'auto', label: '自适应', width: 1280, height: 800, dpr: 1, mobile: false, touch: false, userAgent: '' },
  pc: { key: 'pc', label: 'PC', width: 1280, height: 800, dpr: 1, mobile: false, touch: false, userAgent: '' },
  iphone15: { key: 'iphone15', label: 'iPhone 15', width: 393, height: 852, dpr: 3, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  ipad: { key: 'ipad', label: 'iPad', width: 820, height: 1180, dpr: 2, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile/15E148 Safari/604.1' },
  pixel7: { key: 'pixel7', label: 'Pixel 7', width: 412, height: 915, dpr: 2.6, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
}

/** CDP 直播帧回调（server 注入，帧经 broadcastMux 带 sessionId 推给对应前端桶） */
type FrameCb = (tabId: string, jpegBase64: string, meta: { width: number; height: number }) => void

/** 渲染/直播参数。
 *  ★1117：**不再可注入** —— `setRenderOpts` / `setCastOpts` / `getCastMinIntervalMs` 已删除
 *  （唯一调用方是设置页那套在壳模式下不生效的配置）。这里保留常量默认值，
 *  因为 local 兜底路径（`NIS_BROWSER_DRIVER=local`，虽内核已下线）与 CDP 投屏仍读它们。 */
interface BrowserRenderOpts { stealth: boolean; blockMedia: boolean; gpu: boolean; proxy: string }
interface BrowserCastOpts { fps: number; quality: number; scale: number; everyNthFrame: number }
const render: BrowserRenderOpts = { stealth: true, blockMedia: false, gpu: false, proxy: '' }
const cast: BrowserCastOpts = { fps: 11, quality: 60, scale: 2, everyNthFrame: 1 }

/** ★1011k：代理地址解析（既定的口径：设置页填了就走代理，不填=直连）。
 *  接受 `127.0.0.1:7890` 与 `http://user:pass@host:port` 两种写法：
 *   · 没写协议 → 补 http://（本机代理多是 http）
 *   · 带凭据 → 必须拆成 server/username/password（Playwright 不认 server 里的 user:pass，会整条连不上）
 *  解析不出来就返回 undefined（当直连）——宁可直连，也不要因为一个手滑的地址把浏览器启动整个搞崩。 */
export function parseProxyUrl(raw: string): { server: string; username?: string; password?: string } | undefined {
  const s = String(raw || '').trim()
  if (!s) return undefined
  /* ★1011j2：想**彻底绕过系统代理**时填 `direct`（Chromium 认 direct://）——
     Chromium 默认跟随 Windows 系统代理，所以"不填"=跟随系统代理，不等于"直连"。 */
  if (/^direct:?\/?\/?$/i.test(s)) return { server: 'direct://' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return undefined
    /* ★1011k：主机名体检 —— `!!!` 这类乱填在 WHATWG URL 里**不会抛异常**（会变成 "http://!!!/"），
       原样交给 Chromium 会启动失败（实测踩过）。只放行常规域名/IPv4/IPv6 字面量。 */
    if (!/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/i.test(u.hostname)) return undefined
    const server = `${u.protocol}//${u.host}`
    const username = u.username ? decodeURIComponent(u.username) : ''
    if (!username) return { server }
    return { server, username, password: decodeURIComponent(u.password || '') }
  } catch { return undefined }
}

/** 反自动化检测注入（stealth 开关控制） */
const STEALTH_INIT_SRC = `
try {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en-US','en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  window.chrome = window.chrome || { runtime: {}, loadTimes: function(){}, csi: function(){} };
  var __qp = navigator.permissions && navigator.permissions.query && navigator.permissions.query.bind(navigator.permissions);
  if (__qp) { navigator.permissions.query = function(par){ return (par && par.name === 'notifications') ? Promise.resolve({ state: (self.Notification && Notification.permission) || 'default' }) : __qp(par); }; }
} catch (e) {}
`

/** 实例注册表：sessionKey → 实例（前端对话窗口与 AI 各按 sessionId 取自己的） */
const instances = new Map<string, BrowserInstance>()
const viewportSessions = new WeakMap<object, any>()   // page → CDP 会话（按 page 复用）★0927 netfix：WeakMap
  // —— 页面关闭后随 Page 对象自动回收；原 Map 强引用会把已关闭页面和 CDP 会话永久攥住（泄漏）

const normUrl = (x: string): string => String(x || '').replace(/\/+$/, '')

/** C2：给 promise 加超时（壳侧探活/连接/截图一律不许无界等待，否则浏览器工具队列会被冻住） */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${what} 超时 ${ms}ms`)) }, ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}


/** 实例创建钩子（0905 十五批）：server 注册，给每个新实例挂 onAutoModeChange 广播 */
let instanceHook: ((inst: BrowserInstance) => void) | null = null
export function setInstanceHook(cb: ((inst: BrowserInstance) => void) | null): void { instanceHook = cb }

export function getBrowserInstance(sessionId?: string): BrowserInstance {
  const key = String(sessionId || 'default')
  let inst = instances.get(key)
  if (!inst) {
    inst = new BrowserInstance(key)
    instances.set(key, inst)
    try { instanceHook?.(inst) } catch { /* ignore */ }
  }
  return inst
}

/** 0908③：已创建的实例列表（设置页聚合全部会话的 cookie 用——浏览器按会话隔离后，
 *  不带 sessionId 的 cookiesList 只查 'default' 实例恒空=用户看到"Cookie 0"的根因） */
export function allInstances(): BrowserInstance[] {
  return Array.from(instances.values())
}

export class BrowserInstance {
  readonly key: string
  private context: BrowserContext | null = null
  private tabs: { id: string; page: Page }[] = []
  private activeTabId = ''
  private homeUrl = ''   // 默认首页（start 时由前端传设置默认页；关到最后一个 tab 自动回此页）
  /** ★1011k：实际生效的代理（launch 参数）。变化时必须重启实例才生效，start 里据此判断 */
  private appliedProxy = ''
  private starting: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /* ★0927 R15：观看挂起的**硬上限** —— pauseIdle 后若观众异常断开（前端崩了/直接关窗，
     没调 resumeIdle/unwatch），watching 会卡死 ⇒ Chromium 实例永久占用。
     挂起最长 2 小时，到点恢复 idle（不硬杀；真有人连续看 2 小时以上的场景近乎不存在，
     而重新打开面板会再 pauseIdle 重置本计时）。前端重开面板 watch 会重置计时 ⇒ 不影响正常使用。 */
  private watchCapTimer: ReturnType<typeof setTimeout> | null = null
  private watching = false   // 有观看者期间挂起 idle（0905 五批）
  controlledBy: 'user' | 'ai' | '' = ''   // 占用权（0905 四批）
  private viewportKey = 'pc'
  private customViewport: { width: number; height: number } | null = null
  /** 关闭前记录的标签 URL（0905 八批"释放而非关闭"：idle/刷新后重开时恢复之前的页面） */
  private restoreUrls: string[] = []
  onFrame: FrameCb | null = null
  private screencastSession: { cdp: any; tabId: string } | null = null
  /** 页面 console/pageerror 环形缓冲（wb_console） */
  consoleBuf: string[] = []
  /** 有头/无头（per-instance：0905 十一批，会话 A 切有头过验证不影响会话 B） */
  mode: 'headed' | 'headless' = 'headless'
  /* ── C2 · driver 双轨：'local' = 今天的本地内核 / 'shell' = attach 到桌面壳里的视图 ── */
  /** 驱动的"已生效"值（由 start() 每次判定；status 里会带出去，方便排查"到底操作的是谁"） */
  driver: BrowserDriver = 'local'
  /** driver==='shell' 时：是否真的连上了壳并认领到本会话的 view */
  attached = false
  private shellBrowser: Browser | null = null
  private shellDesc: ShellDescriptor | null = null
  /** 连壳失败的原文（工具层原样告诉模型/用户，不许含糊成"启动失败"） */
  private lastShellError = ''
  /** 已认领的 view page（按对象身份；壳重建 view 后旧对象会自然淘汰） */
  /** tabId → CDP targetId（壳侧重启/重建时对账用） */

  /** 主动关闭标志（0905 十四批：区分用户点有头窗口 × 的意外关闭） */
  private closingIntentionally = false
  /** 0908②修复回归：context 正在死亡（窗口被点×/close()）——期间 page close 不再 ensureHome/落快照，
   *  否则关最后一个 tab 会当场复活首页（有头窗弹回来）+ 用只剩首页的快照覆盖好数据（tab 全丢） */
  private contextDying = false
  /** 自动切回无头时通知（0905 十五批：server 注册，广播 status 帧让前端图标同步） */
  onAutoModeChange: ((mode: 'headed' | 'headless') => void) | null = null
  /** 标签增删/激活变化通知（0908②：server 注册，广播 browser/tabs 帧——有头手动开的页也能即时进面板） */
  onTabsChange: (() => void) | null = null

  /** 标签快照落盘（0905 十四批：进程重启/应用重开后打开旧对话仍能恢复之前的标签） */
  private get snapshotPath(): string { return path.join(this.profileDir, 'tabs.json') }
  private persistTabsSnapshot(): void {
    try {
      const tabs = this.listTabs().filter(t => t.url && t.url !== 'about:blank')
      if (!tabs.length) return
      fs.writeFileSync(this.snapshotPath, JSON.stringify({ urls: tabs.map(t => t.url), active: (tabs.find(t => t.active) || tabs[0]).url, savedAt: Date.now() }), 'utf-8')
    } catch { /* ignore */ }
  }
  private readTabsSnapshot(): { urls: string[]; active?: string } | null {
    try {
      const d = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf-8'))
      if (Array.isArray(d?.urls) && d.urls.length) return d
    } catch { /* ignore */ }
    return null
  }

  constructor(key: string) { this.key = key }

  private get profileDir(): string {
    // default 实例沿用历史目录（保留既有登录态），其余按会话隔离
    return this.key === 'default' ? PROFILE_BASE : path.join(PROFILE_BASE, this.key.replace(/[^\w-]/g, '_'))
  }

  private touchIdle() {
    if (this.watching) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.context) this.idleTimer = setTimeout(() => { void this.close().catch(() => {}) }, IDLE_MS)
  }

  /** 观看者在场：挂起 idle（有人看着就不自动关） */
  pauseIdle(): void {
    this.watching = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    /* ★0927 R15：硬上限 2 小时——观众异常断开没解挂起时兜底释放（防 Chromium 永久占用）；
       到点仅恢复 idle（90s 后才关），前端重开面板会重置本计时，不影响正常长时间观看 */
    if (this.watchCapTimer) clearTimeout(this.watchCapTimer)
    this.watchCapTimer = setTimeout(() => {
      console.warn(`[browser] 观看挂起已达 2 小时硬上限，恢复 idle（实例 ${this.key}）`)
      this.watching = false
      this.touchIdle()
    }, 2 * 60 * 60 * 1000)
  }
  /** 离开视图：恢复 idle，从现在起算 90s */
  resumeIdle(): void {
    this.watching = false
    if (this.watchCapTimer) { clearTimeout(this.watchCapTimer); this.watchCapTimer = null }
    this.touchIdle()
  }
  private tabId(page: Page): string {
    const existing = this.tabs.find(t => t.page === page)
    if (existing) return existing.id
    const id = 'tab-' + Math.random().toString(36).slice(2, 9)
    this.tabs.push({ id, page })
    // console 消息环形缓冲（wb_console 工具读，AI 调试 SPA 报错用）
    if (!(page as any).__nisConsoleHooked) {
      ;(page as any).__nisConsoleHooked = true
      try {
        page.on('console', (msg: any) => {
          try {
            const line = `[${msg.type()}] ${String(msg.text()).slice(0, 300)}`
            this.consoleBuf.push(line)
            if (this.consoleBuf.length > 200) this.consoleBuf.splice(0, this.consoleBuf.length - 200)
          } catch { /* ignore */ }
        })
        page.on('pageerror', (err: Error) => {
          try {
            this.consoleBuf.push(`[pageerror] ${String(err?.message || err).slice(0, 300)}`)
            if (this.consoleBuf.length > 200) this.consoleBuf.splice(0, this.consoleBuf.length - 200)
          } catch { /* ignore */ }
        })
      } catch { /* ignore */ }
    }
    return id
  }

  private syncActive(page: Page) {
    const id = this.tabId(page)
    if (id !== this.activeTabId) { this.activeTabId = id; if (this.onFrame) void this.restartScreencast() }
  }

  /** 统一标签收养（0908②）：context 里出现的任何页面——引擎 newPage、有头窗口用户手动 Ctrl+T、
   *  点击 _blank 链接（含 window.open）——都经此进入账本。此前只靠 newTab/restore 三处手动注册，
   *  手动 tab 不进 tabs → listTabs/restoreUrls/tabs.json 全不含它 = "手动开的不进列表、切走再切回就没了"。
   *  幂等：newPage 的 await 与 context 'page' 事件先后不定，同一 page 二次进入直接返回既有 id。 */
  private adoptPage(pg: Page): string {
    const existing = this.tabs.find(t => t.page === pg)
    if (existing) return existing.id
    const id = this.tabId(pg)
    pg.on('close', () => {
      this.tabs = this.tabs.filter(t => t.page !== pg)
      if (!this.tabs.some(t => t.id === this.activeTabId)) {
        this.activeTabId = this.tabs[0]?.id || ''
        if (this.onFrame) void this.restartScreencast()
      }
      if (this.contextDying) return   // 整窗关闭中：不广播不补首页（见 contextDying 注释）
      try { this.onTabsChange?.() } catch { /* ignore */ }
      // ⚠ 这里绝不 persistTabsSnapshot：点 × 关窗时 Chromium 逐页发 close，若每次落盘
      // 会把快照逐步覆盖成"只剩最后一个/零个 tab"（0908②回归实锤：无头恢复后 tab 全丢）。
      // 快照的写入点=navigate/newTab/closeTab/switchTab（用户关掉的旧 tab 若残留在快照里，
      // 下次恢复会复活它——既有语义，自愈于下次导航）。
      // 用户手动关掉最后一个标签也要自动回首页（此前只有程序性 closeTab 会兜）。
      // 0908②回归修复：有头窗口点 × 时页面 close 先于 context close 触发，立即 ensureHome
      // 会在垂死 context 上抢开新窗（=用户看到的"关掉又弹出默认页有头窗"）。延迟 1.2s 复查：
      // context 还活着才补首页。
      if (!this.tabs.length && this.context) {
        setTimeout(() => {
          if (this.context && this.isRunning() && !this.tabs.length) void this.ensureHome()
        }, 1200)
      }
    })
    // 手动新开的页也要吃到当前视口预设（否则 _blank 弹窗保持原生尺寸，auto 档下与面板画面不一致）
    void this.applyViewport(this.viewportKey, pg).catch(() => {})
    // 0908②补：adopt 瞬间手动页常还是 about:blank（被 persist 过滤），真实 URL 要等加载——
    // 主框架导航事件里节流落快照，否则有头点 × 后 tabs.json 缺手动页最终 URL=恢复丢失。
    let navPersistTimer: ReturnType<typeof setTimeout> | null = null
    pg.on('framenavigated', (frame: any) => {
      if (frame !== pg.mainFrame()) return
      if (navPersistTimer) return
      navPersistTimer = setTimeout(() => {
        navPersistTimer = null
        try { this.persistTabsSnapshot() } catch { /* ignore */ }
      }, 600)
    })
    this.persistTabsSnapshot()
    try { this.onTabsChange?.() } catch { /* ignore */ }
    return id
  }

  /** 若已无标签页（关到最后一个），自动开一个默认首页 tab */
  private async ensureHome(): Promise<void> {
    if (!this.context || this.tabs.length) return
    if (this.driver === 'shell') return   // 页归壳所有：引擎 newPage 会 -32000（P0-1）
    try {
      const page = await this.context.newPage()
      const id = this.adoptPage(page)
      this.activeTabId = id
      if (this.homeUrl && this.homeUrl !== 'about:blank') await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    } catch { /* ignore */ }
  }

  private getTab(tabIdArg?: string): Page {
    if (!this.context) {
      /* C2-a③：shell 驱动下，真因必须带出来（壳没跑 / 描述文件死在 / 认领失败），
         否则调用方只看到"未就绪"，会误以为是模式切换、白等一轮。 */
      if (this.driver === 'shell' && this.lastShellError) {
        throw new Error(this.lastShellError + '（driver=shell：不要再重试 wb_*，先把桌面壳跑起来）')
      }
      throw new Error('浏览器未就绪（可能正在切换有头/无头模式）。最多再试一次；若仍失败，请放弃浏览器操作，直接告知用户"浏览器暂不可用"，不要反复重试')
    }
    if (tabIdArg) {
      const t = this.tabs.find(x => x.id === tabIdArg)
      if (t) return t.page
      /* C2：shell 里存在但引擎没认领的视图（例如壳刚建、mark 还没就绪）——绝不能悄悄落到当前页，
         否则 AI 以为在操作 A 页，实际动了 B 页。 */
      if (this.driver === 'shell') throw new Error('标签页 ' + tabIdArg + ' 未连上（壳里存在但引擎未认领）。请用 wb_list_tabs 重新取 tabId，不要复用旧 id')
    }
    const a = this.tabs.find(x => x.id === this.activeTabId)
    if (a) return a.page
    if (this.tabs.length) { this.activeTabId = this.tabs[0].id; return this.tabs[0].page }
    throw new Error('没有可用的标签页')
  }

  /** 供 server：激活页或抛错（人机反传/AI 工具共用） */
  requirePage(): Page { return this.getTab() }
  tryGetTab(): Page | null { try { return this.getTab() } catch { return null } }

  isRunning(): boolean { return this.context !== null }
  currentStatus() {
    /* ★C2：driver/attached 必须显式报出去——排查"AI 到底在操作谁"全靠这两个字段。
       未连接时按当前环境重新判定（壳可能刚起/刚退），但不改实例的已生效状态。 */
    const drv: BrowserDriver = this.context ? this.driver : resolveDriver()
    const base: Record<string, any> = {
      connected: !!this.context,
      mode: this.mode,
      viewport: this.viewportKey,
      tabs: this.listTabs(),
      activeTabId: this.activeTabId,
      driver: drv,
      attached: drv === 'shell' ? !!(this.attached && this.context) : !!this.context,
    }
    if (drv === 'shell') {
      base.viewKey = this.key
      base.cdpPort = this.shellDesc?.cdpPort || shellPresence().cdpPort
      base.viewportOwner = 'shell'
      base.frames = 'shell-native'
      if (this.lastShellError) base.shellError = this.lastShellError
    }
    return base
  }

  listTabs(): BrowserTabInfo[] {
    return this.tabs.map(t => {
      let url = '', title = ''
      try { url = t.page.url() } catch { /* page closed */ }
      // isHome：默认首页标签（AI 口径里"打开的第 N 个网站"不该把它数进去）；去尾斜杠归一化比较
      const norm = (x: string) => x.replace(/\/+$/, '')
      return { id: t.id, url, title, active: t.id === this.activeTabId, isHome: !!this.homeUrl && norm(url) === norm(this.homeUrl) }
    })
  }

  getHomeUrl(): string { return this.homeUrl }

  /* ═══════════════════════════════════════════════════════════════════════════
     C2 · driver='shell'（桌面壳）—— 引擎不 launch，attach 到壳里的 WebContentsView
     依据：C2-施工设计.md 第 2/3 节 + _electron-probe/c2-attach/RESULT.md（本机实测 P0-1/2/3/6/7）
     铁律：
       D1 local 路径原样保留（今天的行为一行不动：网页版 / 没开桌面端就是它）
       D4 同一 profile 目录只允许一方持有 ⇒ shell 模式【绝不】launchPersistentContext
       D5 壳不在 / 连不上 ⇒ 明确报错，绝不静默回退 local（"人看 A、AI 操作 B"是最危险的失败）
       D6 标签页归壳所有：新建/关闭都走壳控制面（P0-1：Target.createTarget 不支持 -32000）
     ═══════════════════════════════════════════════════════════════════════════ */

  /** shell 模式的 start()：attach（探活→连接→认领）；失败清理干净再抛，绝不留半连状态 */
  private async startShell(homeGiven: boolean): Promise<void> {
    this.lastShellError = ''
    this.attached = false
    try {
      await this.attachShell(homeGiven)
      this.attached = true
    } catch (e: any) {
      this.lastShellError = String(e?.message || e)
      await this.detachShellQuietly()
      throw e
    }
    this.touchIdle()
  }

  /** 只断连接：不杀壳、不销毁 view（P0-6 实测 browser.close() 不杀 Electron；view 归壳所有） */
  private async detachShellQuietly(): Promise<void> {
    const b = this.shellBrowser
    this.shellBrowser = null
    this.context = null
    this.tabs = []
    this.activeTabId = ''
    if (b) { try { await b.close() } catch { /* ignore */ } }
  }

  /** 读描述文件 → /json/version 探活 → connectOverCDP → 靠 preload 标记认领本会话的 view */
  private async attachShell(homeGiven: boolean): Promise<void> {
    const desc = readShellDescriptor(true)
    if (!desc) {
      throw new Error('[shell] 读不到活着的桌面壳（browser-shell.json 缺失或壳进程已退出）。壳没在跑时不允许悄悄改用本地内核——那会变成两份浏览器（人看 A、AI 操作 B）。请打开桌面客户端；确实要走本地内核请显式设 NIS_BROWSER_DRIVER=local')
    }
    this.shellDesc = desc
    await probeShellCdp(desc.cdpPort, 3000)
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + desc.cdpPort, { timeout: 20000 })
    const ctx = browser.contexts()[0]
    if (!ctx) {
      try { await browser.close() } catch { /* ignore */ }
      throw new Error('[shell] CDP 连上了但拿不到 browser context（壳版本过旧？）')
    }
    this.shellBrowser = browser
    this.context = ctx
    browser.on('disconnected', () => {
      // 壳退出 / 连接断：状态必须立刻清空，不能让上层误以为还连着（工具会再报"不可用"）
      this.attached = false
      this.context = null
      this.tabs = []
      this.activeTabId = ''
    })
    let claimed = await this.claimShellViews()
    if (!claimed) {
      /* 该会话还没有在屏 view（面板没打开）：尽力请壳建一个；
         壳不支持（404）就走到下面的明确报错——"后台 offscreen 宿主"是 C2-6 的活，本轮不做静默兜底。 */
      try { await shellEnsureView(this.key, this.homeUrl || '', this.profileDir) } catch { /* ignore */ }
      /* C2-a3 联调实测：壳刚 /rebuild 出来的 view，webContents 要 ~200~800ms 才出现在 CDP 目标列表、
         preload 的 __NIS_MARK 还要再等一下。原来只重试一次 ⇒ 会误报"视图未就绪"。退避重试到 3s。 */
      const claimDeadline = Date.now() + 3000
      while (!claimed && Date.now() < claimDeadline) {
        await new Promise((r) => setTimeout(r, 250))
        claimed = await this.claimShellViews()
      }
    }
    if (!claimed) {
      throw new Error('[shell] 已连上壳，但认领不到本会话的浏览器视图（壳侧 view 未创建 / 没带 __NIS_MARK 标记）。不要再调 wb_* 重试，直接告知用户"浏览器视图未就绪"')
    }
    const desired = String(this.homeUrl || '').trim()
    const hasHome = desired && desired !== 'about:blank' && this.tabs.some((t) => normUrl(this.safeUrl(t.page)) === normUrl(desired))
    if (homeGiven && desired && desired !== 'about:blank' && !hasHome) {
      try {
        const r = await shellNewTab(this.key, desired, this.profileDir)
        await this.claimShellViews()
        if (r.tabId && this.tabs.some((t) => t.id === r.tabId)) this.activeTabId = r.tabId
      } catch { /* 首页落地属锦上添花，失败不阻断 attach */ }
    }
    try { this.onTabsChange?.() } catch { /* ignore */ }
  }

  private safeUrl(pg: Page): string { try { return pg.url() } catch { return '' } }

  /** view 里的 mark.key 与实例 key 对齐（壳侧可能做过目录名归一化，两边都按同一规则比） */
  private keyMatches(k: string): boolean {
    const a = String(k || '').trim()
    const b = String(this.key || '').trim()
    if (!a) return false
    if (a === b) return true
    const norm = (x: string) => x.replace(/[^\w-]/g, '_')
    return norm(a) === norm(b)
  }

  /* ★1111 清理：readViewMark / targetIdOf 原本只服务 playwright 认领路径，
     新版直接在 WebviewCdpPage 里用 Runtime.evaluate 读 __NIS_MARK，这两个方法已无调用方。 */

  /** ★1110v：CDP 客户端（连 shell 的 browser endpoint；webview target 只能这样操作） */
  private cdpClient: CdpBrowserClient | null = null
  private async ensureCdpClient(): Promise<CdpBrowserClient | null> {
    const desc = this.shellDesc
    if (!desc) return null
    if (this.cdpClient && !this.cdpClient.isClosed) return this.cdpClient
    try {
      const r = await fetch('http://127.0.0.1:' + desc.cdpPort + '/json/version')
      const j: any = await r.json()
      const wsUrl = String(j?.webSocketDebuggerUrl || '')
      if (!wsUrl) return null
      const c = new CdpBrowserClient(wsUrl)
      await c.connect(8000)
      this.cdpClient = c
      return c
    } catch { return null }
  }

  /** 认领视图（幂等）。返回是否至少认领到一个。
   *  ★1110v（浏览器面板改 webview 之后）：playwright 的 context.pages() **看不到 webview**
   *  （它只枚举 type:"page"），所以改走 raw CDP：
   *    ① /json/list 拿 type:"webview" 的 target
   *    ② Target.attachToTarget(flatten) 拿 session
   *    ③ 读页面里的 __NIS_MARK（browserViewPreload.cjs 注入）确认是本会话的视图
   *    ④ 用 WebviewCdpPage 包装成 Page 的形状后收养
   *  认领判据仍然是 preload 标记 —— **绝不按 URL/顺序猜**（宿主 UI 页也是 page，猜错会去操作主界面）。 */
  private async claimShellViews(): Promise<boolean> {
    const desc = this.shellDesc
    if (!desc) return false
    const cdp = await this.ensureCdpClient()
    if (!cdp) return false
    let targets: Array<{ targetId: string; url: string }> = []
    try { targets = await listWebviewTargets(desc.cdpPort) } catch { return false }
    let n = 0
    for (const t of targets) {
      try {
        /* 去重要看 tab.page.targetId —— tabs 里存的是 { id, page }，targetId 挂在 page 上 */
        const already = this.tabs.find((x: any) => x?.page?.targetId === t.targetId)
        if (already) { n++; continue }
        const page = new WebviewCdpPage(cdp, t.targetId)
        await page.attach()
        await page.refreshViewport()
        const raw = await page.evaluate('JSON.stringify((typeof window!=="undefined"&&window.__NIS_MARK)||null)').catch(() => 'null')
        let mark: any = null
        try { mark = JSON.parse(String(raw || 'null')) } catch { mark = null }
        if (!mark) continue                                  // 没标记：不是我们的视图（或 preload 没装）
        if (mark.kind && mark.kind !== 'view') continue       // kind==='ui'（宿主页）一律排除
        if (!this.keyMatches(mark.key)) continue              // 不是本会话
        const id = String(mark.tabId || ('wv-' + t.targetId.slice(0, 8)))
        ;(page as any).targetId = t.targetId
        this.adoptShellPage(page as any, id)
        n++
      } catch { /* 单个 view 失败不影响其它 */ }
    }
    if (n && !this.tabs.some((t) => t.id === this.activeTabId)) this.activeTabId = this.tabs[0]?.id || ''
    return n > 0
  }

  /* ★1111 清理：原 claimShellViewsLegacy（走 playwright pages() 认领）已整段删除 ——
     webview 生效后 pages() 里根本没有目标，这段没有任何调用方，属于死代码。 */

  /** 收养壳的 view：tabId 用壳给的（不是随机 id），其余钩子复用既有收养逻辑（tabId→console 缓冲） */
  private adoptShellPage(pg: any, id: string): void {
    const existed = this.tabs.some((t) => t.page === pg)
    this.tabId(pg)
    const t = this.tabs.find((x) => x.page === pg)
    if (t && t.id !== id) {
      const wasActive = this.activeTabId === t.id
      t.id = id
      if (wasActive) this.activeTabId = id
    }
    if (existed) return
    pg.on('close', () => {
      this.tabs = this.tabs.filter((x) => x.page !== pg)
      if (!this.tabs.some((x) => x.id === this.activeTabId)) this.activeTabId = this.tabs[0]?.id || ''
      try { this.onTabsChange?.() } catch { /* ignore */ }
      /* shell 模式不 ensureHome：页归壳所有（P0-7：Target.closeTarget 会真销毁 webContents，
         该不该重建由壳决定，引擎自己 newPage 必然失败 -32000） */
    })
  }

  /** 与壳对账视图（AI 开页 / 人手动开页 / 壳重建之后都调一次） */
  async refreshShellTabs(): Promise<void> {
    if (this.driver !== 'shell' || !this.context) return
    await this.claimShellViews()
    // UI focus and the AI's operation target are independent. A user changing
    // tabs must not redirect the next automation action to their current page.
  }

  /**
   * 异步版标签列表（工具层用）：shell 模式先对账，再合并壳的视图列表——
   * 否则 AI 看不到"人手动开的页"（施工设计第 3 节 #16）。
   */
  async listTabsFresh(): Promise<BrowserTabInfo[]> {
    if (this.driver !== 'shell') return this.listTabs()
    try { await this.refreshShellTabs() } catch { /* ignore */ }
    const tabs = this.listTabs()
    try {
      for (const v of await shellViews(this.key, 1500)) {
        if (tabs.some((t) => t.id === v.tabId)) continue
        tabs.push({ id: v.tabId, url: v.url, title: v.title, active: v.active && !tabs.some((t) => t.active) })
      }
    } catch { /* ignore */ }
    return tabs
  }

  /**
   * 壳侧截图：**首选壳的后台截图通道**（POST /capture = view 级 capturePage + 壳内硬超时）。
   * P0-3 实测：隐藏的静态页上 page.screenshot 只有 1/4 成功、第 2 张必超时；而壳侧 capturePage 5/5、9~28ms。
   * 所以顺序是「壳通道 → 可见页 page.screenshot 兜底 → 明确报错」，两条都带超时。
   */
  private async shellScreenshot(p: Page, tabIdArg: string | undefined, type: 'png' | 'jpeg', quality: number): Promise<{ data: string; mime: string; width: number; height: number }> {
    const tabId = tabIdArg || this.tabs.find(t=>t.page===p)?.id
    if(!tabId) throw Error('截图目标没有明确标签身份')
    const r = await shellShot(this.key,8000,tabId)
    this.touchIdle()
    return {data:r.data,mime:r.mime,width:r.width,height:r.height}
  }

  /** 设备模拟（Emulation.setDeviceMetricsOverride）在 attach 下能否生效属"待实测"⇒ 返回结果而不是断言成功 */
  private async applyViewportEmulation(key: string): Promise<boolean> {
    const page = this.tryGetTab()
    if (!page) return false
    const preset = VIEWPORTS[key] || VIEWPORTS.pc
    /* ★1119af（实测根因）：shell 模式的 page 是 `WebviewCdpPage`（鸭子类型），
       而下面那段走的是 **playwright** 的 `ctx.newCDPSession(page)` —— 传鸭子对象必抛，
       被 setViewport 的 try/catch 吞成 applied=false ⇒ 工具恒回"壳视图不支持设备模拟"。
       实际壳完全支持：本类有自己的 CDP 会话，直接下发目标级 Emulation 即可。
       ⇒ 按 driver 分流（结构性分支，不是兜底）：shell 用 page 自带会话，local 用 playwright。 */
    if (this.driver === 'shell') {
      const tabId = this.tabs.find(t => t.page === page)?.id
      if (!tabId) return false
      const r = await shellCtlPost('/device', { key:this.key, tabId, device:preset.mobile?'mobile':'pc', viewport:preset.mobile?{width:preset.width,height:preset.height,dpr:preset.dpr,userAgent:preset.userAgent}:{} })
      return r?.ok === true
    }
    const ctx = this.context
    if (!ctx) return false
    let cdp: any = viewportSessions.get(page as any)
    if (!cdp) { cdp = await ctx.newCDPSession(page); viewportSessions.set(page as any, cdp) }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: preset.width, height: preset.height, deviceScaleFactor: preset.dpr, mobile: preset.mobile })
    if (preset.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: preset.userAgent })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: preset.touch, maxTouchPoints: preset.touch ? 5 : 0 }).catch(() => {})
    return true
  }

  /** 启动（幂等）；mode 变化需重启才生效 */
  async start(opts?: { mode?: 'headed' | 'headless'; home?: string }): Promise<void> {
    /* ★0930：显式带 home 的启动=用户点启动，首页必须真落地（见下方恢复分支） */
    const homeGiven = typeof opts?.home === 'string' && !!String(opts.home).trim()
    if (homeGiven) this.homeUrl = String(opts.home).trim()
    this.closingIntentionally = false
    this.contextDying = false
    /* ★1011k：代理变了同样要重启实例（代理是 launch 参数，不重启就不生效）——
       否则用户改完设置再点"启动"，走的还是老路由，又是一次"设置了没用"。 */
    const proxyChanged = !!this.context && this.appliedProxy !== String(render.proxy || '').trim()
    if (this.context) { if ((opts?.mode && opts.mode !== this.mode) || proxyChanged) { await this.close(); } else { this.touchIdle(); return } }
    if (this.starting) { await this.starting; return }
    this.mode = opts?.mode ?? this.mode
    /* ★C2：每次启动重新判定 driver（壳可能刚起/刚退；显式 NIS_BROWSER_DRIVER=local 永远优先）。
       换轨时先把旧引擎放掉——同一 profile 目录同一时刻只允许一方持有（施工设计 D4）。 */
    const nextDriver = resolveDriver()
    if (nextDriver !== this.driver) {
      if (this.context) { try { await this.close() } catch { /* ignore */ } }
      this.driver = nextDriver
    }
    this.starting = (async () => {
      // shell：不 launch，只 attach（D1/D6）
      if (this.driver === 'shell') { await this.startShell(homeGiven); return }
      try { fs.mkdirSync(this.profileDir, { recursive: true }) } catch { /* ignore */ }
      /* 1107：local 内核已下线（data/env 里没有 chromium 了）。显式走 local 时给明确错误，
         而不是让 playwright 抛「executablePath 找不到」这种看不懂的话。 */
      const localExe = resolveChromiumExe(this.mode === 'headless')
      if (!localExe) {
        throw new Error('内置浏览器暂时不可用：本地内核已随桌面版换壳下线。请启动 NiusDream 桌面客户端后再使用浏览器功能。')
      }
      const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-infobars']
      args.push(render.gpu ? '--enable-gpu' : '--disable-gpu')
      if (render.blockMedia) args.push('--autoplay-policy=user-gesture-required')
      /* 1107：agent-reach 技能已下线（连同 opencli Browser Bridge 扩展一起删了）⇒ 不再加载浏览器扩展。
         将来若需要扩展能力注意：Electron 壳侧 session.loadExtension 在 MV3 下 service worker 不启动
         （C2 探针 P0-5 实测，Electron issue #34178）。 */
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        // 0921b：显式指定内核（envDir 里那套），不再依赖 playwright 的缓存目录推断
        /* 1107：local 内核已下线（data/env 里没有 chromium 了）。
           显式 NIS_BROWSER_DRIVER=local 时要给明确错误，而不是让 playwright 抛「executablePath 找不到」。 */
        executablePath: localExe,
        headless: this.mode === 'headless',
        viewport: null,
        userAgent: render.stealth ? ua : undefined,
        locale: 'zh-CN',
        /* ★1011k：代理（设置页可填，空=直连）。只在 launch 时生效 ⇒ start 里检测到变化会重启实例 */
        proxy: parseProxyUrl(render.proxy),
        args,
      })
      this.appliedProxy = String(render.proxy || '').trim()
      if (render.stealth) { try { await this.context.addInitScript({ content: STEALTH_INIT_SRC }) } catch { /* ignore */ } }
      if (render.blockMedia) {
        try { await this.context.route('**/*', (route: any) => { const t = route.request().resourceType(); return t === 'media' ? route.abort() : route.continue() }) } catch { /* ignore */ }
      }
      this.context.on('close', () => {
        this.contextDying = true
        this.context = null; this.tabs = []; this.activeTabId = ''
        // 0905 十四批：有头窗口被用户直接点 × 关掉（非程序性关闭）→ 自动切回无头并恢复标签
        if (!this.closingIntentionally && this.mode === 'headed') {
          this.mode = 'headless'
          void this.start({ mode: 'headless' })
            .then(() => { try { this.onAutoModeChange?.('headless') } catch { /* ignore */ } })
            .catch(() => {})
        }
      })
      // 0908②(a/b)：收养 context 里出现的一切页面——有头窗口用户手动 Ctrl+T / 页面 window.open
      // 产生的新窗口都走这里进账本（此前无人监听 → 手动 tab 不进 tabs 列表，面板不显示、
      // close 时 restoreUrls 也不含它 = "手动开的不进列表、切走再回来没了"）。幂等，不抢激活。
      this.context.on('page', (pg: Page) => { try { this.adoptPage(pg) } catch { /* ignore */ } })
      // 0905 八批"释放而非关闭"：内存快照 → 磁盘快照 → 默认首页，三级恢复
      const memRestore = this.restoreUrls.splice(0)
      const snap = this.readTabsSnapshot()
      const restore = memRestore.length ? memRestore : (snap?.urls || [])
      if (restore.length) {
        // 激活页：内存快照=第一个；磁盘快照=按 active url 匹配（匹配不到则第一个兜底）
        const activeTarget = memRestore.length ? null : (snap?.active || null)
        let firstDone = false
        for (const u of restore) {
          try {
            const pg = firstDone ? await this.context.newPage() : (this.context.pages()[0] || await this.context.newPage())
            const id = this.adoptPage(pg)
            const isActive = !firstDone && (!activeTarget || normUrl(u) === normUrl(activeTarget))
            if (isActive) { this.activeTabId = id; firstDone = true }
            // 0905 十六批：tab 先立出来、页面后台加载——激活页只等 commit（导航开始、URL 确定，通常<1s），
            // 其余页完全后台恢复；tab 胶囊随 start 返回立即出现，内容由 2s 轮询陆续补全
            if (isActive) {
              await pg.goto(u, { waitUntil: 'commit', timeout: 8000 }).catch(() => {})
            } else {
              void pg.goto(u, { waitUntil: 'commit', timeout: 8000 }).catch(() => {})
            }
          } catch { /* ignore */ }
        }
        // activeTarget 没匹配到任何页（激活页已关）→ 第一个标签兜底为激活页
        if (!this.activeTabId && this.tabs.length) this.activeTabId = this.tabs[0].id
        /* ★0930 修（实测"设置里首页设了谷歌，打开浏览器却没落在首页"）：
           旧实现只有「无恢复标签」那条 else 分支才 goto 首页——用过一次后几乎总有恢复标签
           ⇒ 配置的首页永远不出现。现在：显式带 home 的启动把首页落地为【激活页】，
           已恢复的页保留（后台加载不丢工作现场）；若恢复列表里已有首页就直接激活它不重复开。 */
        if (homeGiven && this.homeUrl && this.homeUrl !== 'about:blank') {
          const homeNorm = normUrl(this.homeUrl)
          const homeTab = this.tabs.find((t) => { try { return normUrl(t.page.url()) === homeNorm } catch { return false } })
          if (homeTab) {
            this.activeTabId = homeTab.id
          } else {
            try {
              const pg = await this.context.newPage()
              const id = this.adoptPage(pg)
              this.activeTabId = id
              await pg.goto(this.homeUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {})
            } catch { /* ignore */ }
          }
        }
      } else {
        const first = this.context.pages()[0] || await this.context.newPage()
        this.activeTabId = this.adoptPage(first)
        /* ★1011j2：首页导航改用 commit（导航一提交即算成功）+ 30s——
           原来 domcontentloaded + 15s 在冷启动/走代理时偶发超时，表现就是"设了首页却停在 about:blank"
           （实测；失败被 catch 吞掉所以看着像设置没生效）。恢复标签那条路一直用 commit，这里与它对齐。 */
        if (this.homeUrl && this.homeUrl !== 'about:blank') { try { await first.goto(this.homeUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {}) } catch { /* ignore */ } }
      }
      await this.applyViewport(this.viewportKey)
      this.touchIdle()
      // 冷启动/恢复完成后若已有人观看，立即挂直播（否则帧流要到下一次交互才出现）
      if (this.onFrame) void this.restartScreencast()
    })()
    try { await this.starting } finally { this.starting = null }
  }

  async close(): Promise<void> {
    try { this.cdpClient?.close() } catch { /* ignore */ }
    this.cdpClient = null
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.watchCapTimer) { clearTimeout(this.watchCapTimer); this.watchCapTimer = null }   // ★0927 R15
    this.watching = false   // ★0927 R15：关了就不算挂起了（下次 start 重新计）
    /* ★C2 D2：shell 模式只断连接——不 close context（不会有 Browser.close 语义）、更不销毁 view：
       壳和人正在看的那一页必须原地活着（P0-6 实测 browser.close() 不杀 Electron，但"留着连接最安全"同源） */
    if (this.driver === 'shell') {
      try { this.restoreUrls = this.listTabs().map(t => t.url).filter(u => u && u !== 'about:blank') } catch { this.restoreUrls = [] }
      await this.stopScreencast()
      this.attached = false
      await this.detachShellQuietly()
      return
    }
    // 记录标签快照供下次 start 恢复（内存 + 落盘；释放缓存而非丢状态）
    try {
      this.restoreUrls = this.listTabs().map(t => t.url).filter(u => u && u !== 'about:blank')
      this.persistTabsSnapshot()
    } catch { this.restoreUrls = [] }
    const s = this.screencastSession
    this.screencastSession = null
    if (s) { try { await s.cdp.send('Page.stopScreencast') } catch { /* ignore */ } try { await s.cdp.detach() } catch { /* ignore */ } }
    const c = this.context
    this.context = null; this.tabs = []; this.activeTabId = ''
    if (c) { try { await c.close() } catch { /* ignore */ } }
  }

  /** 导航；url 缺协议自动补 https */
  async navigate(url: string, tabIdArg?: string): Promise<{ url: string }> {
    await this.start()
    const page = this.getTab(tabIdArg)
    let u = (url || '').trim()
    if (u && !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(u)) u = (/^[\w-]+(\.[\w-]+)+/.test(u) || u.startsWith('localhost')) ? 'https://' + u : u
    if (this.driver === 'shell') {
      const tabId = this.tabs.find(t => t.page === page)?.id
      if (!tabId) throw Error('导航目标没有明确标签身份')
      await shellCtlPost('/tab/switch', { key:this.key, tabId })
    }
    const resp = await page.goto(u || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => { throw new Error('导航失败：' + String(e?.message || e)) })
    // A requested navigation explicitly presents its exact tab; passive reads,
    // screenshots and user tab changes do not redirect the AI's operation target.
    if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(page)
    this.touchIdle()
    this.persistTabsSnapshot()
    return { url: resp?.url() || u }
  }

  async newTab(url?: string, opts?: { requireNew?: boolean; background?: boolean }): Promise<{ id: string }> {
    await this.start()
    if (this.driver === 'shell') {
      /* P0-1 实测：attach 下 context.newPage() 必然报 Target.createTarget -32000 ⇒ 只能请壳建。
         但当前壳（C2-a①）是"一会话一视图"、没有 /tab/new ⇒ 降级为【复用当前视图并导航过去】
         （语义仍是"在这台浏览器里打开这个 url"，只是不多一个 tab；多标签能力属 C2-2）。
         opts.requireNew=true 的调用方（例如把本地 html 渲染成截图）需要独占页面，这里必须明确失败——
         绝不许去劫持用户正在看的那一页。 */
      const target = (url || '').trim() || (this.homeUrl && this.homeUrl !== 'about:blank' ? this.homeUrl : '')
      try {
        const r = await shellNewTab(this.key, target, this.profileDir, 15000, opts?.background === true)
        await this.refreshShellTabs()
        let id = String(r.tabId || '')
        if (!id) { const last = this.tabs[this.tabs.length - 1]; id = last ? last.id : '' }
        if (!id) throw new Error('[shell] 壳建了视图但引擎认领不到（preload 标记缺失）：请检查壳侧 browserHost 是否给 view 装了 browserViewPreload')
        this.activeTabId = id
        this.touchIdle()
        this.persistTabsSnapshot()
        return { id }
      } catch (e: any) {
        const noMultiTab = e instanceof ShellCtlError && e.code === 'not-found'
        if (!noMultiTab) throw e
        if (opts?.requireNew) {
          throw new Error('[shell] 当前桌面壳是单视图模式，没有"独立新标签页"可用（多标签属 C2-2）。本操作需要独占页面，已放弃——请改用预览通道（wb_preview_file）')
        }
        await this.refreshShellTabs()
        const cur = this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0]
        if (!cur) throw new Error('[shell] 壳里没有本会话的浏览器视图，无法打开页面（请先在面板里打开浏览器）')
        if (target) {
          try { await cur.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (err: any) { throw new Error('导航失败：' + String(err?.message || err)) }
        }
        this.activeTabId = cur.id
        this.touchIdle()
        this.persistTabsSnapshot()
        return { id: cur.id }
      }
    }
    const page = await this.context!.newPage()
    const id = this.adoptPage(page)
    this.activeTabId = id
    // 0905：新标签一律跟随默认首页，不再留 about:blank（url 参数优先）
    const target = (url || '').trim() || (this.homeUrl && this.homeUrl !== 'about:blank' ? this.homeUrl : '')
    if (target) { try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch { /* ignore */ } }
    await this.applyViewport(this.viewportKey, page)
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
    return { id }
  }

  async closeTab(tabIdArg: string): Promise<{ tabs: BrowserTabInfo[] }> {
    if (this.driver === 'shell') {
      /* P0-7 实测：Target.closeTarget 会【真销毁 webContents】⇒ 必须请壳关（壳负责销毁/重建/同步 DOM 占位），
         引擎不许自己 page.close()——那样人会看到一块空白 view，壳还不知道。 */
      try { await shellCloseTab(this.key, tabIdArg) } catch (e: any) {
        if (e instanceof ShellCtlError && e.code === 'not-found') {
          throw new Error('[shell] 当前桌面壳是单视图模式，没有"标签页"可关（多标签属 C2-2）。要离开当前页请直接 wb_navigate 到目标地址，不要重试关闭')
        }
        throw e
      }
      this.tabs = this.tabs.filter(x => x.id !== tabIdArg)
      if (this.activeTabId === tabIdArg) this.activeTabId = this.tabs[0]?.id || ''
      await this.refreshShellTabs()
      try { this.onTabsChange?.() } catch { /* ignore */ }
      this.touchIdle()
      this.persistTabsSnapshot()
      return { tabs: this.listTabs() }
    }
    const t = this.tabs.find(x => x.id === tabIdArg)
    if (t) { try { await t.page.close() } catch { /* ignore */ } this.tabs = this.tabs.filter(x => x !== t) }
    if (this.activeTabId === tabIdArg) this.activeTabId = this.tabs[0]?.id || ''
    await this.ensureHome()
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
    return { tabs: this.listTabs() }
  }

  async switchTab(tabIdArg: string): Promise<void> {
    const t = this.tabs.find(x => x.id === tabIdArg)
    if (!t) throw new Error('标签页不存在')
    this.activeTabId = tabIdArg
    try { await t.page.bringToFront() } catch { /* ignore */ }
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
  }

  async goBack(tabIdArg?: string) { const p = this.getTab(tabIdArg); await p.goBack().catch(() => {}); if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p); this.touchIdle() }
  async goForward(tabIdArg?: string) { const p = this.getTab(tabIdArg); await p.goForward().catch(() => {}); if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p); this.touchIdle() }
  async reload(tabIdArg?: string, hard = false) { const p = this.getTab(tabIdArg); await p.reload({ waitUntil: hard ? 'load' : 'domcontentloaded' }).catch(() => {}); this.touchIdle() }
  async stop(tabIdArg?: string) { try { const p = this.getTab(tabIdArg); await p.evaluate('window.stop&&window.stop()').catch(() => {}) } catch { /* ignore */ } }

  async screenshot(tabIdArg?: string, type: 'png' | 'jpeg' = 'jpeg', quality = 60): Promise<{ data: string; mime: string; width: number; height: number }> {
    const p = this.getTab(tabIdArg)
    /* ★C2（红线）：shell 模式下隐藏 view 的 page.screenshot 不可靠（P0-3：静态页 1/4、8s 内第 2 张必超时）
       ⇒ 可见就走 page.screenshot（27~78ms），不在屏走壳截图后台通道，两条都带超时。 */
    if (this.driver === 'shell') return await this.shellScreenshot(p, tabIdArg, type, quality)
    const buf = await withTimeout(p.screenshot({ type, quality: type === 'jpeg' ? quality : undefined, fullPage: false }), 20000, 'page.screenshot')
    this.touchIdle()
    const vp = p.viewportSize() || { width: 1280, height: 800 }
    return { data: buf.toString('base64'), mime: `image/${type}`, width: vp.width, height: vp.height }
  }

  /** 当前生效预设：auto=面板自适应尺寸，其余查表 */
  private effectivePreset(): ViewportPreset {
    if (this.viewportKey === 'auto' && this.customViewport && this.customViewport.width >= 200 && this.customViewport.height >= 200) {
      return { ...VIEWPORTS.pc, width: Math.round(this.customViewport.width), height: Math.round(this.customViewport.height) }
    }
    return VIEWPORTS[this.viewportKey] || VIEWPORTS.pc
  }

  /** 应用视口预设（CDP 覆盖，热切换 UA/触摸/尺寸/mobile）；page 缺省=active */
  async applyViewport(key: string, pageArg?: Page): Promise<void> {
    this.viewportKey = key
    /* C2：shell 模式视口＝view 的真实边界（auto 什么都不做）；只有设备预设才做 CDP 覆盖（会出留白，属预期） */
    if (this.driver === 'shell') {
      if (key !== 'auto') { try { await this.applyViewportEmulation(key) } catch { /* 壳不支持就保持视图边界 */ } }
      return
    }
    const preset = this.effectivePreset()
    const page = pageArg || this.tryGetTab()
    if (!page || !this.context) return
    try {
      // 0906 体检 P2#17：CDP 会话按 page 复用（每次新建从不 detach → 句柄累积泄漏）
      let cdp = viewportSessions.get(page)
      if (!cdp) {
        cdp = await this.context.newCDPSession(page)
        viewportSessions.set(page, cdp)
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: preset.width, height: preset.height, deviceScaleFactor: preset.dpr, mobile: preset.mobile,
      })
      if (preset.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: preset.userAgent })
      else await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {})
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: preset.touch, maxTouchPoints: preset.touch ? 5 : 0 }).catch(() => {})
      await page.setViewportSize({ width: preset.width, height: preset.height }).catch(() => {})
    } catch {
      await page.setViewportSize({ width: preset.width, height: preset.height }).catch(() => {})
    }
  }

  async setViewport(key: string, custom?: { width: number; height: number }): Promise<{ viewport: string; ownedByShell?: boolean; applied?: boolean; note?: string }> {
    if (this.driver === 'shell') {
      this.viewportKey = key
      this.touchIdle()
      if (key === 'auto') {
        /* 视口＝壳里 view 的真实边界。
           ★1119af：**必须清掉可能存在的设备模拟** —— emulation 修好后它是真的会生效的，
           不清的话从 iphone15 切回"自适应"会一直卡在 393px（用户看到的是"切不回去"）。 */
        const p = this.tryGetTab()
        const tabId = this.tabs.find(t => t.page === p)?.id
        const r = tabId ? await shellCtlPost('/device', {key:this.key,tabId,device:'pc'}) : null
        const cleared = r?.ok === true
        return {
          viewport: key, ownedByShell: true, applied: cleared,
          note: cleared ? '已取消设备模拟，视口回到视图边界' : '视口由窗口内视图边界决定，auto 无需设置',
        }
      }
      let applied = false
      let errMsg = ''
      try { applied = await this.applyViewportEmulation(key) } catch (e: any) { applied = false; errMsg = String(e?.message || e) }
      return {
        viewport: key, ownedByShell: true, applied,
        /* ★1119af：原来 applied=false 一律说"壳视图不支持设备模拟"—— 那是**错误归因**：
           真因是走了 playwright 的 newCDPSession（现已改成走视图自己的 CDP 会话）。
           现在失败就如实报错，不再拿"壳不支持"当挡箭牌。 */
        note: applied
          ? '已用 CDP 设备模拟覆盖（周围留白属预期，等同 DevTools 设备模拟）'
          : `设备模拟未生效${errMsg ? '：' + errMsg : '（视图未就绪）'}`,
      }
    }
    if (key === 'auto') {
      const w = Math.min(4000, Math.max(200, Math.round(custom?.width || this.customViewport?.width || VIEWPORTS.pc.width)))
      const h = Math.min(4000, Math.max(200, Math.round(custom?.height || this.customViewport?.height || VIEWPORTS.pc.height)))
      this.customViewport = { width: w, height: h }
    }
    await this.applyViewport(key)
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    return { viewport: this.viewportKey }
  }

  /* ★1117：`setMode`（运行时切有头/无头）已删除 ——
     引擎侧壳模式恒为空操作（窗口归壳管），RPC 也无人调用。
     启动时的 mode 仍由 `start({ mode })` 使用（local 兜底路径）。 */
  async cookiesList(): Promise<any[]> { if (!this.context) return []; return this.context.cookies() }
  async cookiesClear(): Promise<void> { if (this.context) await this.context.clearCookies() }

  /** 人接管反传原语：action ∈ click/dblclick/rightclick/move/hover/wheel/key/text/insertText/down/up/touch */
  async input(action: string, args: Record<string, any>, tabIdArg?: string): Promise<{ cursor?: string } | void> {
    const p = this.getTab(tabIdArg)
    if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p)
    const x = Number(args.x || 0), y = Number(args.y || 0)
    const mobile = (VIEWPORTS[this.viewportKey] || VIEWPORTS.pc).touch
    switch (action) {
      case 'click': await p.mouse.click(x, y); break
      case 'dblclick': await p.mouse.dblclick(x, y); break
      case 'rightclick': await p.mouse.click(x, y, { button: 'right' }); break
      case 'move': await p.mouse.move(x, y); break
      // 0908②(c)：down 必须先移动到位再按下。此前 down 不带 move，按下位置=最后一次
      // hover 探测（100ms 节流）的旧坐标——快速点击时两位置差出几像素/差一个元素=点击偶发无效。
      // up 不带坐标=在当前位置松手（拖拽途中 move 已持续更新位置，语义正确）。
      case 'down': await p.mouse.move(x, y); await p.mouse.down(); break
      case 'up': await p.mouse.up(); break
      case 'wheel': await p.mouse.wheel(Number(args.dx || 0), Number(args.dy || 0)); break
      case 'key': await p.keyboard.press(String(args.key || 'Enter')); break
      case 'text': await p.keyboard.type(String(args.text || '')); break
      case 'insertText': await p.keyboard.insertText(String(args.text || '')); break
      case 'hover': {
        await p.mouse.move(x, y)
        const cursor = await p.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return 'default'; const c = getComputedStyle(el).cursor; if (c && c !== 'auto') return c; const t = el.closest('a,button,[role=button],select,label,[onclick],summary'); if (t) return 'pointer'; const inp = el.closest('input,textarea,[contenteditable],[contenteditable] *'); return inp ? 'text' : 'default' })()`).catch(() => 'default')
        return { cursor: typeof cursor === 'string' ? cursor : 'default' }
      }
      case 'touch': if (mobile) { await p.touchscreen.tap(x, y) } else { await p.mouse.click(x, y) } break
      default: throw new Error('未知输入动作：' + action)
    }
    this.touchIdle()
  }

  /** 注册帧回调并对 active 页开 CDP screencast */
  setFrameCallback(cb: FrameCb | null): void {
    this.onFrame = cb
    if (cb) void this.restartScreencast()
    else void this.stopScreencast()
  }

  private async stopScreencast(): Promise<void> {
    const s = this.screencastSession
    this.screencastSession = null
    if (s) { try { await s.cdp.send('Page.stopScreencast') } catch { /* ignore */ } try { await s.cdp.detach() } catch { /* ignore */ } }
  }

  /** 重启直播：切标签/切视口/开合 watch 时重新挂一个（且仅一个）CDP screencast 会话到当前激活页 */
  async restartScreencast(): Promise<void> {
    await this.stopScreencast()
    if (this.driver === 'shell') return   // C2：面板走原生渲染，CDP 直播只在后台/远程场景需要（旧帧流删除是 C2-a③）
    if (!this.onFrame || !this.context) return
    const tab = this.tabs.find(t => t.id === this.activeTabId)
    if (!tab) return
    try {
      const cdp = await this.context.newCDPSession(tab.page)
      this.screencastSession = { cdp, tabId: tab.id }
      cdp.on('Page.screencastFrame', (ev: any) => {
        if (!this.screencastSession || this.screencastSession.tabId !== tab.id) { cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}); return }
        try { this.onFrame && this.onFrame(tab.id, ev.data, { width: ev.metadata?.deviceWidth || 0, height: ev.metadata?.deviceHeight || 0 }) } catch { /* ignore */ }
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
      })
      const preset = this.effectivePreset()
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: cast.quality, maxWidth: preset.width * cast.scale, maxHeight: preset.height * cast.scale, everyNthFrame: cast.everyNthFrame })
    } catch { this.screencastSession = null }
  }

  /** 页面可读快照（AI wb_snapshot 用；8k 截断——0905 实测 20k/次把上下文吃到 454k tokens，LLM 越跑越慢） */
  async snapshot(tabIdArg?: string): Promise<{ title: string; url: string; text: string }> {
    const p = this.getTab(tabIdArg)
    /* ★1110v：适配层的返回值显式收成 string（webview 的 evaluate 返回 any/unknown） */
    const title = String((await p.title().catch(() => '')) || '')
    const url = String(p.url() || '')
    const text = String((await p.evaluate('document.body ? document.body.innerText.slice(0, 8000) : ""').catch(() => '')) || '')
    return { title, url, text }
  }
}

/**
 * browserWebview.ts —— 用 raw CDP 把 Electron `<webview>` 包装成"playwright Page 的鸭子类型"。
 *
 * 为什么需要它（★1110v）：
 *   浏览器面板从 WebContentsView 换成 `<webview>` 之后，playwright 的 `context.pages()`
 *   **看不到它**（它枚举的是 `type:"page"`，webview 是 `type:"webview"`，实测见
 *   `_electron-probe/browser-cdp/RESULT.md` 与 1110u 的 CDP 探测）。而引擎的页面操作层
 *   到处是 `page.xxx()`，全部重写风险极大。
 *
 *   所以这里做一层**形状兼容**的适配对象：方法名、参数、返回值都与 playwright Page 对齐，
 *   引擎里 `as unknown as Page` 之后其余代码零改动。底层全部走 CDP：
 *     evaluate → Runtime.evaluate ／ goto → Page.navigate ／ screenshot → Page.captureScreenshot
 *     click/type → Input.* ／ back/forward → Page.getNavigationHistory + navigateToHistoryEntry
 *
 * 前置条件：webview 必须带 `__NIS_MARK`（由 browserViewPreload.cjs 注入，主进程
 *   `will-attach-webview` 负责装）。认领时按 mark.key / mark.tabId 对齐引擎的会话与标签。
 */

type Pending = { res: (v: any) => void; rej: (e: Error) => void }

/** 极简 CDP 客户端：连接 shell 的 browser websocket，支持 flatten session（Target.attachToTarget）。 */
export class CdpBrowserClient {
  private ws: any
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>()
  private closed = false

  constructor(private wsUrl: string) { }

  async connect(timeoutMs = 8000): Promise<void> {
    const WS = (globalThis as any).WebSocket
    if (!WS) throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')
    this.ws = new WS(this.wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket 连接超时')), timeoutMs)
      this.ws.onopen = () => { clearTimeout(timer); resolve() }
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket 连接失败')) }
    })
    this.ws.onmessage = (ev: any) => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.res(msg.result)
        return
      }
      if (msg.method) {
        const set = this.listeners.get(msg.method)
        if (set) for (const fn of set) { try { fn(msg.params, msg.sessionId) } catch { /* ignore */ } }
      }
    }
    this.ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) p.rej(new Error('CDP 连接已断开')); this.pending.clear() }
  }

  get isClosed(): boolean { return this.closed }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (this.closed || !this.ws) return Promise.reject(new Error('CDP 未连接'))
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (e: any) { this.pending.delete(id); rej(new Error(String(e?.message || e))) }
    })
  }

  on(method: string, fn: (params: any, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) { set = new Set(); this.listeners.set(method, set) }
    set.add(fn)
    return () => { try { set!.delete(fn) } catch { /* ignore */ } }
  }

  close(): void { try { this.ws?.close() } catch { /* ignore */ } this.closed = true }
}

/** 一个 webview target 的描述（来自 /json/list 或 Target.getTargets） */
export interface WebviewTargetInfo { targetId: string; url: string; title?: string }

/**
 * 拉取候选 target 列表（用 HTTP /json/list，比 CDP 更省事且足够）。
 *
 * ★1119ab（实测根因：内置浏览器恒报"认领不到视图"）：
 *   原来这里 `.filter(t => t.type === 'webview')` —— **只认 `webview` 一种 type**。
 *   但本机 Electron（45.2.3 / Chrome 156）把 `WebContentsView` 在 CDP 里暴露成 **`type:'page'`**，
 *   `/json/list` 实测 3 个 target **全是 page、0 个 webview** ⇒ 这里恒返回空数组
 *   ⇒ `claimShellViews()` 拿不到任何 target ⇒ 永远报"视图未创建"（其实视图好端端在，标记也对）。
 *
 * 为什么放宽成 page+webview 不会误认领（这是设计口径，不是兜底）：
 *   认领的**唯一判据本来就是页面里的 `__NIS_MARK`**（browserEngine.claimShellViews 注释：
 *   "认领判据仍然是 preload 标记 —— **绝不按 URL/顺序猜**"）。type 只该当**预筛**，不该当判据。
 *   放宽后：宿主 UI 页 `mark.kind='ui'` 会被排除、别的会话 `mark.key` 不匹配会被排除、
 *   没有 mark 的页（tray-menu.html）也会被排除 —— 三道闸都在 claimShellViews 里。
 *   `/json/list` 里 page 数量是个位数，每个 evaluate 一次标记的开销可忽略。
 */
export async function listWebviewTargets(cdpPort: number): Promise<WebviewTargetInfo[]> {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
  if (!r.ok) throw new Error('CDP /json/list 失败：' + r.status)
  const list: any = await r.json()
  return (Array.isArray(list) ? list : [])
    /* page = Electron 45+ 的 WebContentsView（本机实测）；webview = 旧版/其他壳的形态，一并兼容 */
    .filter((t) => t && (t.type === 'page' || t.type === 'webview'))
    .map((t) => ({ targetId: String(t.id), url: String(t.url || ''), title: String(t.title || '') }))
}

/**
 * 把某个 webview target 包装成"playwright Page 的形状"。
 * 只实现引擎实际用到的成员（见 browserEngine 里 `Page` 的用法）。
 */
export class WebviewCdpPage {
  private sessionId = ''
  private closeCbs: Array<() => void> = []
  private lastError = ''

  constructor(private cdp: CdpBrowserClient, public readonly targetId: string) { }

  /** attach 到 target，拿到 sessionId（后续所有命令都带它） */
  async attach(): Promise<void> {
    const r = await this.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    this.sessionId = String(r?.sessionId || '')
    if (!this.sessionId) throw new Error('attachToTarget 没有返回 sessionId')
    // 常用域先开，避免后续命令因未 enable 失败
    await this.cmd('Runtime.enable').catch(() => { })
    await this.cmd('Page.enable').catch(() => { })
    /* target 被销毁时触发 close 回调（等价 Page 的 'close' 事件） */
    const offDestroy = this.cdp.on('Target.targetDestroyed', (p: any) => {
      if (String(p?.targetId) === this.targetId) { offDestroy(); this.fireClose() }
    })
    /* 导航发生时同步刷新 URL 缓存（url() 是同步接口，必须靠事件维护） */
    this.cdp.on('Page.frameNavigated', (p: any, sid?: string) => {
      if (sid && sid !== this.sessionId) return
      if (p?.frame?.parentId) return          // 只认主框架
      const u = String(p?.frame?.url || '')
      if (u) this.currentUrl = u
    })
    await this.refreshUrl().catch(() => { })
  }

  private fireClose(): void {
    for (const cb of this.closeCbs) { try { cb() } catch { /* ignore */ } }
    this.closeCbs = []
  }

  private cmd(method: string, params: Record<string, any> = {}): Promise<any> {
    return this.cdp.send(method, params, this.sessionId)
  }

  /* ══ Page 形状的成员 ══════════════════════════════════════════════════ */

  isClosed(): boolean { return !this.sessionId }
  on(event: string, cb: () => void): this { if (event === 'close') this.closeCbs.push(cb); return this }
  off(): this { return this }

  /** 当前 URL（**同步**，与 playwright Page.url() 一致）。
   *  值由 attach / goto / 导航事件维护 —— 引擎里有同步调用点，不能返回 Promise。 */
  private currentUrl = ''
  url(): string { return this.currentUrl }
  async refreshUrl(): Promise<void> {
    const r = await this.cmd('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null)
    const u = String(r?.result?.value || '')
    if (u) this.currentUrl = u
  }

  async title(): Promise<string> {
    const r = await this.cmd('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    return String(r?.result?.value || '')
  }

  async evaluate(expr: any): Promise<any> {
    const source = typeof expr === 'string' ? expr : String(expr)
    const r = await this.cmd('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'evaluate 失败'))
    return r?.result?.value
  }

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<any> {
    const timeout = Number(opts?.timeout) || 30000
    const done = new Promise<void>((resolve) => {
      let offLoad = () => { }
      const timer = setTimeout(() => { offLoad(); resolve() }, timeout)
      offLoad = this.cdp.on('Page.loadEventFired', (_p: any, sid?: string) => {
        if (sid && sid !== this.sessionId) return
        clearTimeout(timer); offLoad(); resolve()
      })
    })
    const r = await this.cmd('Page.navigate', { url })
    if (r?.errorText) throw new Error('导航失败：' + r.errorText)
    await done
    await this.refreshUrl().catch(() => { })
    return null
  }

  async reload(opts?: { waitUntil?: string }): Promise<void> {
    await this.cmd('Page.reload', { ignoreCache: opts?.waitUntil === 'load' }).catch(() => { })
  }

  async goBack(): Promise<void> {
    const h = await this.cmd('Page.getNavigationHistory')
    const idx = Number(h?.currentIndex ?? 0)
    const entry = (h?.entries || [])[idx - 1]
    if (!entry) return
    await this.cmd('Page.navigateToHistoryEntry', { entryId: entry.id })
  }

  async goForward(): Promise<void> {
    const h = await this.cmd('Page.getNavigationHistory')
    const idx = Number(h?.currentIndex ?? 0)
    const entry = (h?.entries || [])[idx + 1]
    if (!entry) return
    await this.cmd('Page.navigateToHistoryEntry', { entryId: entry.id })
  }

  async bringToFront(): Promise<void> { await this.cmd('Page.bringToFront').catch(() => { }) }

  async close(): Promise<void> {
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }) } catch { /* ignore */ }
    this.fireClose()
  }

  async screenshot(opts?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer> {
    const type = opts?.type === 'jpeg' ? 'jpeg' : 'png'
    const params: any = { format: type, captureBeyondViewport: !!opts?.fullPage }
    if (type === 'jpeg') params.quality = Number(opts?.quality) || 60
    const r = await this.cmd('Page.captureScreenshot', params)
    const b64 = String(r?.data || '')
    if (!b64) throw new Error('captureScreenshot 没有返回数据')
    return Buffer.from(b64, 'base64')
  }

  viewportSize(): { width: number; height: number } {
    /* 同步接口（引擎里有同步调用），用最近一次已知值；未取到时给 0 由调用方兜 */
    return this.lastViewport
  }

  /**
   * ★1119af：设备模拟（移动端视口）。
   *
   * 为什么必须由本类自己做：引擎原来走 `ctx.newCDPSession(page)` —— 那是 **playwright 的 API**，
   * 要求传入真正的 playwright Page。shell 模式下 page 是本类（鸭子类型）⇒ 必然抛错，
   * 而 `setViewport` 里 try/catch 把它吞成 `applied=false` ⇒ 工具永远回"壳视图不支持设备模拟"。
   * 实测这就是 `wb_set_viewport iphone15` 无效的根因（不是"壳不支持"，是"调错了通道"）。
   *
   * 本类手上就有**已 attach 的 CDP 会话**（`cmd` 自带 sessionId），直接下发目标级 Emulation 即可。
   * `preset.userAgent` 为空 = 还原默认 UA（CDP 里传空串就是还原），不是"跳过"。
   */
  async emulateViewport(v: {
    width: number; height: number; dpr?: number;
    mobile?: boolean; touch?: boolean; userAgent?: string
  }): Promise<void> {
    const width = Math.max(1, Math.round(Number(v.width) || 0))
    const height = Math.max(1, Math.round(Number(v.height) || 0))
    await this.cmd('Emulation.setDeviceMetricsOverride', {
      width, height,
      deviceScaleFactor: Number(v.dpr) || 1,
      mobile: !!v.mobile,
      /* 视口比视图边界小时，画面居中留白（与 DevTools 设备模拟一致） */
      screenWidth: width,
      screenHeight: height,
    })
    await this.cmd('Emulation.setUserAgentOverride', { userAgent: String(v.userAgent || '') })
    await this.cmd('Emulation.setTouchEmulationEnabled', {
      enabled: !!v.touch,
      maxTouchPoints: v.touch ? 5 : 0,
    })
    /* 模拟后 DOM 的 clientWidth/clientHeight 变了，缓存要跟着刷新，否则 viewportSize() 会撒谎 */
    await this.refreshViewport().catch(() => { })
  }

  /** 取消设备模拟（回到"视口=视图真实边界"） */
  async clearEmulation(): Promise<void> {
    await this.cmd('Emulation.clearDeviceMetricsOverride').catch(() => { })
    await this.cmd('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 }).catch(() => { })
    await this.refreshViewport().catch(() => { })
  }
  lastViewport = { width: 0, height: 0 }
  async refreshViewport(): Promise<void> {
    const r = await this.cmd('Runtime.evaluate', {
      expression: 'JSON.stringify({w:document.documentElement.clientWidth,h:document.documentElement.clientHeight})',
      returnByValue: true,
    }).catch(() => null)
    try {
      const v = JSON.parse(String(r?.result?.value || '{}'))
      if (v.w) this.lastViewport = { width: Number(v.w), height: Number(v.h) }
    } catch { /* ignore */ }
  }

  /* ── 鼠标 / 键盘 / 触摸（引擎 input() 用） ── */
  private btn(button?: string): 'none' | 'left' | 'right' | 'middle' {
    if (button === 'right') return 'right'
    if (button === 'middle') return 'middle'
    return 'left'
  }

  mouse = {
    click: async (x: number, y: number, opts?: { button?: string }) => {
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await this.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: this.btn(opts?.button), clickCount: 1 })
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: this.btn(opts?.button), clickCount: 1 })
    },
    dblclick: async (x: number, y: number) => {
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      for (const n of [1, 2]) {
        await this.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n })
        await this.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n })
      }
    },
    move: async (x: number, y: number) => { await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) },
    down: async () => { await this.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.lastX, y: this.lastY, button: 'left', clickCount: 1 }) },
    up: async () => { await this.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.lastX, y: this.lastY, button: 'left', clickCount: 1 }) },
    wheel: async (dx: number, dy: number) => {
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.lastX, y: this.lastY, deltaX: dx, deltaY: dy })
    },
  }

  private lastX = 0
  private lastY = 0
  /** 记录最近一次鼠标坐标（down/up/wheel 不带坐标，用最近位置） */
  notePointer(x: number, y: number): void { this.lastX = x; this.lastY = y }

  keyboard = {
    press: async (key: string) => {
      const k = String(key || 'Enter')
      await this.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k }).catch(() => { })
      await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k }).catch(() => { })
    },
    type: async (text: string) => { await this.cmd('Input.insertText', { text: String(text || '') }) },
    insertText: async (text: string) => { await this.cmd('Input.insertText', { text: String(text || '') }) },
  }

  touchscreen = {
    tap: async (x: number, y: number) => {
      await this.cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await this.cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    },
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ★1119ad · 补齐工具层依赖的 playwright 高层 API
     病（工具层实测）：`wb_click` 报 `p.getByText is not a function`、
                      `wb_get_text` 报 `p.locator is not a function`。
     根因：工具层（server.ts 的 wb_* 实现）按 playwright Page 写：
        locator()/getByText()/getByPlaceholder()/click(sel)/fill(sel,v)/hover(sel)/
        waitForSelector()/waitForLoadState()
      而本类只实现「引擎用到的成员」⇒ shell 模式下**这些方法整个不存在**。
     波及工具（实测统计）：wb_click / wb_fill / wb_fill_form / wb_hover /
        wb_get_text / wb_wait（wb_send_screenshot 的 waitForLoadState 也走这里）。
     ⇒ 不是"某个工具坏了"，是这类 Page 形状**缺一整层**，所以在这里补齐，
        而不是改工具层：工具层用 playwright API 更可读，将来接回 local driver 也一致。

     底层一律走**真实事件**（这是与"合成事件"的关键区别）：
       · 找元素：evaluate 读几何（不改 DOM、不猜结构）
       · 点击/悬停：CDP Input.dispatchMouseEvent ⇒ isTrusted=true
       · 输入：先行点击聚焦 → 全选 → Input.insertText（真实输入事件）
     不用 el.click()/直接改 value —— 那类合成事件 React/Vue 的受控组件可能不认。
     ═══════════════════════════════════════════════════════════════════════════ */

  /** 按 finder 定位元素，返回中心坐标 + 可编辑性；找不到如实给 reason（不猜、不兜底选别的） */
  async locateRect(f: CdpTargetFinder): Promise<CdpTargetRect> {
    const src = `(function(f){
      var norm=function(s){return (s||'').replace(/\\s+/g,' ').trim();};
      var visible=function(el){
        if(!el||!el.getClientRects) return false;
        var r=el.getBoundingClientRect();
        if(r.width<=0||r.height<=0) return false;
        var cs=getComputedStyle(el);
        return cs.visibility!=='hidden' && cs.display!=='none' && Number(cs.opacity)!==0;
      };
      var target=norm(f.value), exact=!!f.exact;
      var hit=function(t){return exact ? t===target : t.indexOf(target)>=0;};
      /* ★1119ad：可见文字定位必须认**多个文本来源** —— 图标按钮的文案常在 aria-label/title（没有 textContent）。
         wb_snapshot 清单里给出引号文字就是从这些来源读的，这里只查 textContent 会「清单能看见、点击找不到」。 */
      var srcOf=function(e){
        var parts=[norm(e.textContent), norm(e.getAttribute('aria-label')||''), norm(e.getAttribute('title')||'')];
        var tg=e.tagName;
        if(tg==='INPUT'||tg==='TEXTAREA'||tg==='OPTION') parts.push(norm(e.value||''));
        /* 分隔符用普通可见字符：这段 JS 会被拼进模板字符串，
           任何转义序列（如换行转义）都会在这一层就被解析掉、把生成的源码拆断行。 */
        return parts.join(' ||| ');
      };
      var el=null;
      if(f.kind==='css'){
        try{ el=document.querySelector(f.value); }catch(e){ return {ok:false,reason:'bad-selector'}; }
      } else if(f.kind==='placeholder'){
        var list=[].slice.call(document.querySelectorAll('[placeholder]'));
        el=list.filter(function(e){return hit(norm(e.getAttribute('placeholder')));})[0]||null;
      } else {
        var all=[].slice.call(document.querySelectorAll('body *'));
        var cands=all.filter(function(e){
          if(!hit(srcOf(e))) return false;
          var kids=[].slice.call(e.children);
          for(var i=0;i<kids.length;i++){ if(hit(srcOf(kids[i]))) return false; }
          return visible(e);
        });
        var interactive=/^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/;
        el=cands.filter(function(e){return interactive.test(e.tagName)||e.getAttribute('role')==='button';})[0]||cands[0]||null;
      }
      if(!el) return {ok:false,reason:'not-found'};
      if(!visible(el)) return {ok:false,reason:'not-visible'};
      var r=el.getBoundingClientRect();
      var tag2=el.tagName.toUpperCase();
      return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,
              editable:(tag2==='INPUT'||tag2==='TEXTAREA'||!!el.isContentEditable),
              /* 可读文本：可见文本 → 值 → aria-label → title（纯图标元素不会返回空串） */
              text:String(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('title')||'')};
    })(${JSON.stringify({ kind: f.kind, value: f.value, exact: !!f.exact })})`
    const r = await this.evaluate(src).catch(() => null)
    if (!r || typeof r !== 'object') return { ok: false, reason: 'evaluate-failed' }
    return r as CdpTargetRect
  }

  /** 等元素出现且可见。超时返回 false（由调用方决定报错文案，这里不替它决定） */
  async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<boolean> {
    const timeout = Number(opts?.timeout) || 8000
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const r = await this.locateRect({ kind: 'css', value: String(selector), exact: false })
      if (r.ok) return true
      await new Promise((res) => setTimeout(res, 120))
    }
    return false
  }

  /** 等页面稳定：readyState=complete 且近 400ms 内没有新资源结束（networkidle 的等价语义） */
  async waitForLoadState(_state?: string, opts?: { timeout?: number }): Promise<void> {
    const timeout = Number(opts?.timeout) || 8000
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const st = await this.evaluate(`(function(){
        if (document.readyState !== 'complete') return 'loading';
        try {
          var now = performance.now();
          var busy = performance.getEntriesByType('resource').some(function(e){ return now - (e.responseEnd||0) < 400; });
          return busy ? 'busy' : 'idle';
        } catch (e) { return 'idle'; }
      })()`).catch(() => 'loading')
      if (st === 'idle') return
      await new Promise((res) => setTimeout(res, 150))
    }
  }

  locator(selector: string): CdpLocator {
    return new CdpLocator(this, { kind: 'css', value: String(selector), exact: false })
  }
  getByText(text: string, opts?: { exact?: boolean }): CdpLocator {
    return new CdpLocator(this, { kind: 'text', value: String(text), exact: !!opts?.exact })
  }
  getByPlaceholder(text: string, opts?: { exact?: boolean }): CdpLocator {
    return new CdpLocator(this, { kind: 'placeholder', value: String(text), exact: !!opts?.exact })
  }

  async click(selector: string, opts?: { timeout?: number }): Promise<void> {
    await this.locator(selector).click(opts)
  }
  async fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void> {
    await this.locator(selector).fill(value, opts)
  }
  async hover(selector: string, opts?: { timeout?: number }): Promise<void> {
    await this.locator(selector).hover(opts)
  }
}

/* ── ★1119ad：定位器 —— playwright Locator 的**最小可用子集**（只实现工具层真正调用的成员） ── */
export type CdpTargetFinder = { kind: 'css' | 'text' | 'placeholder'; value: string; exact: boolean }

/** locateRect 的返回：ok=false 带 reason；ok=true 带几何与可编辑性 */
export interface CdpTargetRect {
  ok: boolean
  reason?: string
  x?: number
  y?: number
  w?: number
  h?: number
  editable?: boolean
  text?: string
}

/** 命中后的确定形态（供 Locator 内部使用，避免到处写非空断言） */
interface CdpHit { x: number; y: number; w: number; h: number; editable: boolean; text: string }

export class CdpLocator {
  constructor(private page: WebviewCdpPage, private finder: CdpTargetFinder) { }

  /** 本实现语义就是"取第一个"，保留该方法让调用链与 playwright 写法一致 */
  first(): CdpLocator { return this }

  private async need(timeout: number): Promise<CdpHit> {
    const deadline = Date.now() + timeout
    let last: CdpTargetRect = { ok: false, reason: 'not-found' }
    while (true) {
      last = await this.page.locateRect(this.finder)
      if (last.ok) {
        return {
          x: Number(last.x) || 0, y: Number(last.y) || 0,
          w: Number(last.w) || 0, h: Number(last.h) || 0,
          editable: !!last.editable, text: String(last.text || ''),
        }
      }
      /* 选择器语法错 / evaluate 本身失败：重试无意义，立刻报真因 */
      if (last.reason === 'bad-selector' || last.reason === 'evaluate-failed') break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 120))
    }
    const what = this.finder.kind === 'css'
      ? `选择器 ${this.finder.value}`
      : this.finder.kind === 'text'
        ? `可见文字「${this.finder.value}」`
        : `占位文字「${this.finder.value}」`
    throw new Error(`找不到元素：${what}（${last.reason || 'timeout'}）`)
  }

  async click(opts?: { timeout?: number }): Promise<void> {
    const r = await this.need(Number(opts?.timeout) || 8000)
    await this.page.mouse.click(r.x, r.y)
    this.page.notePointer(r.x, r.y)
  }

  async hover(opts?: { timeout?: number }): Promise<void> {
    const r = await this.need(Number(opts?.timeout) || 8000)
    await this.page.mouse.move(r.x, r.y)
    this.page.notePointer(r.x, r.y)
  }

  /** 填值：先真实点击聚焦（让框架的 focus 逻辑照常跑）→ 全选 → insertText 覆盖。
   *  ⚠️ 不直接写 el.value：那不会触发框架的受控更新（Vue/React 的 v-model/onChange 收不到）。 */
  async fill(value: string, opts?: { timeout?: number }): Promise<void> {
    const r = await this.need(Number(opts?.timeout) || 8000)
    await this.page.mouse.click(r.x, r.y)
    this.page.notePointer(r.x, r.y)
    await this.page.evaluate(`(function(){var a=document.activeElement; if(a&&a.select){try{a.select();}catch(e){}}})()`).catch(() => { })
    await this.page.keyboard.insertText(String(value ?? ''))
  }

  async innerText(opts?: { timeout?: number }): Promise<string> {
    const r = await this.need(Number(opts?.timeout) || 8000)
    return r.text
  }

  async count(): Promise<number> {
    const r = await this.page.locateRect(this.finder)
    return r.ok ? 1 : 0
  }
}

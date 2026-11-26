/**
 * Memory/Knowledge bridge — Node 侧管理 Python 子进程（memory_bridge.py），
 * 通过 stdin/stdout JSON 行协议通信，并暴露 Agent 工具。
 *
 * 数据目录：**本应用自己的** `NIS_MEMORY_DIR`（打包版 = %APPDATA%\nis\memory）或 `<DATA_ROOT>/memory`，
 * 与网页版、与「存储目录」都互不影响（见下方 resolveDataDir 的说明）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from './agentCompat.ts'
import { buildFamilyTool } from './familyTool.ts'
import { DATA_ROOT, BACKEND_ROOT } from './paths.ts'
/* ★1126：用户画像(USER.md)/项目记忆(MEMORY.md)——每轮注入的两份 Markdown，与 SQLite 记忆库的生命周期完全不同 */
import { addEntry, patchEntry, removeEntry, readProfile, profileTitle, parseProfileLinks, type ProfileKind } from './memoryProfile.ts'

/* ── 内核脚本路径（0917 支持 env 覆盖 / **0918 改为随应用自带**）──────
 * 背景（双版本隔离）：以前打包版（版本1）与开发版（版本2）都 spawn 网页版目录里那一份内核脚本
 * —— 改内核会同时影响两边，而且客户端其实是在**依赖网页版的安装目录**（那个盘一删就全废）。
 * 现在：内核包（memory_bridge.py + core/）随项目自带在 `backend/memory-kernel/`，
 * 打包时跟着 sidecar 一起进安装包 → 每个实例带自己那份。
 * 优先级：NIS_BRIDGE_SCRIPT 显式覆盖 → 自带内核。
 *
 * ★开源整理批（2026-11）：**删掉 LEGACY_BRIDGE**（原来写死 `E:\<旧内核目录>\...`）。
 *   那是最典型的兜底：别人的机器上恒不存在，spawn 只会失败成"文件找不到"，
 *   而不是明说"内核缺失"。现在来源只有两个：env 显式指定，或随包自带的那份；
 *   到底在不在由 BRIDGE_SCRIPT_EXISTS 如实暴露。 ── */
const BUNDLED_BRIDGE = path.join(BACKEND_ROOT, 'memory-kernel', 'memory_bridge.py')
export const BRIDGE_SCRIPT = String(process.env.NIS_BRIDGE_SCRIPT || '').trim() || BUNDLED_BRIDGE
/** 内核脚本是不是真的在（缺了要明说，别静默变成"记忆功能莫名不可用"） */
export const BRIDGE_SCRIPT_EXISTS = fs.existsSync(BRIDGE_SCRIPT)
/** 用的是不是自带内核（false = 被 env 指到了别处） */
export const USING_BUNDLED_KERNEL = BRIDGE_SCRIPT === BUNDLED_BRIDGE

/* ── Python 解释器解析（0913 事故修复 / 0917 二次重做）───────────────
 * 背景：此前用裸 'python' 走 PATH。计划任务的 PATH 里第一个命中的是 hermes venv，
 * 其 transformers 包 import 结构扫描冷启动可耗时 40s+（多实例争抢时可到分钟级），
 * 表现为「记忆桥卡死」；不同上下文（终端/任务）还会解析到不同解释器，行为不确定。
 * 且实测：**没有嵌入依赖（sentence_transformers）的解释器会静默降级 FTS**——
 * 语义检索直接返回空结果（质量事故），所以不能随便换「更快」的裸解释器。
 *
 * ⚠️ 0917 二次事故（用户报「导出记忆/导出知识库/写记忆全失败」）：
 *   NiusDream.exe 拉起后端时注入的进程环境里 **PATH 不含任何用户装的东西**，
 *   于是最后一个候选 `'python'` 直接 ENOENT → 子进程根本起不来 →
 *   桥永远 ready=false → 所有 memory_* / knowledge_* op 报 "memory-bridge not ready"。
 *   （开发终端里测得到是因为那个终端自己带了 PATH —— 典型的「我这儿是好的」。）
 * 现在策略：**绝对路径优先**，把 NiusDream 自管的 memory venv / 常见安装位置全列上，
 * 裸名与 py 启动器只作最后兜底。
 * ─────────────────────────────────────────────────────────────── */
type PyCand = { bin: string; pre: string[]; origin?: 'own' | 'legacy' | 'system' }
let _pythonCand: PyCand | null = null
/** 允许外部（装完语义环境后）强制重新解析一次 */
export function resetMemoryPython(): void {
  _pythonCand = null
}
/** Resolve the same installed interpreter for stdlib-only offline jobs. Does not start a bridge. */
export function memoryPythonCommand(): { bin: string; pre: string[] } {
  const cand = resolvePythonCand()
  if (!cand) throw new Error('未找到 Python，请先在软件环境安装 Python')
  return { bin: cand.bin, pre: [...cand.pre] }
}
function pythonCandidates(): PyCand[] {
  const cands: PyCand[] = []
  const seen = new Set<string>()
  const push = (bin?: string | null, pre: string[] = [], origin: PyCand['origin'] = 'system'): void => {
    const s = String(bin || '').trim()
    if (!s) return
    const key = s.toLowerCase() + '|' + pre.join(',')
    if (seen.has(key)) return
    seen.add(key)
    cands.push({ bin: s, pre, origin })
  }
  const LP = process.env.LOCALAPPDATA || ''
  const PF = process.env.ProgramFiles || 'C:\\Program Files'
  const UP = process.env.USERPROFILE || process.env.HOME || ''
  /* ── 本实例自管的语义环境（设置→软件环境→记忆检索模型）—— 永远排第一、且只信它 ──
   * 0918：envDir 由 server.ts 按 `<数据根>/env` 注入（或用户显式指定），dev 与打包版天然不同。 */
  const envDir = String(process.env.NIS_ENV_DIR || '').trim()
  if (envDir) {
    push(path.join(envDir, 'memory-venv', 'Scripts', 'python.exe'), [], 'own')
    push(path.join(envDir, 'python.exe'), [], 'own')
  }
  push(process.env.NIS_MEMORY_PYTHON, [], 'own')
  /* ── 老位置的共享 venv（0918 前所有实例都用它）── 留作兜底，但用到了会告警 ── */
  push(UP ? path.join(UP, 'NISEnv', 'memory-venv', 'Scripts', 'python.exe') : '', [], 'legacy')
  push(path.join(LP, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe'), [], 'legacy')
  /* ⚠️ 0918 移除：以前这里有两条指向**网页版安装目录**的 venv
   *   （`<旧内核目录>\.venv`、`…\src-python\.venv`）。
   *   那是"客户端偷偷用网页版环境"的直连——网页版一升级/一删，客户端就变形。
   *   语义环境必须由本实例自己装（设置→软件环境→记忆检索模型）。 */
  // 常见 Python 安装位置（winget 装 Python.Python.3.1x 的默认落点）—— 只是解释器，不带依赖，仅作 FTS 降级兜底
  for (const v of ['313', '312', '311']) {
    push(path.join(LP, 'Programs', 'Python', 'Python' + v, 'python.exe'))
    push(path.join(PF, 'Python' + v, 'python.exe'))
  }
  push('C:\\Python313\\python.exe')
  try {
    const uvRoot = path.join(process.env.APPDATA || '', 'uv', 'python')
    for (const d of fs.readdirSync(uvRoot).sort().reverse()) {
      push(path.join(uvRoot, d, 'python.exe'))
    }
  } catch { /* ignore */ }
  // 兜底：裸名 + Windows 的 py 启动器（后者要带 -3）
  push('python')
  push('py', ['-3'])
  return cands
}
/** python 可执行文件旁边可能放 site-packages 的位置（Windows venv / 便携版 / embed 包三种布局） */
function sitePackageDirs(bin: string): string[] {
  const dir = path.dirname(bin)                     // venv\Scripts 或 venv\bin 或 embed 根
  return [
    path.join(dir, '..', 'Lib', 'site-packages'),   // 标准 venv：venv\Scripts\python.exe → venv\Lib\site-packages
    path.join(dir, 'Lib', 'site-packages'),         // 便携/embed：python.exe 旁边的 Lib
    path.join(dir, '..', 'lib', 'site-packages'),
    path.join(dir, 'site-packages'),                // 有些打包版直接把包放脚本目录
  ]
}

function resolvePythonCand(): PyCand | null {
  if (_pythonCand) return _pythonCand
  /* ★P115：**探测不再 spawn python**。
     原来 `probe()` 用 `spawnSync(python, ['-c', 'import ... find_spec(...)'])` **逐个候选**跑一遍 ——
     venv 里 python 启动本身就要 1~2 秒（加载 site-packages），候选 4~5 个 ⇒ 实测
     `[eventloop] 主线程被堵 15092ms`，整个后端在这 15 秒里是死的（老大："刚打开就卡"）。
     现在改成**查文件**：python 可执行文件在不在 + 它旁边 site-packages 里有没有 sentence_transformers 目录。
     这是事实检查（毫秒级）：包目录在 ⇒ 能 import；不在 ⇒ 不能。
     ⚠️ `py` 这类**启动器**（不是 exe、无法用文件定位解释器）按"可用但无嵌入依赖"处理 ——
        宁可降级到 FTS，也不谎报"有语义能力"（那会让 bridge 起来后 import 失败）。 */
  const probe = (c: PyCand): number => {
    try {
      const looksLikePath = c.bin.includes('/') || c.bin.includes('\\') || /\.exe$/i.test(c.bin)
      if (!looksLikePath) return 1              // py 启动器 / 裸名：无法静态判定，按降级处理
      if (!fs.existsSync(c.bin)) return 0
      for (const sp of sitePackageDirs(c.bin)) {
        if (fs.existsSync(path.join(sp, 'sentence_transformers'))) return 2
      }
      return 1
    } catch { return 0 }
  }
  let degraded: PyCand | null = null
  for (const c of pythonCandidates()) {
    const s = probe(c)
    if (s === 2) {
      _pythonCand = c
      console.log(`[memory-bridge] python = ${[c.bin, ...c.pre].join(' ')}（含嵌入依赖，语义检索）${originNote(c)}`)
      return c
    }
    if (s === 1 && !degraded) degraded = c
  }
  _pythonCand = degraded
  if (_pythonCand) {
    console.log(`[memory-bridge] python = ${[_pythonCand.bin, ..._pythonCand.pre].join(' ')}（无嵌入依赖 → FTS 降级模式；可在 设置→软件环境 安装「记忆检索模型」恢复语义检索）${originNote(_pythonCand)}`)
  } else {
    console.error('[memory-bridge] 未找到任何可用的 Python → 记忆/知识库功能不可用。请到 设置→软件环境 安装「Python」与「记忆检索模型」。')
  }
  return _pythonCand
}

/** 用的不是本实例自管环境时，明说（双实例排查最容易在这里踩坑：以为装了、其实在用别人的） */
function originNote(c: PyCand): string {
  if (c.origin === 'own') return ' · 本实例自管环境'
  if (c.origin === 'legacy') return ' · ⚠ 用的是**共享/遗留**环境（非本实例自管），建议到 设置→软件环境 装「记忆检索模型」'
  return ' · ⚠ 用的是**系统解释器**（非本实例自管），只能 FTS'
}

/* ── 数据目录（0913 初版 / **0918 独立 / 0919 定稿**）──────────────────
 * 现规则（用户 0919 口径：**记忆和知识库也在各自应用自己的文件目录里**）：
 *   memory 目录 = `NIS_MEMORY_DIR`（有值就用，**打包版由壳注入 `%APPDATA%\nis\memory`**）
 *               → 否则 `<DATA_ROOT>/memory`（dev/命令行：backend/data/memory）。
 *   ⚠️ **不再跟随「设置→通用→存储目录」**。存储目录是给**对话工作区**用的、用户可换的位置；
 *      以前记忆库跟着它走，于是①换存储目录记忆库就漂移 ②导入数据包（包内 settings 把
 *      storagePath 指到包里的 niscs）会直接读到那个包的历史记忆 —— 都已修掉。
 *
 * ⚠️ 0918 用户明确：「网页版用网页版的目录，客户端用客户端自己的，不要串」→
 *    已**删除**旧的「缺省回退旧网页版目录 + 首启把旧库整包拷过来」的行为
 *    （旧目录 = <旧内核目录>\.nis_data）。两边的记忆库/知识库从此互不影响。
 *    注意：只隔离**数据**；python 内核脚本仍默认引用那份（可用 NIS_BRIDGE_SCRIPT 覆盖）。 */
let _dataDirOverride = ''


/** 本应用自己的记忆/知识库目录。
 *  ★ 0924 用户定死：锁死【应用安装目录】下的固定文件夹 `memory/` —— 不随「设置→存储目录」漂移，
 *    以后打包同样规则（安装版=壳注入 `<安装目录>/memory`；dev/命令行=本函数兜底 `<项目根>/memory`）。 */
export function defaultMemoryDir(): string {
  return path.join(path.dirname(BACKEND_ROOT), 'memory')
}

/** 0924 搬家（v2·认标记不认"有库"）：把旧位置（<DATA_ROOT>/memory）的真库整包拷到新家（拷贝不删旧，可回滚）。
 *  幂等靠**标记文件** `.seeded-0924-lockdir`：只有"有库且有标记"才跳过；发现无标记野库
 *  （0924 实案：storagePath 老库被老播种逻辑灌进来抢占新家）→ 归档为 .wrongseed-<时间> 后再搬真库。 */
function seedFromLegacyMemoryDir(want: string): void {
  const legacy = path.join(DATA_ROOT, 'memory')
  const marker = path.join(want, '.seeded-0924-lockdir')
  try {
    if (path.resolve(legacy) === path.resolve(want)) return
    const targetHas = fs.existsSync(path.join(want, 'memory_system.db'))
    const marked = fs.existsSync(marker)
    if (targetHas && marked) return
    if (!fs.existsSync(path.join(legacy, 'memory_system.db'))) {
      // 没有旧库源：全新安装（或已搬完旧库被清理）——写标记避免下次再猜
      if (!targetHas) { try { fs.writeFileSync(marker, 'fresh: ' + new Date().toISOString()) } catch { /* ignore */ } }
      return
    }
    if (targetHas && !marked) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
      for (const f of fs.readdirSync(want)) {
        if (/^(memory_system\.db|knowledge\.db)(-wal|-shm)?$/.test(f)) {
          fs.renameSync(path.join(want, f), path.join(want, f + '.wrongseed-' + stamp))
        }
      }
      console.warn('[memory-bridge] 0924 搬家 v2：发现无标记野库（非本规则搬入），已归档为 .wrongseed-' + stamp)
    }
    let n = 0
    for (const f of fs.readdirSync(legacy)) {
      if (/^(memory_system\.db|knowledge\.db)(-wal|-shm)?$/.test(f)) {
        fs.copyFileSync(path.join(legacy, f), path.join(want, f))
        n++
      }
    }
    fs.writeFileSync(marker, `seeded ${new Date().toISOString()} from ${legacy} (${n} files)`)
    if (n) console.log(`[memory-bridge] 0924 搬家 v2：真库 ${n} 个文件已拷到 ${want}（旧的保留在 ${legacy} 可回滚）`)
  } catch (e) {
    console.warn('[memory-bridge] 搬家拷贝失败（不影响启动，仍用新目录）:', e)
  }
}

function resolveDataDir(): string {
  const want = _dataDirOverride || String(process.env.NIS_MEMORY_DIR || '').trim() || defaultMemoryDir()
  try {
    fs.mkdirSync(want, { recursive: true })
    seedFromLegacyMemoryDir(want)
    return want
  } catch (e) {
    console.warn('[memory-bridge] 数据目录准备失败，回退 NiusDream 默认目录：', e)
    const fb = defaultMemoryDir()
    try { fs.mkdirSync(fb, { recursive: true }) } catch { /* ignore */ }
    return fb
  }
}

/** 本实例**实际生效**的记忆/知识库数据目录（与桥 spawn 时注入的 NIS_MEMORY_DIR 完全同源） */
export function currentMemoryDir(): string {
  return resolveDataDir()
}

interface PendingCall {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

class MemoryBridge {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingCall>()
  private buf = ''
  private seq = 0
  private ready = false
  private readyWaiters: Array<() => void> = []
  private started = false
  /* ★0927（用户"不出任何问题"）：**崩溃自愈** —— 曾经正常就绪过的桥**意外退出**后，
     下次调用时自动重启一次（60s 冷却防 spawn 风暴；退出超过 5 分钟不再自动管）。
     从没就绪过（缺 Python 等）不乱试，保持原来那句"去哪儿修"的明确报错；
     故意 stop()（迁移/关机）会清掉 exitedAt，不会误触发自愈。 */
  private everReady = false
  private exitedAt = 0
  private lastRespawnAt = 0
  /** ★1003 并发批 4.19：故意 stop() 的标记 —— 被杀进程的 exit 晚到时不许再点亮崩溃自愈判据 */
  private stopping = false

  /** 启动子进程（幂等）。失败不抛出，调用侧可检测 isReady。 */
  start(): void {
    if (this.started) return
    this.stopping = false   // 新生命周期：清掉上一轮故意停的标记
    this.started = true
    const cand = resolvePythonCand()
    if (!cand) {
      // 找不到 Python：不 spawn（否则只会拿到一个静默失败的死进程），直接保持未就绪
      this.started = false
      return
    }
    try {
      const dataDir = resolveDataDir()
      // 0918：把"这套实例到底用的哪份内核 / 哪个数据目录"打出来 —— 双版本排查第一眼就看这行
      console.log(
        '[memory-bridge] 内核 = ' + BRIDGE_SCRIPT
        + (USING_BUNDLED_KERNEL ? '（自带）' : '（⚠ 回落网页版老脚本，建议切回自带内核）')
        + ' · 数据 = ' + dataDir,
      )
      this.proc = spawn(cand.bin, [...cand.pre, BRIDGE_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 0913：数据目录注入（记忆/知识库/知识库附件——跟随「设置→通用→存储目录」）
        env: { ...process.env, NIS_MEMORY_DIR: dataDir },
      })
    } catch (e) {
      /* ★1003 并发批 4.17：原来不复位 started ⇒ 同步炸一次后 `if (this.started) return` 永久短路，
       * 桥在整个进程生命周期内再也起不来（记忆功能永久哑火）。失败=没起来，如实复位。 */
      console.error('[memory-bridge] spawn failed:', e)
      this.started = false
      this.proc = null
      return
    }

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        this.handleLine(line)
      }
    })

    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (chunk: string) => {
      // 模型加载进度条/警告走 stderr，只记日志
      const s = chunk.trim()
      if (s && !s.includes('%|')) console.log('[memory-bridge] stderr:', s.slice(0, 200))
    })

    /* ★1003 并发批 4.18/4.19：事件回调一律**认实例**（this.proc 可能已换成新进程）——
     * 旧进程晚到的 error/exit 不许干掉新进程的状态与 pending。 */
    const proc = this.proc
    proc.stdin?.on('error', (e: any) => {
      /* ★4.18：stdin 的 EPIPE 原来无人接 = uncaughtException，可炸整个后端 */
      console.warn('[memory-bridge] stdin error（写入端已断）:', String(e?.message || e))
    })
    proc.on('error', (err) => {
      console.error('[memory-bridge] process error:', err)
      /* ★4.18：spawn 失败（ENOENT/被杀）走 'error'，Node 文档明言 'exit' 可能不再来 ——
       * 不复位就永远 started=true 的死桥（call 全写死管道、start 永不重试）。 */
      if (this.proc === proc) {
        this.proc = null
        this.ready = false
        this.started = false
        this.exitedAt = Date.now()
        this.rejectAll(new Error('memory-bridge spawn failed: ' + String((err as any)?.message || err)))
      }
    })
    proc.on('exit', (code, signal) => {
      /* ★4.19：① 只在仍是本实例时动共享状态（respawn/stop+start 后旧进程晚到的 exit 不许
       * 顶掉新 proc/清 pending）；② stopping=故意停 —— 不点亮自愈判据（原来 stop() 清了
       * exitedAt 又被晚到的 exit 重新写上 ⇒ 故意停的桥被 call() 偷偷复活）。 */
      if (this.proc !== proc) return
      console.error(`[memory-bridge] exited code=${code} signal=${signal}`)
      this.rejectAll(new Error('memory-bridge exited'))
      this.proc = null
      this.ready = false
      this.started = false
      if (!this.stopping) this.exitedAt = Date.now()   // ★0927：意外退出时间戳（call 的自愈判据）
      this.stopping = false
    })
  }

  /** 停止子进程（迁移存储目录等需释放 sqlite 句柄时用；之后可再 start()） */
  stop(): void {
    /* ★1003 并发批 4.19：打"故意停"标 —— 被杀进程的 exit 事件会晚到，不许它把 exitedAt
     * 重新点亮（原来 stop() 清 0 后又被晚到的 exit 写上 ⇒ 故意停的桥被 call() 偷偷复活） */
    this.stopping = true
    try { this.proc?.kill() } catch { /* ignore */ }
    this.proc = null
    this.ready = false
    this.started = false
    this.exitedAt = 0   // ★0927：故意停 ≠ 崩溃，清掉自愈判据
    this.rejectAll(new Error('memory-bridge stopped'))
  }

  /** 等待 Python 侧 ready（10s 超时） */
  waitReady(timeoutMs = 10000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** 调用一个 op，返回 result。进程未就绪/已退出时抛错。 */
  call(op: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.proc || !this.ready) {
      /* ★0927 崩溃自愈：曾经正常过且是**意外退出**（5 分钟内）→ 自动重启一次
         （60s 冷却），本次调用仍如实报错（不装就绪），下一次调用即可用——
         记忆功能不再因一次崩溃永久哑火。 */
      if (this.everReady && this.exitedAt > 0 && Date.now() - this.exitedAt < 5 * 60 * 1000
          && Date.now() - this.lastRespawnAt > 60000) {
        this.lastRespawnAt = Date.now()
        console.warn(`[memory-bridge] 检测到桥意外退出（op=${op}）→ 自动重启（60s 冷却内不重复）`)
        try { this.start() } catch { /* 重启失败不阻塞报错 */ }
        return Promise.reject(new Error(`memory-bridge 意外退出，正在自动重启——请稍后重试（op=${op}）`))
      }
      // 0918：不再只丢一句 "not ready" —— 直接把"去哪儿修"写进错误里（本机缺 Python 是最常见原因）。
      //   保留 memory-bridge not ready 前缀，日志/排查仍能搜到。
      return Promise.reject(new Error(
        `memory-bridge not ready (op=${op})：记忆/知识库需要本机 Python 环境。`
        + '请到「设置 → 通用 → 软件环境」安装「记忆检索模型」（会一并装好 Python 与嵌入模型，'
        + '装完自动重连桥）；若已安装仍报此错，重启应用一次。',
      ))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      /* ★1003 并发批 4.20 三连修：① TOCTOU —— 上面检查后 proc 可能被 exit 处理器置空，
       * 原 `this.proc!.stdin!.write` 在 executor 里抛 TypeError（pending 泄漏、报错难懂）；
       * ② write 裸调 —— 同步抛/EPIPE 静默丢消息，调用方 promise **永挂**；③ 无请求时限 ——
       * 桥半死=永久挂。现在：就地复检 + try/catch + 写回调拒错 + 60s 超时兜底。 */
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`memory-bridge 请求超时（60s，op=${op}）`))
      }, 60_000)
      this.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v) },
        reject: (e: Error) => { clearTimeout(timer); reject(e) },
      })
      const stdin = this.proc?.stdin
      const fail = (msg: string) => {
        clearTimeout(timer)
        if (this.pending.delete(id)) reject(new Error(`memory-bridge ${msg}（op=${op}）`))
      }
      if (!stdin) { fail('stdin 不可用（进程已退出）'); return }
      const line = JSON.stringify({ op, id, params })
      try {
        stdin.write(line + '\n', 'utf8', (err) => {
          if (err) fail('写入失败：' + String(err.message || err))
        })
      } catch (e: any) {
        fail('写入异常：' + String(e?.message || e))
      }
    })
  }

  private handleLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    /* ★memp1：内核「已就绪但预加载失败 / 语义模型降级」必须留痕 —— 原来这类信息只进 Python 的
       stderr，还会被下面 stderr 转发的 200 字截断，后端日志里查不到完整原因。
       **不动控制流**：ready=true 照旧点亮（内核仍可接活，op 内会惰性重试建连）。 */
    if (msg.ready === true && (msg.degraded || msg.preloadError)) {
      console.warn('[memory-bridge] ⚠ 内核已就绪但**预加载降级**（记忆/知识库调用可能现场报错）：'
        + String(msg.preloadError || msg.degraded).slice(0, 500))
    }
    if (msg.ready === true) {
      this.ready = true
      this.everReady = true
      const waiters = this.readyWaiters
      this.readyWaiters = []
      for (const w of waiters) w()
      return
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'memory-bridge error'))
    }
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

/** 全局单例（pi-bridge 进程内一个 Python 子进程） */
export const memoryBridge = new MemoryBridge()

/* ── 0924 二期批6b 核心小抄：高频记忆摘要缓存 ────────────────────────────
 * 桥就绪后拉「命中最多的 5 条摘要」，**随本轮用户消息尾部注入**（★1014n 从工具描述迁出，原因见下）——
 * 每轮发消息时读缓存 ⇒ 会话级常驻速查（≈200 字），省一次检索往返。
 * 失败静默等下轮（每 5 分钟刷新）；桥未就绪时调用会 reject，属预期。 */
let _digestLines = ''
/* ★1014n：**改从「本轮用户消息尾部」注入**（原先拼在 memory / memory_search 的工具描述里）——
   工具表在缓存前缀头，速查一变就把整段前缀作废；移到本轮消息尾部 = 纯追加，零前缀伤害。
   调用点：server.ts 发消息处（finalMessage 末尾，且本轮冻住）。 */
export function coreDigestLine(): string {
  return _digestLines ? `\n【核心记忆速查（高频常用，可直接引用）】\n${_digestLines}` : ''
}
async function refreshDigest(): Promise<void> {
  try {
    const r = await memoryBridge.call('memory_digest', { top_k: 5 })
    _digestLines = (r?.items || [])
      .map((m: any) => `- [${m.memory_type}] ${m.summary}`)
      .join('\n')
  } catch { /* 桥未就绪/失败：等下轮 */ }
}
setInterval(() => { void refreshDigest() }, 5 * 60 * 1000)
void refreshDigest()
/* ★1014n：**启动那次常撞上 Python 桥还没就绪**（`void refreshDigest()` 探活失败被静默吞掉），
   而下一次要等 5 分钟 ⇒ 实测"重启后头 5 分钟没有速查"。这里补两次短延迟重试，把窗口压到 ~30s。 */
setTimeout(() => { void refreshDigest() }, 15 * 1000)
setTimeout(() => { void refreshDigest() }, 40 * 1000)

/* ── 0924 二期批6b-2 记忆蒸馏 ────────────────────────────────────────────
 * 散碎同主题记忆 →（LLM）合成主题记忆草案 → 打 pending_review 进「待确认」，由用户把关（A+C 衔接）。
 * LLM 用依赖倒置注入（server.ts 启动时 setDistillLlm(llmOnceDirect)），避免 memoryBridge↔server 循环引用。 */
type DistillLlm = (prompt: string, system: string, opts?: any) => Promise<string>
let _distillLlm: DistillLlm | null = null
export function setDistillLlm(fn: DistillLlm) { _distillLlm = fn }

export async function memoryDistill(): Promise<{ ok: boolean; saved: number; msg: string; drafts?: any[] }> {
  if (!_distillLlm) return { ok: false, saved: 0, msg: '蒸馏的 LLM 未注入（重启后端可恢复）' }
  const g = await memoryBridge.call('memory_graph', { scope: 'all' })
  const mems = (g?.nodes || []).filter((n: any) => String(n.id || '').startsWith('mem_'))
  if (mems.length < 3) return { ok: true, saved: 0, msg: '记忆少于 3 条，暂不需要整理' }
  const list = mems.slice(0, 60)
    .map((m: any, i: number) => `${i + 1}. [${m.node_type}] ${String(m.summary || m.content || '').slice(0, 60)}`)
    .join('\n')
  const prompt = [
    `下面 ${list.split('\n').length} 条记忆里，把**同主题的散碎条目**合并成主题记忆（最多 5 条；确有必要才合并，没有就输出 []）。`,
    '输出严格 JSON 数组（不要 markdown 围栏、不要多余文字）：',
    '[{"category":"preference|decision|lesson|pattern|fact|profile","summary":"摘要≤60字","content":"合并后的详情≤200字（可含条目编号溯源）"}]',
    '===== 记忆清单 =====',
    list,
  ].join('\n')
  const raw = await _distillLlm(prompt, '你是记忆整理助手，只输出 JSON 数组。', { maxTokens: 2000, timeoutMs: 60000 })
  const s0 = String(raw || '')
  const a0 = s0.indexOf('[')
  const a1 = s0.lastIndexOf(']')
  let arr: any[] = []
  try { arr = a0 >= 0 && a1 > a0 ? JSON.parse(s0.slice(a0, a1 + 1)) : [] } catch { arr = [] }
  if (!Array.isArray(arr) || !arr.length) return { ok: true, saved: 0, msg: '没有需要合并的同主题记忆' }
  let saved = 0
  const CATS = ['preference', 'decision', 'lesson', 'pattern', 'fact', 'profile']
  for (const d0 of arr.slice(0, 5)) {
    const content = String(d0?.content || '').trim()
    if (!content) continue
    try {
      await memoryBridge.call('memory_store', {
        content,
        summary: String(d0?.summary || '').slice(0, 60),
        category: CATS.includes(String(d0?.category)) ? String(d0.category) : 'fact',
        source: 'extract',
        tags: ['pending_review', 'from_distill'],
      })
      saved++
    } catch { /* 单条失败不阻塞 */ }
  }
  return { ok: true, saved, msg: saved ? `已生成 ${saved} 条主题记忆草案（在「待确认」等你审）` : '草案均落盘失败', drafts: arr.slice(0, 5) }
}

/** memory_distill：整理/蒸馏记忆（AI 主动维护记忆库用） */
function buildMemoryDistillTool(): AgentTool<any> {
  return {
    name: 'memory_distill',
    label: '整理记忆',
    description: '记忆蒸馏：把库里**同主题的散碎记忆**合并成主题记忆草案（草案打待确认标记，用户在「记忆库→待确认」把关）。适合记忆条目多而碎时定期调用（如发现一堆同主题小条目）；记忆少或没同主题就不用调。',
    parameters: Type.Object({}),
    async execute() {
      const r = await memoryDistill()
      return {
        content: [{ type: 'text', text: r.msg + (r.drafts?.length ? `\n草案：\n${r.drafts.map((d: any, i: number) => `${i + 1}. [${d.category}] ${d.summary}`).join('\n')}` : '') }],
        details: { ok: r.ok, saved: r.saved },
      }
    },
  }
}

// ============================================================================
// Agent 工具定义
// ============================================================================

function formatMemories(memories: any[]): string {
  if (!memories?.length) return '（没有找到相关记忆）'
  const body = memories.map((m: any, i: number) => {
    const tags: string[] = Array.isArray(m.tags) ? m.tags : []
    const plain = tags.filter((t: string) => !String(t).startsWith('src:')).join(',')
    const src = tags.find((t: string) => String(t).startsWith('src:'))
    const meta = [
      m.pending ? '⚠️待确认(未审核,先核实再用)' : '',
      `类别=${m.memory_type}`,
      m.hit_count ? `用过${m.hit_count}次` : '',
      src ? `来源=${String(src).slice(4)}` : '',
      plain ? `[${plain}]` : '',
    ].filter(Boolean).join(' ')
    const conf = m.score != null ? ` (相关度${m.score})` : ''
    return `${i + 1}. [${m.id}] ${meta}${conf} ${m.content}`
  }).join('\n')
  return body + '\n（默认给摘要/节选；要全文：同 query 带 detail=true 再查一次）'
}

function formatEntries(entries: any[]): string {
  if (!entries?.length) return '（知识库为空或没有命中）'
  return entries.map((e: any, i: number) => {
    const content = String(e.content || '').slice(0, 400)
    return `${i + 1}. [${e.entry_type}][id=${e.id}] ${e.title}\n   ${content}`
  }).join('\n')
}

/** 本实例记忆/知识库的**真实路径**（注入到工具描述里，AI 才能直接告诉用户库在哪）。
 *  路径由 runtime 决定（打包版 = <安装目录>\memory），所以必须运行时取，不能写死。 */
function memoryLocationHint(): string {
  try {
    const d = currentMemoryDir()
    return `【本实例位置】记忆库 ${d}\\memory_system.db ；知识库 ${d}\\knowledge.db`
  } catch {
    return ''
  }
}

/** memory_search：检索长期记忆（偏好/决策/教训/进度） */
function buildMemorySearchTool(): AgentTool<any> {
  return {
    name: 'memory_search',
    label: '检索记忆',
    description: '检索 Nis 的长期记忆（用户偏好、决策、教训、项目进度等）。适合回答"用户之前说过/喜欢什么"或回忆历史。【主动读纪律★0930】涉及偏好/历史/进度/教训/"上次·之前·还记得"/第一次接手某项目任务——先搜再答，别等用户点名。'
      + '【用法规矩（0924 拍板）】结果带 pending=true 或 ⚠️待确认 的是**未确认记忆**（自动提炼/待用户审核）——只可当线索，'
      + '【口径★1010k】返回的是**本次检索命中的条数**，不是全库总量——别把命中数当库存数报给用户；要判断库多大看记忆面板。'
      + '当事实使用前必须先与用户核实；已确认记忆可直接用。' + memoryLocationHint(),   /* ★1014n：原此处拼 coreDigestLine()，已迁到本轮用户消息尾部（见 server.ts） */
    parameters: Type.Object({
      query: Type.String({ description: '要检索的记忆关键词或语义描述' }),
      top_k: Type.Optional(Type.Number({ description: '返回条数（默认 5，最多 20）' })),
      detail: Type.Optional(Type.Boolean({ description: 'true=返回全文详情（默认只给摘要+节选，省上下文；拿到 id 后想看全文再带它查一次）' })),
    }),
    async execute(_callId, params: any) {
      const result = await memoryBridge.call('memory_search', {
        query: params.query,
        top_k: Math.min(params.top_k || 5, 20),
        detail: !!params.detail,
      })
      /* ★memp1：语义模型失败降级 FTS 时，「第一次降级」由内核带一条 degraded_notice —— 必须让
         agent/用户看见（原来只有"搜不到"这一种表现，检索质量骤降却无感）。 */
      const notice = String(result.degraded_notice || '')
      if (notice) console.warn('[memory-bridge] ⚠ ' + notice)
      return {
        content: [{
          type: 'text',
          text: (notice ? `⚠️ ${notice}\n（本次结果按关键词匹配返回，可能漏召回；模型修好后自动恢复）\n` : '')
            + formatMemories(result.memories),
        }],
        details: { retrieval: result.retrieval_method, count: result.memories?.length || 0, detail: !!params.detail },
      }
    },
  }
}

/** memory_store：存入一条长期记忆 */
function buildMemoryStoreTool(): AgentTool<any> {
  return {
    name: 'memory_store',
    label: '记忆',
    description: '把值得记住的长期信息存入 Nis 记忆库。**写入必须归类（category）**：preference=用户偏好/明确要求、decision=重要决定、lesson=踩过的坑/教训、pattern=可复用做法/规律、fact=项目事实与进度、profile=用户是谁（称呼/长期画像）。只在用户明确表达、被纠正/踩坑或你确认重要时调用。' + memoryLocationHint(),
    parameters: Type.Object({
      content: Type.String({ description: '要记住的内容（简洁陈述句）' }),
      category: Type.Optional(Type.String({ description: '类别（推荐必填）：preference/decision/lesson/pattern/fact/profile 之一，不填默认 fact' })),
      summary: Type.Optional(Type.String({ description: '一句话摘要（≤60字），进检索索引层；不填自动取首句' })),
      memory_type: Type.Optional(Type.String({ description: '旧式类型直传（semantic/preference/procedure/project_lesson/project_decision/user_profile）；优先用 category' })),
      /* ★g5：importance 明确定级（老板 1112 拍板）。
         不填时后端按 category **自动给保底分**，所以不填也不会错到离谱；
         但填对了能显著提升"常驻记忆"（每轮注入的那几条）的命中质量 —— 那里按 importance 排序。 */
      importance: Type.Optional(Type.Number({ description:
        '重要度 0~1，不填则按类型给保底。**0.9**=用户铁律/否决（"不许/必须"，违反就是错）｜'
        + '**0.8**=已定决策/用户画像｜**0.7**=用户偏好（习惯/审美/表达）｜'
        + '**0.6**=踩坑教训/可复用做法｜**0.4**=事实与进度（能从代码、档案、git 查到）。'
        + '判据：下次遇到同类事，不知道它会不会做错？会→≥0.7；只是省时间→0.5~0.6；能查到→≤0.4。' })),
    }),
    async execute(_callId, params: any) {
      const result = await memoryBridge.call('memory_store', {
        content: params.content,
        category: params.category || '',
        summary: params.summary || '',
        memory_type: params.memory_type || '',
        /* 不传就不传（让后端按类型给保底），**不要**在这里补 0.5 —— 那正是这个 bug 的成因。 */
        ...(typeof params.importance === 'number' ? { importance: params.importance } : {}),
        source: 'ai',
      })
      /* ★ 0922z3-3（反馈「记忆重复计入：长期记忆 + 待审核各一份」）：
       * 这里原来还会**再建一个** `tags: ['pending_review', 'from_memory_store']` 的网图节点，
       * 于是同一条内容同时出现在两处：
       *   · `memory_store` 已把记忆行写成 **ACTIVE** ⇒ 记忆星系「长期记忆」里一份；
       *   · 那个节点带 pending_review ⇒「待确认」里又一份（真机取证：dev 库 11 组、本机库 4 组）。
       * 而且「丢弃」只删得掉节点（`memory.node.delete`），记忆行照样生效、照样被检索 —— 是个假动作。
       * 结论：AI 主动 `memory_store` = 用户明确要求记住的**已生效**长期记忆，不另发待确认卡片；
       *      「待确认」只服务真正的候选来源（记忆提炼 auto / 知识库提案，它们本来就只写节点）。
       * 历史遗留的重复卡片由 setup 侧脚本清理（带库备份，见 _cleanup_dup_pending_nodes.py）。 */
      return {
        content: [{ type: 'text', text: result.memory ? `已记住：${result.memory.content}` : '记忆存储失败' }],
        details: result.memory || {},
      }
    },
  }
}

/** knowledge_query：检索本地知识库 */
/** ★1126：知识检索范围（由 server.ts 按项目绑定注入）。
 *  模型与 KnowledgeScopePicker 一致：cats=分组 id、entryIds=单条 id；allowExternal=false ⇒ 只能搜这些。 */
let knowledgeScope: { cats: string[]; entryIds: string[]; allowExternal: boolean } | null = null
export function setKnowledgeScope(v: { cats?: string[]; entryIds?: string[]; allowExternal: boolean } | null): void {
  if (!v) { knowledgeScope = null; return }
  const cats = Array.isArray(v.cats) ? v.cats.map(String) : []
  const entryIds = Array.isArray(v.entryIds) ? v.entryIds.map(String) : []
  knowledgeScope = (cats.length || entryIds.length) ? { cats, entryIds, allowExternal: !!v.allowExternal } : null
}

/** ★1126：范围内知识条目的 id 集合（120 秒缓存）。
 *  为什么需要它：`knowledge_query` 的返回条目不带 parent_id，没法直接按分组过滤；
 *  而 `knowledge_list` 带 parent_id —— 用它算一次 id 集合，再拿 id 去过滤 query 结果。 */
let _allowedIdsCache: { key: string; at: number; ids: Set<string> } | null = null
async function allowedEntryIds(cats: Set<string>, ids: Set<string>): Promise<Set<string>> {
  const key = [...cats].sort().join(',') + '|' + [...ids].sort().join(',')
  if (_allowedIdsCache && _allowedIdsCache.key === key && Date.now() - _allowedIdsCache.at < 120_000) return _allowedIdsCache.ids
  const out = new Set<string>(ids)
  try {
    const r: any = await Promise.race([
      memoryBridge.call('knowledge_list', { project_id: '' }),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ])
    for (const e of (Array.isArray(r?.entries) ? r.entries : [])) {
      const pid = String(e?.parent_id || '')
      if (pid && cats.has(pid)) out.add(String(e.id))
    }
  } catch { /* 桥不可用就用传进来的 ids（至少单条绑定的能用） */ }
  _allowedIdsCache = { key, at: Date.now(), ids: out }
  return out
}

function buildKnowledgeQueryTool(projectId = ''): AgentTool<any> {
  return {
    name: 'knowledge_query',
    label: '知识库检索',
    description:
      '检索本地知识库（已收藏的文档、学习笔记、参考资料）。适合回答需要查知识库的问题；空查询可列出最近条目。【主动读纪律★0930】技术做法/资料/参考类问题先查再答，答案可能就在库里。' +
      '返回里会附上**现有分类清单**——准备写入（knowledge_add）前先看一眼，能归到已有分类就别新建。' +
      memoryLocationHint(),
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词（留空列出最近条目）' }),
      top_k: Type.Optional(Type.Number({ description: '返回条数（默认 5）' })),
    }),
    async execute(_callId, params: any) {
      // ★0930 知识库项目绑定：带 project_id → 内核只返回该项目归属的知识（空=全库可见）
      /* ★1126：绑了分组又不允许搜外部时，**多取一些再过滤**（否则过滤完可能只剩 1 条） */
      const restricted = !!(knowledgeScope && !knowledgeScope.allowExternal)
      const want = Math.min(params.top_k || 5, 20)
      /* ★1126：绑了范围就用**范围**判，不再叠加老的"归属制"过滤（那个按 project_id 改知识归属，会漏掉别的项目的知识）。
         没绑范围才沿用旧口径（project_id 归属过滤）。 */
      const result = await memoryBridge.call('knowledge_query', {
        query: params.query,
        top_k: restricted ? Math.min(want * 4, 40) : want,
        project_id: restricted ? '' : (projectId || ''),
      })
      let entries: any[] = Array.isArray(result.entries) ? result.entries : []
      let filteredOut = 0
      if (restricted) {
        const allowCats = new Set(knowledgeScope!.cats)
        const allowIds = new Set(knowledgeScope!.entryIds)
        /* ★1126 修（实测踩到）：`knowledge_query` 返回的条目**没有 parent_id**，
           直接按 parent_id 过滤会把结果全滤光（AI 回复"正文取不到、被权限挡住"）。
           正确做法：先用 knowledge_list 把「范围内条目」的 **id 集合**算出来，再按 id 过滤。
           120 秒缓存，别每轮都拉全量。 */
        const ids = await allowedEntryIds(allowCats, allowIds)
        const before = entries.length
        entries = entries.filter((e: any) => ids.has(String(e?.id || '')))
        filteredOut = before - entries.length
        if (filteredOut) {
          try { console.log('[knowledge_query] 项目绑定限制：过滤掉 ' + filteredOut + ' 条不在绑定分组内的知识') } catch { /* ignore */ }
        }
        if (!entries.length && before > 0) {
          return {
            content: [{
              type: 'text',
              text: '【范围内无结果】命中的 ' + before + ' 条都不在本项目绑定的知识分组里。\n'
                + '本项目只允许检索绑定的分组；确实需要别的分组内容，请在「项目 → 知识库绑定」里勾选，或让用户确认。',
            }],
            details: { hit: false, count: 0, filteredOut },
          }
        }
      }
      const cats = (result.categories || []) as Array<{ name?: string }>
      const catLine = cats.length
        ? '\n\n【现有分类】' + cats.map((c) => String(c?.name || '')).filter(Boolean).join(' / ')
        : '\n\n【现有分类】（还没有分类，可按需新建）'
      return {
        content: [{ type: 'text', text: formatEntries(entries) + catLine }],
        details: { hit: !!result.hit, count: entries.length, categories: cats.length, filteredOut },
      }
    },
  }
}

/** knowledge_add：写入知识库条目 */
function buildKnowledgeAddTool(projectId = ''): AgentTool<any> {
  return {
    name: 'knowledge_add',
    label: '知识库新增',
    description:
      '把有价值的资料/要点存入本地知识库。适合用户要求收藏内容或确认重要的参考资料。' +
      /* ★ 0919 设计口径："以后的未分类让 ai 根据情况来分" —— 所以这里把"你来分类"写进工具契约：
         以前只传 title/content，entry_type 永远落默认值 doc、parent_id 永远空 →
         知识库里全是「文档 + 未分类」，用户还得自己整理。 */
      '【写入前请务必自己判断两件事】' +
      '① entry_type：doc=文档/正式资料；manual=操作手册/使用说明/API 用法；note=笔记/要点/随手记；reference=参考资料/链接/规范条款。' +
      '② category：先调用 knowledge_query 看【现有分类】，能归进去就填那个分类名；确实都不合适才起一个新分类名（不存在会自动创建）；' +
      '实在判断不了就留空（会进「未分类」，别硬编一个）。' +
      memoryLocationHint(),
    parameters: Type.Object({
      title: Type.String({ description: '条目标题' }),
      content: Type.String({ description: '条目正文内容' }),
      entry_type: Type.Optional(
        Type.String({
          description: '条目类型：doc（文档）/ manual（手册）/ note（笔记）/ reference（参考）。按内容自判，默认 doc',
        }),
      ),
      category: Type.Optional(Type.String({ description: '归入的分类名（先 knowledge_query 看现有分类；不合适可给新名，会自动创建；判断不了留空）' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: '标签' })),
    }),
    async execute(_callId, params: any) {
      const type = String(params.entry_type || 'doc')
      const result = await memoryBridge.call('knowledge_add', {
        title: params.title,
        content: params.content,
        entry_type: ['doc', 'manual', 'note', 'reference'].includes(type) ? type : 'doc',
        category: params.category || '',
        tags: params.tags || [],
        project_id: projectId || '',   // ★0930：项目会话里新写的知识自动归属该项目
      })
      const e = result.entry
      // 待确认：自动提炼进审核区（pending_review 标记）
      if (e?.id) {
        try {
          await memoryBridge.call('memory_node_add', {
            title: e.title,
            content: String(e.content || '').slice(0, 400),
            summary: String(e.content || '').slice(0, 60),
            node_type: 'fact',
            scope: 'global',
            project_id: e.project_id || '',
            tags: ['pending_review', 'from_knowledge_add'],
          })
        } catch (err) {
          console.error('[memoryBridge] pending node create failed:', err)
        }
      }
      return {
        content: [{ type: 'text', text: e ? `已存入知识库 [id=${e.id}] ${e.title}` : '写入失败' }],
        details: result.entry || {},
      }
    },
  }
}

/** memory_delete：删除一条长期记忆 */
function buildMemoryDeleteTool(): AgentTool<any> {
  return {
    name: 'memory_delete',
    label: '删除记忆',
    description: '删除 Nis 长期记忆。传 id 精确删除；或传 query 按内容检索后删除匹配条目。' + memoryLocationHint(),
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '记忆 id（memory_search 返回的 id；提供时优先精确删除）' })),
      query: Type.Optional(Type.String({ description: '按内容关键词删除匹配的记忆（id 未提供时使用）' })),
      hard: Type.Optional(Type.Boolean({ description: 'true=物理删除；false/省略=软删（不再检索到）' })),
    }),
    async execute(_callId, params: any) {
      const result = await memoryBridge.call('memory_delete', {
        id: params.id || '',
        query: params.query || '',
        hard: !!params.hard,
      })
      if (result.deleted) {
        return {
          content: [{ type: 'text', text: result.deleted_ids?.length
            ? `已删除 ${result.deleted_ids.length} 条记忆`
            : `已删除记忆 [${result.memory_id}]` }],
          details: result,
        }
      }
      const reason = result.reason === 'not_found' ? '未找到该记忆（id 不存在）'
        : result.reason === 'no_match' ? `没有找到包含「${result.query}」的记忆` : '删除失败'
      throw new Error(reason)
    },
  }
}

/** knowledge_delete：删除知识库条目 */
function buildKnowledgeDeleteTool(): AgentTool<any> {
  return {
    name: 'knowledge_delete',
    label: '知识库删除',
    description: '删除知识库中的一条资料/文档。需要条目 id（knowledge_query 返回的 id）。' + memoryLocationHint(),
    parameters: Type.Object({
      id: Type.String({ description: '知识库条目 id' }),
    }),
    async execute(_callId, params: any) {
      const result = await memoryBridge.call('knowledge_delete', { id: params.id })
      if (result.deleted) {
        return {
          content: [{ type: 'text', text: `已从知识库删除 [${params.id}]` }],
          details: result,
        }
      }
      throw new Error(`删除失败：条目 ${params.id} 不存在`)
    },
  }
}

/** ★1126：画像/项目记忆的写入开关（由 server.ts 按人格设置注入；默认 false = 直接写）
 *  true ⇒ 写入前先返回 needsConfirm，让模型用 ask_user 问一句，用户同意后再带 confirmed:true 重调。 */
let profileWriteConfirm = false
export function setProfileWriteConfirm(v: boolean): void { profileWriteConfirm = !!v }

/** ★1126：编辑「用户画像」(USER.md ≤1400) / 「项目记忆」(MEMORY.md ≤2200)。
 *  为什么单独一个动作：这两份是**每轮注入**的常驻内容，和 SQLite 记忆库完全不同的生命周期
 *  （见 memoryProfile.ts 头注释）。超上限会报错、不自动压缩 —— 逼模型自己合并取舍。 */
function buildProfileTool(): AgentTool<any> {
  return {
    name: 'profile_edit',
    label: '画像/项目记忆',
    description: '编辑「用户画像」(USER.md ≤1400 字) 或「项目记忆」(MEMORY.md ≤2200 字)——这两份**每轮都注入**，'
      + '所以只放长期稳定的内容。'
      + '【判据】用户表达**怎么跟我说话/他是谁** → target=user（分组：说话风格/喜欢/讨厌/协作/背景）；'
      + '**环境事实或铁律**（工具路径、必须遵守的规矩）→ target=agent（分组：环境/铁律）；'
      + '**具体技术教训/决策** → 走 memory(action=store)，别写这里。'
      + '【超上限会报错】不自动压缩，要自己合并或删旧条目再写。',
    parameters: Type.Object({
      target: Type.String({ description: 'user=用户画像 / agent=项目记忆' }),
      mode: Type.String({ description: 'add=追加一条 / patch=改一条（给 oldText）/ remove=删一条（给 oldText）/ read=看全文' }),
      section: Type.Optional(Type.String({ description: '分组名（user: 说话风格/喜欢/讨厌/协作/背景；agent: 环境/铁律；也可自建新分组）' })),
      content: Type.Optional(Type.String({ description: 'add/patch 的内容（一句话，简洁；不要写成长段落）' })),
      oldText: Type.Optional(Type.String({ description: 'patch/remove 要匹配的旧条目片段（包含匹配即可）' })),
      confirmed: Type.Optional(Type.Boolean({ description: '设了「记录前询问」时必须先问过用户，确认后带 true 重调' })),
    }),
    async execute(_c: string, params: any) {
      const target = String(params?.target || '').trim() as ProfileKind
      if (target !== 'user' && target !== 'agent') throw new Error('target 只能是 user 或 agent')
      const mode = String(params?.mode || 'add').trim()
      if (mode === 'read') {
        const doc = readProfile(target)
        return {
          content: [{ type: 'text', text: `${profileTitle(target)}（${doc.chars}/${doc.limit} 字符）\n\n${doc.content}` }],
          details: { ok: true, chars: doc.chars, limit: doc.limit },
        }
      }
      const content = String(params?.content || '').trim()
      const oldText = String(params?.oldText || '').trim()
      /* 记录前询问（人格设置开关）：先不写，把要写的东西原样交回，让模型去 ask_user。 */
      if (profileWriteConfirm && params?.confirmed !== true) {
        const what = mode === 'remove' ? `删掉含「${oldText}」的条目` : `记下：${content || oldText}`
        return {
          content: [{
            type: 'text',
            text: `【需要用户确认】设置里开了「记录前询问」。请用 ask_user 问一句，例如：`
              + `「要把它记进${profileTitle(target)}吗——${what}？」\n`
              + `用户同意后，带上 confirmed:true 再调一次本工具即可写入；不同意就不写。`,
          }],
          details: { ok: false, needsConfirm: true, target, mode },
        }
      }
      /* ★1126 关联**在写入时展开**（不是注入时）：
         注入每轮都跑，桥一挂就展开失败（实测：memory_graph not ready → 裸 id 进了 prompt）；
         写入是低频、失败还能报错给模型重试。所以在这里把 `→ mem_xxx` 换成摘要**存进 md**，
         之后注入直接读文件、零依赖。查不到就明确报错（不吞、不留裸 id）。 */
      let finalContent = content
      const links = parseProfileLinks(content || oldText)
      if (links.length && mode !== 'remove') {
        try {
          const g: any = await memoryBridge.call('memory_graph', { scope: 'all' })
          const nodes: any[] = Array.isArray(g?.nodes) ? g.nodes : []
          for (const l of links) {
            const n = nodes.find((x: any) => String(x?.id) === l.memId)
            if (!n) {
              return {
                content: [{ type: 'text', text: `【写入失败】关联的 ${l.memId} 在记忆库里查不到（可能已删）。\n请先 memory(action="search") 确认 id，或把箭头去掉只保留描述。` }],
                details: { ok: false, error: 'link-not-found', memId: l.memId },
              }
            }
            const sum = String(n?.summary || n?.content || '').replace(/\s+/g, ' ').trim().slice(0, 36)
            finalContent = finalContent.split(l.raw).join(`→ ${l.memId.slice(-6)}「${sum}」`)
          }
        } catch (e: any) {
          return {
            content: [{ type: 'text', text: `【写入失败】展开关联失败（记忆桥不可用）：${String(e?.message || e).slice(0, 120)}\n先去掉「→ mem_xxx」再写，或稍后重试。` }],
            details: { ok: false, error: 'bridge-unavailable' },
          }
        }
      }
      const r = mode === 'patch' ? patchEntry(target, oldText, finalContent)
        : mode === 'remove' ? removeEntry(target, oldText)
          : addEntry(target, String(params?.section || ''), finalContent)
      if (!r.ok) return { content: [{ type: 'text', text: `【写入失败】${r.error}` }], details: { ok: false, error: r.error } }
      const doc = readProfile(target)
      return {
        content: [{
          type: 'text',
          text: `已写入${profileTitle(target)}（${r.action}，分组「${r.section || '-'}」）——现 ${doc.chars}/${doc.limit} 字符`
            + (doc.nearFull ? '\n⚠ 已接近上限：下次写入前请先合并或删掉旧条目。' : '')
            + `\n（下一轮生效：本轮的注入块是会话开始时的快照。）`,
        }],
        details: { ok: true, action: r.action, chars: doc.chars, limit: doc.limit, nearFull: doc.nearFull },
      }
    },
  }
}

/** 记忆/知识库工具集（随 Agent 会话挂载）—— ★ 0929 刀①：7 个合并成 memory(4 动作) + knowledge(3 动作) */
export function buildMemoryTools(opts?: { projectId?: string }): AgentTool<any>[] {
  /* ★0930（知识库项目绑定·客服铺垫）：projectId=会话所属项目 —— knowledge_query/add 只读/落入
     该项目归属的知识；空=不隔离（全库可见）。过滤在 Python 内核的 project_id 条件里做，零新过滤代码。 */
  const pid = String(opts?.projectId || '')
  const subs = [
    buildMemorySearchTool(),       // 0
    buildMemoryStoreTool(),        // 1
    buildMemoryDeleteTool(),       // 2
    buildKnowledgeQueryTool(pid),  // 3
    buildKnowledgeAddTool(pid),    // 4
    buildKnowledgeDeleteTool(),    // 5
    buildMemoryDistillTool(),      // 6
    buildProfileTool(),            // 7 ★1126：画像/项目记忆编辑（每轮注入的两份 md）
  ] as any[]
  return [
    buildFamilyTool({
      name: 'memory',
      label: '记忆',
      group: '记忆',
      variant: 'search',
      tab: 'special',
      fullMemberDescriptions: false,
      description: '记忆工具箱（四动作）：长期记忆（用户偏好/决策/教训/项目进度）。'
        + '【★三个去处，先判这个再动手】'
        + '① 用户说"**以后跟我说话…/别整术语/先给结论**"这类**沟通方式** → **必须用 profile(target="user")**，不要丢进 store；'
        + '② 用户说"**这台机器/这个环境的固定事实或规矩**"（工具路径、版本、端口、必须遵守的硬规矩） → **profile(target="agent")**；'
        + '③ 其他**具体技术教训/决策/事实/进度**（踩的坑、拍板的方案、调研结论） → store。'
        + '⚠️ 库存 90% 的内容走 store；profile 只放"最稳、每轮都该知道"的少数几条（有硬字符上限）。'
        + '【分清】记忆 = 该记住的长期信息；知识库 = 资料收藏（knowledge 工具）；便签 = 用户要办的事（notebook 工具）。\n'
        + '· search：检索（query=关键词或语义描述；top_k 默认 5 最多 20；detail=true 才给全文，默认摘要+节选）。'
        + '【主动读纪律★0930】用户提到/询问偏好、历史决定、项目进度、教训、"上次/之前/还记得"类问题，或第一次接手某项目/任务——**先 search 再回答**，别等用户点名。'
        + '【用法规矩（0924 拍板）】结果带 pending=true 或 ⚠️待确认 的是**未确认记忆**（自动提炼/待用户审核）——只可当线索，'
      + '【口径★1010k】返回的是**本次检索命中的条数**，不是全库总量——别把命中数当库存数报给用户；要判断库多大看记忆面板。'
        + '当事实使用前必须先与用户核实；已确认记忆可直接用。' + '\n'   /* ★1014n：原此处拼 coreDigestLine()，已迁到本轮用户消息尾部（见 server.ts） */
        + '· store：写入长期记忆（content=简洁陈述句）。**写入必须归类（category）**：preference=用户偏好/明确要求、'
        + 'decision=重要决定、lesson=踩过的坑/教训、pattern=可复用做法/规律、fact=项目事实与进度、profile=用户是谁（称呼/长期画像）；'
        + 'summary=一句话摘要（≤60 字，进检索索引层；不填取首句）；'
        + 'importance=重要度 0~1（不填按类型给保底）：0.9 铁律/否决 0.8 已定决策/画像 0.7 偏好 0.6 教训/做法 0.4 能查到的事实。'
        + '只在用户明确表达、被纠正/踩坑或你确认重要时调用。'
        + '⚠️ **例外**：如果这话是"以后跟我说话白话点/别这么啰嗦/先给结论"这类**沟通风格**，'
        + '或者"这台机器 Node 在哪个路径/端口是多少"这类**环境固定事实**，请改用 `profile` 动作，别存进库。\n'
        + '· delete：id 精确删（hard=true 物理删，缺省=软删）或 query 按内容删匹配。\n'
        + '· distill：同主题散碎记忆合并成主题记忆草案（进待确认）——记忆条目多而碎时用；少或没同主题就不用调。\n'
        + '· profile：改「用户画像 USER.md（≤1400 字）」或「项目记忆 MEMORY.md（≤2200 字）」——这两份**每轮注入**。'
        + '判据：**怎么跟我说话/他是谁** → target=user；**环境事实或铁律** → target=agent；**具体技术教训/决策** → 走 store。'
        + 'mode=add/patch/remove/read；超上限会报错（不自动压缩，要自己合并）。\n'
        + memoryLocationHint(),
      members: [
        { action: 'search', tool: subs[0], required: ['query'], summary: '检索长期记忆（偏好/决策/教训/进度）' },
        { action: 'store', tool: subs[1], required: ['content'], summary: '写入一条长期记忆（必须归 category）' },
        { action: 'delete', tool: subs[2], summary: '删除记忆（id 精确删或 query 匹配删）' },
        { action: 'distill', tool: subs[6], summary: '蒸馏：同主题散碎记忆合并成草案（进待确认）' },
        { action: 'profile', tool: subs[7], required: ['target', 'mode'], summary: '★说话方式/环境固定事实走这里（user=画像 / agent=项目记忆；每轮注入）' },
      ],
    }),
    buildFamilyTool({
      name: 'knowledge',
      label: '知识库',
      group: '知识库',
      variant: 'search',
      tab: 'special',
      fullMemberDescriptions: false,
      description: '知识库工具箱（三动作）：收藏的资料（文档/学习笔记/参考资料）。'
        + '【分清】知识库 = 资料收藏；记忆 = 该记住的长期信息（memory 工具）；便签 = 用户要办的事（notebook 工具）。\n'
        + '· query：检索（query 留空=列最近条目）；返回里带**现有分类清单**——add 前先看一眼，能归到已有分类就别新建。**主动读纪律★0930**：技术做法/资料/参考类问题先 query 一把再答，答案可能就在库里。\n'
        + '· add：写入前请务必自己判断两件事：① entry_type：doc=文档/正式资料；manual=操作手册/使用说明/API 用法；'
        + 'note=笔记/要点/随手记；reference=参考资料/链接/规范条款。② category：先 query 看【现有分类】，能归进去就填那个分类名；'
        + '确实都不合适才起新分类名（不存在会自动创建）；实在判断不了就留空（会进「未分类」，别硬编一个）。\n'
        + '· delete：按条目 id 删（query 返回的 id）。\n'
        + memoryLocationHint(),
      members: [
        { action: 'query', tool: subs[3], summary: '检索知识库（空查询=列最近条目，附现有分类）' },
        { action: 'add', tool: subs[4], required: ['title', 'content'], summary: '存入资料（先判断 entry_type 与分类）' },
        { action: 'delete', tool: subs[5], required: ['id'], summary: '删除知识条目' },
      ],
    }),
  ]
}

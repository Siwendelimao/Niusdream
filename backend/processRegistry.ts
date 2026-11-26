/**
 * 进程注册表（0922e）—— 「进程监控」面板的数据源。
 *
 * 设计口径（0922e 定）：
 *   · 只显示**正在运行的**进程（哪怕只活 1 秒也要显示）；**结束后立即消失** ⇒ 不落盘历史
 *   · 每行要有时长 + 来源（项目 → 会话）
 * P0 范围：**AI 工具拉起的进程** —— `run_command` / `project_run_command`（前台命令）
 *   与 `bg_start`（后台任务）。内置服务（记忆桥/MCP/语音引擎）暂不接入（P1 再说）。
 *
 * 安全：面板上的「停止」先做**身份校验**（pid + 创建时间指纹，见 procIdentity.ts），
 *   pid 被系统复用时**拒绝执行**，绝不误杀别的进程。
 * 形态：**纯内存**注册表 —— 后端一退出，这些进程归 Windows 管；面板只回答"此刻还有谁在跑、是谁拉起的"。
 */
import { spawnSync } from 'node:child_process'
import { procStartStamp, sameStamp } from './procIdentity.ts'

interface ProcOrigin {
  /** 拉起它的工具名：run_command / project_run_command / bg_start … */
  tool: string
  /** 派发它的会话（前端据此显示「项目 → 会话」来源） */
  conversationId?: string
  projectId?: string
  /** 显示用短标签（后台任务标题 / 命令摘要） */
  label?: string
  /** 团队 V2 执行身份：**由工具启动层从执行作用域原样带下来**（`teamV2AttemptScope`）。
   *  这里只当搬运工，绝不推断 —— 落库（`noteAttemptPid`）用它，不再按成员 ID 去 running 里挑一个。 */
  team?: { hostSessionId: string; requestId: number; attemptId: number }
  /** ★1124：启动意图 token —— `spawn()` **之前**就已经落进团队账本的那条事实。
   *  进程起来后用它把 pid 补回同一行（`bindProcIntent`），进程结束用它删行。 */
  intentToken?: string
}

export interface TrackedProc {
  id: string
  pid: number
  /** 创建时间指纹（FileTime，CIM）—— 停止前校验身份，防 pid 复用误杀 */
  pidStart?: string
  name: string
  /** 命令行摘要（≤240 字） */
  cmdline: string
  cwd?: string
  startedAt: number
  status: 'running'
  origin: ProcOrigin
}

let seq = 0
const procs = new Map<string, TrackedProc>()
let emitter: ((p: TrackedProc) => void) | null = null
let remover: ((p: TrackedProc) => void) | null = null
let registrar: ((p: TrackedProc, phase: 'spawned' | 'identified') => void) | null = null
/* ★1124：启动意图钩子 —— 在 `spawn()` **之前**把"这单要起一个工具进程"落进账本。
   与 registrar 的分工：registor 是"进程已经起来之后的事实"，这个是"即将起来之前的事实"。 */
let intentHook: { begin: (origin: ProcOrigin) => string | null; end: (token: string) => void } | null = null
export function setProcIntentHook(hook: { begin: (origin: ProcOrigin) => string | null; end: (token: string) => void } | null): void { intentHook = hook }
/** 工具启动层在 `spawn()` 之前调：团队执行 ⇒ 返回 token（账本已有 intent 行）；非团队 ⇒ null。 */
export function procIntentBegin(origin: ProcOrigin): string | null {
  if (!intentHook) return null
  return intentHook.begin(origin)
}
/** 进程结束 / 启动失败 ⇒ 删掉那条 intent。删不掉只记日志：残留行会让这一单被当成"未知副作用"挡住（保守方向）。 */
export function procIntentEnd(token: string | null | undefined): void {
  if (!intentHook || !token) return
  try { intentHook.end(String(token)) } catch (err) {
    try { console.warn('[proc] 启动意图收尾失败（该单将按"未确认副作用"处理）:', String((err as Error)?.message || err)) } catch { /* ignore */ }
  }
}

/** 新增/变化 → server 广播（前端列表实时出现/更新） */
export function setProcEmitter(fn: ((p: TrackedProc) => void) | null): void { emitter = fn }
/** 结束 → server 广播移除（设计口径：结束就消失，不留在列表里） */
export function setProcRemover(fn: ((p: TrackedProc) => void) | null): void { remover = fn }
/** ★第十三轮：**持久登记**钩子（与广播彻底分开 —— 广播失败不影响事实，登记失败才影响围栏）。
 *
 *  两个阶段，**先落 pid、后补指纹**：
 *   · `'spawned'`    进程刚起来，pid 已知、指纹还没查 ⇒ 调用方先用 pid 落一行（startStamp=null）。
 *   · `'identified'` 指纹查询完了（非空串=指纹 / ''=确实查无此进程 / null=查询失败）⇒ 补写同一行。
 *  为什么分两步：指纹查询是一次 PowerShell 往返（几十~几百毫秒）。原来"查完指纹才落库"，
 *  后端在这一段里被 SIGKILL，这个 pid 就谁也不知道 —— 那正是"进程启动到持久登记的崩溃窗口"。
 *
 *  约定：本函数**不吞异常**。registrar 的实现必须自己把失败处置成账本/阻断事实；
 *  真的抛出来 = 该记的没记上，必须让启动层看见（不许静默变成一个跑着的野进程）。 */
export function setProcRegistrar(fn: ((p: TrackedProc, phase: 'spawned' | 'identified') => void) | null): void { registrar = fn }

const emit = (p: TrackedProc): void => { try { emitter?.(p) } catch { /* ignore */ } }
const remove = (p: TrackedProc): void => { try { remover?.(p) } catch { /* ignore */ } }

function baseName(p: string): string {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}
const clip = (s: string, n = 240): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** 登记一个"由 NiusDream 拉起"的进程；返回注册 id（pid 非法时返回 null） */
export function procRegister(pid: number, meta: { exe?: string; cmdline?: string; cwd?: string; origin: ProcOrigin }): string | null {
  const n = Number(pid)
  if (!n || n <= 0) return null
  const id = `proc_${(++seq).toString(36)}_${n}`
  const p: TrackedProc = {
    id,
    pid: n,
    name: baseName(meta.exe || '') || 'process',
    cmdline: clip(String(meta.cmdline || '')),
    cwd: meta.cwd,
    startedAt: Date.now(),
    status: 'running',
    origin: { ...meta.origin },
  }
  procs.set(id, p)
  /* ★第十三轮：**先登记持久事实，再查指纹**（关闭"启动→落库"的崩溃窗口）。
     阶段 1 只带 pid（指纹未知，如实写 null）；阶段 2 指纹出来后再补同一行。 */
  if (registrar) registrar(p, 'spawned')
  /* 指纹同步补一次（~150ms）：拿不到就不记 —— procKill 里"没有指纹"走宽松分支，见那里的守卫 */
  p.pidStart = procStartStamp(n) || undefined
  if (registrar) registrar(p, 'identified')
  emit(p)
  return id
}

/** 进程结束（子进程 close / 任务收尾）→ 从列表移除并广播 */
export function procEndByPid(pid: number): void {
  const n = Number(pid)
  if (!n) return
  for (const [id, p] of [...procs.entries()]) {
    if (p.pid === n) { procs.delete(id); remove(p) }
  }
}

/** 当前正在跑的（按启动时间升序 —— 与后台任务面板一致的"旧在上"口径） */
export function procList(): TrackedProc[] {
  return [...procs.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** 面板上的「停止」：先验身份，pid 被复用则拒绝 */
export function procKill(id: string): { ok: boolean; error?: string } {
  const p = procs.get(id)
  if (!p) return { ok: false, error: '进程已不在列表里（可能已经结束）' }
  const now = procStartStamp(p.pid)
  /* ★1003 安全批 4.24/4.25/4.27（同族连修）：
     ① 查询失败（null）原来被当"已退出"→ 注销登记+报成功（活进程从此不受控）——现如实报错让用户重试；
     ② p.pidStart 缺失（登记时没取到指纹）时校验整个跳过 = 可能被复用的 pid 照杀，
        直接违反文件头"绝不误杀别的进程"承诺——现在证不出身份就拒绝；
     ③ taskkill 失败原来被当成功（spawnSync 不抛错，失败在 status/error 里）——现检查结果。 */
  if (now === null) {
    return { ok: false, error: '进程身份查询失败（PowerShell 超时/异常），出于安全未执行，请重试' }
  }
  if (!now) { procEndByPid(p.pid); return { ok: true } }  // 查明确实不存在 = 已退出
  if (!p.pidStart) {
    return { ok: false, error: '该进程缺少身份指纹（登记时未取到），无法证明是它，拒绝停止（防 pid 复用误杀）' }
  }
  if (!sameStamp(p.pidStart, now)) {
    return { ok: false, error: 'pid 已被系统复用，出于安全未执行（不会去杀别的进程）' }
  }
  const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
  if (r.error || r.status !== 0) {
    return { ok: false, error: 'taskkill 失败：' + String(r.error?.message || (r.stderr || '').toString().trim().slice(0, 160) || `exit ${r.status}`) }
  }
  procEndByPid(p.pid)
  return { ok: true }
}



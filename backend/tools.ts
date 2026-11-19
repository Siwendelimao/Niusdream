/**
 * NiusDream 内置工具注册表（阶段 3a）
 *
 * 约定：
 *  - 工具 cwd 一律取「会话工作区」（createSession 时定的 workDir），
 *    普通聊天=储存目录/chat_<时间戳>，项目=项目 root_path
 *  - 相对路径基于 cwd 解析；绝对路径按原样
 *  - 工具事件（tool/call、tool/result）由 Agent 事件流经 SSE 推前端，
 *    前端统一渲染（阶段 5 解码器分类）
 */
import { Type } from 'typebox'
import { buildFamilyTool } from './familyTool.ts'
import { LAZY_FAMILIES, familyToolDocs } from './lazyTools.ts'
import { buildIndex, loadIndex, searchIndex, repoMap } from './repoIndex.ts'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { AgentTool } from './agentCompat.ts'
import { snapshotFile, snapshotTree, markAfterContent, listChanges, changeStatus, restoreChange, historyStats, diffStat } from './fileHistory.ts'
import { createTask, listTasks, updateTask, removeTask, runTaskNow, describeSchedule } from './scheduledTasks.ts'
import { acquireFileWrite, fileLockDenyMessage } from './fileLocks.ts'
import { DATA_ROOT } from './paths.ts'
/* ★1016 s1：只读类工具的「允许根」判定（工作区外可读/可列；写工具不改） */
import { isReadablePath, readRootsDenyMessage } from './readRoots.ts'
/* ★ 1001 修复（0930b 遗留）：git 族工具走 `gitExe()` 绝对路径解析，但本文件**漏了这行 import**
   ⇒ 一调 git_status / git_diff / git_log / git_commit 就 `ReferenceError: gitExe is not defined`。
   tsx 只剥类型不做检查，所以只有真跑起来才炸；`_tscheck.cjs --types` 的"运行时致命类"就是报的它。
   同类模块 mcpRuntime.ts / installTools.ts 都有这行，唯独这里缺。 */
import { gitExe } from './gitExe.ts'
import { withNisTrailer } from './gitTimeline.ts'
/* ★1010：项目档案的摘要层 + 分节读取（通用件；档案会长大，别再整份读） */
import { PROJECT_NOTE_FILE, NOTE_SECTIONS, buildNoteDigest, readNoteSection } from './noteDigest.ts'
/* 0920：后台任务（挂后台 / 查进度 / 读输出 / 停）—— 实现在 backgroundTasks.ts */
import { bgStartCommand, bgStartDownload, bgReadOutput, bgStop, bgSummaryForModel, bgWatch, bgNote, bgSuggestWatchSec } from './backgroundTasks.ts'
/* ★ 0922e：进程监控 —— 前台命令也要登记（面板里看得见 + 能停） */
import { procRegister, procEndByPid } from './processRegistry.ts'

/** 文件写锁上下文（0911 反馈③）：成员 run 传入 { owner: runId, label: 成员名 }；
 *  主 agent 与其它场景不传 = 完全不参与锁（零影响）。 */
interface FileLockCtx { owner: string; label: string }

/* ★1015i【预览白名单】——修"AI 交付到工作区外的文件，用户点开报 path outside workdir"。
 *
 * 病根（本机实测数据，见 fs_edit 里那条 1015 注释）：**AI 写文件是允许越界的**（34 个会话
 * 571 次 fs_edit 里 406 次落在工作区外，占 71%），而**用户点开预览却被严格限制在工作区内**
 * （server.ts 的 resolveWorkdirPath）⇒ 只要 AI 把成果交付到工作区外（改 <dev仓库> 这类工程
 * 目录是常态），用户就永远点不开 —— 小弹窗显示 `path outside workdir`，"进入预览"按钮因为
 * 异常被 catch 吞掉而"点了没反应"。
 *
 * 修法：**只读**一侧放行"本会话 AI 自己写过的绝对路径"，其余不动：
 *   · 登记点在 fs_write / fs_edit 的**落盘成功之后**（写失败不登记）；
 *   · 只在**同会话**内生效（换会话即失效，防跨会话偷看）；
 *   · 写 / 删 / 改名 / 静态文件代理**一律保持原严格校验**（本次不放宽任何写权限）。
 * 内存：每会话一个 Set，随会话进程生命周期，不落盘（重启后需重新交付一次，可接受）。 */
const sessionWrittenAbs = new Map<string, Set<string>>()
function noteWrittenPath(sessionId: string | undefined, absPath: string): void {
  if (!sessionId || !absPath) return
  let s = sessionWrittenAbs.get(sessionId)
  if (!s) { s = new Set(); sessionWrittenAbs.set(sessionId, s) }
  s.add(path.normalize(absPath))
}
/** 本会话 AI 是否写过这个绝对路径（给"只读预览"放行用；详见 sessionWrittenAbs 注释） */
export function wasWrittenBySession(sessionId: string | undefined, absPath: string): boolean {
  if (!sessionId || !absPath) return false
  return sessionWrittenAbs.get(sessionId)?.has(path.normalize(absPath)) === true
}

/** 快照来源标识默认值（主 agent）。0910 二批 F：成员实例改用 buildSessionTools(cwd, actor) 闭包捕获，
 *  不再用模块级可变全局——原实现是"一个白板写谁在干活"，同一成员被派出多个实例并发写文件时
 *  会互相覆盖署名，导致文件变更记录的归属记错人。 */
const DEFAULT_ACTOR = '主 agent'

/** 当前轮次上下文（撤销记录按对话轮次分组用）：由 server.ts 在 agent_start 时更新。
 *  turnId = 本轮首条 user 消息文本摘要（同一轮的多次工具调用共享），turnIndex = 会话内序号。
 *  ★1004c（实测反馈"群聊的显示在当前对话的文件变更里"）：**按会话隔离** ——
 *  原实现是全局单例，群聊插嘴/定时任务等并发会话跑一轮就把全局标签覆盖成自己的，
 *  其它会话随后落的文件变更全挂错轮次（实测本对话 30 条变更被挂上「【群聊插嘴】」标签）。
 *  工具调用点都有 sessionId（snapshotFile/snapshotTree 的 opts 里本来就有），按它取。 */
const snapshotTurns = new Map<string, { turnId: string; turnIndex: number }>()
export function setSnapshotTurn(sessionId: string, t: { turnId: string; turnIndex: number } | null): void {
  const k = String(sessionId || '')
  if (!t) snapshotTurns.delete(k)
  else snapshotTurns.set(k, t)
}
function getSnapshotTurn(sessionId: string): { turnId: string; turnIndex: number } | null {
  return snapshotTurns.get(String(sessionId || '')) ?? null
}


function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
}

/* ★ 0924 修复（一个"名不符实"的真 bug）：函数叫 tail（取尾部），实现却是 slice(0, n)（**取头部**）——
   而命令输出的**结论 / 报错 / 测试结果都在末尾**，取头部等于"留下开头的噪声、丢掉最有价值的部分"。
   改为**首尾各留一段**：头部 35%（命令回显、进度）+ 尾部 65%（结论、报错），中间省略并注明省了多少字。
   ★1012i：中间省掉的部分**不再消失** —— 调 omitNotice() 把**全文落盘**，并在提示里给出确切取回路径。
   以前这里砍完就真没了（1012h 实测：84,000 字符的输出只留 4,000，模型想查中间只能**重跑命令**）；
   现在模型可以直接 fs_read / fs_grep 取回全文。落盘与文案都是确定性的（文件名 = 内容 sha1）⇒ 前缀缓存稳定。
   ⚠️ 提示前缀统一为"…（此处省略" —— server.ts 的发送层裁剪靠这个前缀识别"已经处理过的文本"，
   避免同一份输出被"工具层截断 + 发送层裁剪"连环改（那会让历史每轮都变、把前缀缓存打散）。 */
import { omitNotice } from './spillStore.ts'

/* ★1127：**命令是否可能修改工作区文件** —— 决定要不要在命令前拍树快照。
   为什么需要：快照是同步全量扫描（walk + readFileSync + sha256 + gzip），
   大工作区单次 1.5 秒，每条命令都做 = 主线程反复被堵 2~5 秒 → WS 心跳超时 →
   前端判定后端死亡 → 用户看到"后端连续断连"（1127 实测）。
   判据用**写特征黑名单**（宁可多拍几次，也别漏掉写操作）；纯读命令一律跳过。
   ⚠️ 性能闸门，不是正确性闸门：漏判只影响"这次命令能不能撤销"，不影响命令执行与文件内容。 */
const WRITE_OP_RE = /(?:^|[\s&|;(])(?:>|>>|tee|cp|copy|xcopy|robocopy|mv|move|rm|del|erase|rmdir|mkdir|md|touch|ln|chmod|chown|truncate|dd|sed\s+-i|tar\s+[^|]*-?x|unzip|git\s+(?:checkout|reset|apply|clean|stash|restore|rm|mv|merge|rebase|pull)|npm\s+(?:i|install|ci|update|un)\b|pnpm\s+(?:i|install|add|remove|update)|yarn\s+(?:add|install|remove)|pip\s+install|python\s+-m\s+pip|new-item|set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|start-bitstransfer|reg\s+add|schtasks\s+\/create)/i
function commandMayWrite(command: string): boolean {
  const cmd = String(command || '')
  if (!cmd) return false
  if (WRITE_OP_RE.test(cmd)) return true
  /* 内联脚本里的写调用也算（node -e "fs.writeFileSync(...)" 这类） */
  if (/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|renameSync|unlinkSync|rmSync|mkdirSync)\b/.test(cmd)) return true
  if (/open\s*\([^)]*,\s*['"](?:w|a|wb|ab|x)['"]/.test(cmd)) return true
  return false
}
function tail(s: string, n = 4000): string {
  if (s.length <= n) return s
  const headLen = Math.floor(n * 0.35)
  const tailLen = n - headLen
  return `${s.slice(0, headLen)}${omitNotice(s, `此处省略 ${s.length - n} 字（原文共 ${s.length} 字符；以下为输出结尾）`)}${s.slice(-tailLen)}`
}

/* ★ 0923（用户定案）：fs_read 默认上限「不锁死」—— 由设置决定（与 currentShellKind 同模式：
 *   每次执行读一次 settings.json ⇒ 改完设置立刻生效、不用重启）：
 *     fsReadMaxChars = 0（缺省）→ 自动档：小文件整份读完，超过 READ_AUTO_CAP 封顶
 *     fsReadMaxChars > 0        → 数字即最大值（锁死该字符上限）
 *   模型调用时显式传的 maxChars 始终优先 —— 这里只管它没传的那 96%（真实日志统计）。 */
const READ_AUTO_CAP = 24000
function defaultReadCap(): number {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, 'settings.json'), 'utf-8')
    const n = Number((JSON.parse(raw) || {}).fsReadMaxChars)
    if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), 200000)  // 上限防手滑填超大值
  } catch { /* 设置读不到就用自动档 */ }
  return READ_AUTO_CAP
}

/* ── fs_read：读文件（文本，截断保护 + 行区间切片） ── */
const readParams = Type.Object({
  path: Type.String({ description: '文件路径（相对会话工作区或绝对路径）' }),
  maxChars: Type.Optional(Type.Number({ description: '最多读取字符数（不传＝按设置的「AI 读文件默认上限」：自动档=小文件整份读完、超 24000 封顶，或按用户选的最大值）。要读整份就给足（如 20000~40000）：一次读够比反复分段读更省 —— 每次调用都要重发整个上下文' })),
  startLine: Type.Optional(Type.Number({ description: '从第几行开始读（1 基，含）；大文件分段精读用，不传=从头' })),
  endLine: Type.Optional(Type.Number({ description: '读到第几行（1 基，含）；不传=读到文件末尾或 maxChars 截断' })),
})


function buildReadTool(cwd: string): AgentTool<typeof readParams, { path: string; chars: number }> {
  return {
    name: 'fs_read',
    label: '读文件',
    description: '读取文本文件内容。适合查看源码/配置/文档。优先一次读到位：文件大就直接传 maxChars（不传则按设置的默认上限）或用 startLine/endLine 精确覆盖你要的范围 —— 反复分段读会成倍消耗上下文。',
    parameters: readParams,
    async execute(_callId, params, _signal, onUpdate) {
      const full = resolvePath(cwd, params.path)
      const maxChars = params.maxChars ?? defaultReadCap()   // ★ 0923：默认值不锁死 —— 由设置 fsReadMaxChars 决定（0=自动档：≤24000 整读）；显式 maxChars 始终优先   // ★ 0923：20000 → 8000（配合描述的"一次读够"引导；全文长度见截断注记）
      // 目录明确报错（原样 readFile 会抛 EISDIR 原始错误，模型看不懂 → 绕路 run_command 探索）
      let st: Awaited<ReturnType<typeof fsp.stat>>
      try { st = await fsp.stat(full) } catch {
        throw new Error(`文件不存在：${full}（相对工作区路径会自动解析；可先用 run_command dir/ls 查看目录结构）`)
      }
      if (st.isDirectory()) {
        const entries = await fsp.readdir(full)
        throw new Error(`"${params.path}" 是目录不是文件，fs_read 只能读文件。目录内容：${entries.slice(0, 30).join('、')}${entries.length > 30 ? ' …' : ''}（读其中文件请写完整相对路径）`)
      }
      const content = await fsp.readFile(full, 'utf8')
      // 行区间切片（0910：模型多次传 startLine 被静默忽略 → 整文件重读，白烧 token）
      const allLines = content.split('\n')
      const sLine = Number.isFinite(params.startLine as number) && (params.startLine as number) > 1 ? Math.floor(params.startLine as number) : 1
      const eLine = Number.isFinite(params.endLine as number) && (params.endLine as number) >= sLine ? Math.floor(params.endLine as number) : allLines.length
      const ranged = sLine > 1 || eLine < allLines.length
      const slice = allLines.slice(sLine - 1, eLine).join('\n')
      const chars = Math.min(slice.length, maxChars)
      const text = slice.slice(0, chars)
      const truncated = chars < slice.length
      const rangeNote = ranged ? `第 ${sLine}~${Math.min(eLine, allLines.length)} 行 / 共 ${allLines.length} 行` : `共 ${allLines.length} 行`
      onUpdate?.({ content: [], details: { path: full, chars } })
      // 完整读取（无区间、未截断）保持原样输出——尾部注记只在"被截断/被切片"时出现，
      // 避免模型把注记当文件内容抄进 fs_write
      let outText = text
      if (truncated) {
        // ★ 0923：注记直接把"下一步"喂给模型 —— 续读行号按实际截断位置算（截在行中间就从那行重读）
        const nl = (text.match(/\n/g) || []).length
        const nextLine = Math.max(sLine, sLine + nl)
        /* ★1010c：大文件再补一句"换个搜法" —— 通读大源码是最贵的读法（且 fs_grep 默认会跳过大文件） */
        const bigHint = content.length > 120000
          ? `；这是**大文件**（全文 ${content.length} 字符）：若只是想定位某功能/符号，先用 repo_search（按符号）或 fs_grep（按文本）再定点读，比通读省得多`
          : ''
        outText = `${text}\n\n…(已截断：本段 ${chars} 字符 / 共 ${allLines.length} 行，全文约 ${content.length} 字符。继续读用 startLine=${nextLine}，或一次给足 maxChars=${slice.length})${bigHint}`
      }
      else if (ranged) outText = `${text}\n\n…(${rangeNote}，已按 startLine/endLine 切片，未截断)`
      return {
        content: [{ type: 'text', text: outText }],
        details: { path: full, chars, startLine: sLine, endLine: eLine },
      }
    },
  }
}

/* ── fs_grep：按关键词/正则搜索工作区文件内容（0910 反馈6：模型查源码只能拼 findstr/node 脚本，
     中文/引号一崩就绕路。给一个专用工具：返回 文件:行号: 内容 + 少量上下文，带匹配数与截断） ── */
const grepParams = Type.Object({
  pattern: Type.String({ description: '搜索词（默认按纯文本匹配；想用正则请同时设 regex=true）' }),
  path: Type.Optional(Type.String({ description: '搜索的起点目录或文件（默认工作区根）' })),
  glob: Type.Optional(Type.String({ description: '只看匹配的文件名，如 .ts / .vue（子串匹配，可留空）' })),
  regex: Type.Optional(Type.Boolean({ description: 'pattern 按正则解释（默认 false=纯文本，避免 . * 等字符被误解）' })),
  caseSensitive: Type.Optional(Type.Boolean({ description: '区分大小写（默认 false）' })),
  maxResults: Type.Optional(Type.Number({ description: '最多返回多少条匹配（默认 60，上限 200）' })),
  contextLines: Type.Optional(Type.Number({ description: '每条匹配附带的前后行数（默认 0，上限 3）' })),
  maxFileSizeKb: Type.Optional(Type.Number({ description: '超过该大小的文件跳过（默认 1024KB，防读二进制/大文件）' })),
})


/** 搜索时跳过的目录（依赖/构建产物/版本库：命中它们只会污染结果） */
const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', '__pycache__', 'target', '.venv', 'venv', '.idea', '.vscode'])
/** 搜索时跳过的二进制后缀 */
const GREP_SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.webm', '.sqlite', '.db', '.pyc', '.class', '.jar', '.wasm', '.bin'])

/** fs_grep 的扫描范围与预算（0924 事故修复：project_ 模式扫项目根 = 146 秒 / 读 4GB / 14.7 万文件） */
interface GrepOpts {
  /** 额外跳过的目录名（项目模式：data / releases / env / toolchain … 这些不是源码） */
  extraSkipDirs?: string[]
  /** 最多遍历的文件数（默认 20000；0 = 不限） */
  maxFiles?: number
  /** 最多读入的字节数（默认 256MB；0 = 不限） */
  maxBytes?: number
  /** 最长扫描毫秒数（默认 15000；0 = 不限） */
  maxMs?: number
}

export function buildGrepTool(cwd: string, opts: GrepOpts = {}): AgentTool<typeof grepParams,
  /* ★1005 放宽声明：实现里 onUpdate 还传了 scanned / note（"已扫描 N 个文件"），声明只列了 3 个字段 ⇒ TS 报多字段。 */
  /* 进度帧（onUpdate）只传 scanned/files/matches，收尾才给 truncated ⇒ 进度帧不提供的字段必须可选。 */
  { matches: number; files: number; truncated?: boolean; scanned?: number; note?: string }> {
  const budgetFiles = opts.maxFiles ?? 50000
  const budgetBytes = opts.maxBytes ?? 512 * 1024 * 1024
  const budgetMs = opts.maxMs ?? 20000
  return {
    name: 'fs_grep',
    label: '搜索文件内容',
    description: '在会话工作区内按关键词/正则搜索文件内容（返回 文件:行号 + 内容，自动跳过 node_modules/.git/dist 等）。查"某函数/字段在哪被引用"用它——比 run_command 拼 findstr（中文乱码）或写临时脚本可靠得多。',
    parameters: grepParams,
    async execute(_callId, params, _signal, onUpdate) {
      const root = params.path ? resolvePath(cwd, params.path) : cwd
      const raw = String(params.pattern || '')
      if (!raw) throw new Error('pattern 不能为空')
      let re: RegExp
      try {
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re = new RegExp(params.regex ? raw : esc(raw), params.caseSensitive ? 'g' : 'gi')
      } catch (e: any) {
        throw new Error(`正则不合法：${e?.message || e}（若只是普通文本，去掉 regex=true 或转义特殊字符）`)
      }
      const maxResults = Math.max(1, Math.min(200, Math.floor(params.maxResults ?? 60)))
      const ctx = Math.max(0, Math.min(3, Math.floor(params.contextLines ?? 0)))
      const sizeLimit = Math.max(16, Math.min(20 * 1024, Math.floor(params.maxFileSizeKb ?? 1024))) * 1024
      const glob = String(params.glob || '').trim().toLowerCase()
      const skipExt = (p: string) => GREP_SKIP_EXT.has(path.extname(p).toLowerCase())
      /* ★ 0925h（实测"指定了 path 仍被 backend/data 海量日志炸掉 5 万文件预算"）：
       * 数据目录**永远**跳过 —— 0924 的 !params.path 条件导致带 path（如 path=backend）时
       * 只剩 GREP_SKIP_DIRS，data/logs/快照全量进场。数据目录从来不是源码，任何 path 下都跳。 */
      const skipDirs = opts.extraSkipDirs?.length
        ? new Set([...GREP_SKIP_DIRS, ...opts.extraSkipDirs])
        : GREP_SKIP_DIRS
      const lines: string[] = []
      let matches = 0, fileHits = 0, truncated = false, scanned = 0
      let reached = 0, readBytes = 0, budgetHit = ''   // ★ 0924 预算计数器
      let skippedLarge = 0                             // ★1010c：因单文件体积上限被跳过的文件数（不再静默）
      const t0 = Date.now()
      const seenFiles = new Set<string>()

      /* ★1032-TM（P107）：**每处理完一个文件让出一次事件循环**。
         病（实测"成员界面卡住、盯很久才动" + 后端日志 [eventloop] 主线程被堵 2684ms）：
         IO 是异步的（`await fsp.readFile`），但**读完后的分行 + 逐行正则**是纯 CPU ——
         一个大文件 split 出几万行、每行 `re.test`，单个文件就吃掉几十~几百毫秒；目录里连着几个
         大文件，主线程就连续堵上秒级 ⇒ 期间所有 WebSocket 帧（含成员窗口流式）全排队 ⇒ 界面"卡住"。
         这里在每个文件处理完让出一次（setImmediate），每 2000 行再让一次；
         代价是每文件多一个 tick（微秒级），换回主线程响应性。扫描语义与结果**完全不变**。 */
      const yieldLoop = () => new Promise<void>((r) => setImmediate(r))

      const scanFile = async (abs: string) => {
        if (truncated || budgetHit) return
        if (skipExt(abs)) return
        let st: any
        try { st = await fsp.stat(abs) } catch { return }
        if (!st.isFile()) return
        /* ★1010c 真 bug 修复（本会话实测踩到）：>1MB 的文件被跳过却**不告知**，返回的是"未找到匹配"
           ⇒ 模型据此误判"项目里没有这个关键词"（实测：server.ts 1.1MB 搜 NIS-notes 返回"已扫描 0 个"）。
           现在计数并在结果里明示 + 给出正确路径（换个搜法或调大 maxFileSizeKb）。 */
        if (st.size > sizeLimit) { skippedLarge++; return }
        let content: string
        try { content = await fsp.readFile(abs, 'utf8') } catch { return }
        if (content.includes('\u0000')) return  // 二进制
        scanned++
        readBytes += content.length
        if (budgetBytes > 0 && readBytes > budgetBytes) { budgetHit = `读入量超过 ${Math.round(budgetBytes / 1048576)}MB`; return }
        const arr = content.split('\n')
        let fileCounted = false
        for (let i = 0; i < arr.length; i++) {
          re.lastIndex = 0
          if (!re.test(arr[i])) {
            if ((i & 2047) === 2047) await yieldLoop()   // 巨型文件也不要一口气占满主线程
            continue
          }
          if (matches >= maxResults) { truncated = true; return }
          if (!fileCounted) { fileCounted = true; fileHits++ }
          const rel = path.relative(cwd, abs).replace(/\\/g, '/')
          if (ctx > 0) {
            const from = Math.max(0, i - ctx), to = Math.min(arr.length - 1, i + ctx)
            for (let j = from; j <= to; j++) lines.push(`${rel}:${j + 1}:${j === i ? '' : ' '}${arr[j].slice(0, 300)}`)
            lines.push('--')
          } else {
            lines.push(`${rel}:${i + 1}: ${arr[i].slice(0, 300)}`)
          }
          matches++
        }
        await yieldLoop()   // 文件处理完让出一次：让 IO/帧广播插进来（见函数头注释）
      }

      /* ★ 0924 预算闸门：文件数 / 读入量 / 耗时三重上限，任一超限即停并明确告知（不再静默扫 14.7 万文件） */
      const overBudget = () => {
        if (budgetHit) return true
        if (budgetMs > 0 && Date.now() - t0 > budgetMs) { budgetHit = `扫描超过 ${Math.round(budgetMs / 1000)} 秒`; return true }
        if (budgetFiles > 0 && reached >= budgetFiles) { budgetHit = `遍历文件数超过 ${budgetFiles}`; return true }
        return false
      }

      const walk = async (dir: string, depth: number) => {
        if (truncated || budgetHit || depth > 12) return
        let entries: any[]
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (truncated || budgetHit) return
          const abs = path.join(dir, String(e.name))
          if (e.isDirectory()) {
            if (skipDirs.has(String(e.name))) continue
            await walk(abs, depth + 1)
          } else if (e.isFile()) {
            reached++
            if (reached % 2000 === 0) {
              onUpdate?.({ content: [], details: { scanned, files: fileHits, matches, note: `已扫描 ${scanned} 个文件` } })
              if (overBudget()) return
            }
            if (glob && !String(e.name).toLowerCase().includes(glob)) continue
            seenFiles.add(abs)
            await scanFile(abs)
          }
        }
      }

      let st: any
      try { st = await fsp.stat(root) } catch { throw new Error(`路径不存在：${root}`) }
      if (st.isFile()) { seenFiles.add(root); await scanFile(root) }
      else await walk(root, 0)

      const budgetNote = budgetHit ? `｜⚠ 已提前停止：${budgetHit}（建议改用 path 收窄到具体目录，如 frontend/src）` : ''
      /* ★1010c：把"因体积被跳过"显式说出来 —— 否则 0 匹配会被读成"项目里没这东西" */
      const largeNote = skippedLarge
        ? `\n⚠ 另有 ${skippedLarge} 个文件因超过单文件上限 ${Math.round(sizeLimit / 1024)}KB 被跳过 ——**这不是"没匹配"**：大文件请用 fs_read 带 startLine/endLine 按段读，或把本次 maxFileSizeKb 调大（上限 20480）再搜一次。`
        : ''
      /* ★ 0924：0 匹配时主动说明"跳过了哪些目录"，防止被误判成"项目里没有"
       * ★ 0925h：排除规则改为任何 path 都生效（见 skipDirs 处注释），提示同步 */
      const skippedNote = (opts.extraSkipDirs?.length)
        ? `\n注意：本次按项目规则跳过了 ${opts.extraSkipDirs.slice(0, 8).join('、')} 等数据目录（它们不是源码）。若要搜这些位置（历史会话 / 日志 / file-history），请显式传 path=该目录 再搜一次。`
        : ''
      onUpdate?.({ content: [], details: { matches, scanned, files: fileHits } })
      if (matches === 0) {
        return {
          content: [{ type: 'text', text: `未找到匹配「${raw}」（已扫描 ${scanned} 个 / 遍历 ${reached} 个文件${glob ? `，文件名过滤：${glob}` : ''}）${budgetNote}。可换关键词、去掉 glob 或用 fs_read 直接看目标文件。${largeNote}${skippedNote}` }],
          details: { matches: 0, files: 0, truncated: false },
        }
      }
      const head = `匹配「${raw}」：${matches} 条 / ${fileHits} 个文件（扫描 ${scanned} 个）${truncated ? `，已达上限 ${maxResults} 条（可加 glob 或 path 收窄）` : ''}${budgetNote}`
      return {
        content: [{ type: 'text', text: `${head}\n${lines.join('\n')}${largeNote}` }],
        details: { matches, files: fileHits, truncated },
      }
    },
  }
}

/* ── fs_write：写文件（自动建目录） ── */
const writeParams = Type.Object({
  path: Type.String({ description: '文件路径（相对会话工作区或绝对路径）' }),
  content: Type.String({ description: '文件内容' }),
})


/* ── 0923：同文件写操作串行队列 ──
 * 背景（harness 层踩坑实锤）：同一文件多个 fs_edit **并行**执行会互相覆盖 ——
 * 每个调用都是"读原文件→改自己那处→全量写回"，并行时后写的把先改的冲掉（本次会话实录）。
 * NiusDream agent 工具层从机制上拆雷：同 path 的 fs_write/fs_edit 自动排队，前一个落盘完成才执行下一个；
 * 不同 path 照常并行；链上节点失败只跳过自己（catch 吞掉），不堵死后续操作。 */
const _fileWriteChains = new Map<string, Promise<void>>()
function enqueueFileWrite<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _fileWriteChains.get(absPath) || Promise.resolve()
  const run = prev.catch(() => { /* 前一个失败不堵后面 */ }).then(fn)
  // 链尾只记"完成"（无论成败），异常由原始 run 透传给调用方
  _fileWriteChains.set(absPath, run.then(() => { /* noop */ }, () => { /* noop */ }))
  // 防 Map 无限增长：成功后清掉该 path 的链（无人在等时）
  run.then(() => { if (_fileWriteChains.get(absPath) !== undefined) { /* 保留尾链，下个操作接 */ } })
  return run
}

function buildWriteTool(cwd: string, actor: string = DEFAULT_ACTOR, sessionId?: string, lockCtx?: FileLockCtx): AgentTool<typeof writeParams, { path: string; bytes: number }> {
  return {
    name: 'fs_write',
    label: '写文件',
    description: '写入文件内容（覆盖）。父目录不存在会自动创建。',
    parameters: writeParams,
    async execute(_callId, params, _signal, onUpdate) {
      const full = resolvePath(cwd, params.path)
      // 0923：同文件写串行（整段写入逻辑入队，前一个落盘才算完）
      return enqueueFileWrite(full, async () => {
      // 0911 反馈③：并行成员互斥——该文件被其他成员 run 持有时拒绝（防静默互覆）
      if (lockCtx) {
        const deny = acquireFileWrite(full, lockCtx.owner, lockCtx.label)
        if (deny) throw new Error(fileLockDenyMessage(full, deny))
      }
      // B4 写入软上限：模型抽风可能生成超大字符串打满磁盘；超限报错让模型改写分段
      const _sz = Buffer.byteLength(params.content, 'utf8')
      if (_sz > 20 * 1024 * 1024) {
        throw new Error(`内容过大（${(_sz / 1048576).toFixed(1)}MB），单次写入上限 20MB，请分段写入`)
      }
      // 写入前快照（撤销/审查数据源；失败静默不阻塞业务）
      const changeId = snapshotFile({ workDir: cwd, absPath: full, tool: 'fs_write', actor: actor, sessionId, toolCallId: _callId, turn: getSnapshotTurn(sessionId) ?? undefined })
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, params.content, 'utf8')
      noteWrittenPath(sessionId, full)   // ★1015i：登记"本会话写过"，供只读预览放行（见 sessionWrittenAbs 注释）
      // 写入后回填 afterHash 与 +N-M 差异量（快照时"改动后"内容还不存在，语义是"写入前"）
      const diff = changeId ? markAfterContent(cwd, changeId, Buffer.from(params.content, 'utf8')) : null
      const bytes = Buffer.byteLength(params.content, 'utf8')
      const diffInfo = diff ? { added: diff.diffAdded, removed: diff.diffRemoved } : {}
      onUpdate?.({ content: [], details: { path: full, bytes, ...diffInfo } })
      return {
        content: [{ type: 'text', text: `已写入 ${bytes} 字节 → ${full}${diff ? `（+${diff.diffAdded}/-${diff.diffRemoved} 行）` : ''}` }],
        details: { path: full, bytes, ...diffInfo },
      }
      })
    },
  }
}

/* ── fs_edit：按锚点精确替换（0913 新增，「升级模式」精准修改用） ──
 * 为什么需要：fs_write 是**整文件覆盖** —— 改大文件时模型一旦记错上下文就会写坏；
 * 而 LLM 最擅长的是"原样抄一小段我看到的 → 改成我想要的"，这条路要一个专用工具。
 * 语义（对齐主流实现，模型不用重新学）：
 *   · old_string 必须与文件内容**逐字符一致**（含缩进/换行），默认要求**全文件唯一**，
 *     出现多次直接报错并要求补充上下文（或显式 replace_all）—— 这是"抓准精准点"的关键防线；
 *   · 成功后回报**命中行号 + 替换后的上下文**（带行号），模型/用户都能自证"改在点上了"；
 *   · 与 fs_write 同款：写前拿文件锁（并行成员互斥）+ 落快照（撤销/审查共用同一数据源）。 */
const editParams = Type.Object({
  path: Type.String({ description: '文件路径（相对会话工作区或绝对路径）' }),
  old_string: Type.String({ description: '要被替换的原文（必须与文件里的内容逐字符一致，含缩进换行；默认要求全文件唯一）' }),
  new_string: Type.String({ description: '替换成的新文本（传空字符串 = 删除这段）' }),
  replace_all: Type.Optional(Type.Boolean({ description: 'old_string 出现多次时全部替换（默认 false = 要求唯一，更安全）' })),
})


function buildEditTool(cwd: string, actor: string = DEFAULT_ACTOR, sessionId?: string, lockCtx?: FileLockCtx): AgentTool<typeof editParams, { path: string; replacements: number; lines: number[] }> {
  return {
    name: 'fs_edit',
    label: '精确替换',
    description: '按锚点精确替换文件片段（改大文件推荐用它，比 fs_write 整文件覆盖安全）：old_string 要和文件里一模一样且默认唯一，命中后只改这一处；返回命中行号与替换后上下文供确认。',
    parameters: editParams,
    async execute(_callId, params, _signal, onUpdate) {
      const full = resolvePath(cwd, params.path)
      // 0923：同文件写串行（读-校验-写整段入队，防并行 edit 读到旧内容互相覆盖）
      return enqueueFileWrite(full, async () => {
      let before: string
      try {
        before = await fsp.readFile(full, 'utf8')
      } catch {
        throw new Error(`文件不存在或不可读：${full}（要新建文件请用 fs_write）`)
      }
      if (!params.old_string) throw new Error('old_string 不能为空')
      if (params.old_string === params.new_string) throw new Error('old_string 与 new_string 相同，无需替换')
      /* ★ 0925h（实测"CRLF 文件逐字符一致却找不到"）：行尾归一化重试 ——
       * old_string 用 \n、文件是 \r\n（或反之）时字面全对也命不中；按**文件的行尾**
       * 适配 old/new_string 再匹配，替换结果仍保持文件原有行尾。 */
      const eolOf = (t: string): string => (t.includes('\r\n') ? '\r\n' : '\n')
      let hitOld = params.old_string
      let hitNew = params.new_string
      let hits = before.split(hitOld).length - 1
      if (hits === 0) {
        const fe = eolOf(before), oe = eolOf(params.old_string)
        if (fe !== oe && /\r?\n/.test(params.old_string)) {
          const conv = (t: string) => (fe === '\r\n' ? t.replace(/\r?\n/g, '\r\n') : t.replace(/\r\n/g, '\n'))
          const cand = conv(params.old_string)
          const h2 = before.split(cand).length - 1
          if (h2 > 0) { hitOld = cand; hitNew = conv(params.new_string); hits = h2 }
        }
      }
      if (hits === 0) {
        throw new Error('未找到 old_string 原文 —— 请先用 fs_read 确认目标片段（缩进、空行、全角标点都要逐字符一致；CRLF 文件已自动适配行尾，仍找不到就是字面不一致）')
      }
      if (hits > 1 && !params.replace_all) {
        throw new Error(`old_string 在文件中出现 ${hits} 次、不唯一 —— 请带上前后文让它唯一，或显式设 replace_all=true`)
      }
      const lines: number[] = []
      {
        let idx = -1
        while ((idx = before.indexOf(hitOld, idx + 1)) >= 0) {
          lines.push(before.slice(0, idx).split('\n').length)
          if (lines.length >= 50) break
        }
      }
      // ⚠️ 替换必须用函数形式：字符串形式会把 new_string 里的 `$&`/`$1` 当替换模式解释
      const after = params.replace_all
        ? before.split(hitOld).join(hitNew)
        : before.replace(hitOld, () => hitNew)
      const _sz = Buffer.byteLength(after, 'utf8')
      if (_sz > 20 * 1024 * 1024) throw new Error(`结果过大（${(_sz / 1048576).toFixed(1)}MB），单次上限 20MB`)
      // 与 fs_write 同款：写前拿锁 + 落快照
      if (lockCtx) {
        const deny = acquireFileWrite(full, lockCtx.owner, lockCtx.label)
        if (deny) throw new Error(fileLockDenyMessage(full, deny))
      }
      const changeId = snapshotFile({ workDir: cwd, absPath: full, tool: 'fs_edit', actor, sessionId, toolCallId: _callId, turn: getSnapshotTurn(sessionId) ?? undefined })
      await fsp.writeFile(full, after, 'utf8')
      noteWrittenPath(sessionId, full)   // ★1015i：登记"本会话写过"，供只读预览放行（见 sessionWrittenAbs 注释）
      const diff = changeId ? markAfterContent(cwd, changeId, Buffer.from(after, 'utf8')) : null
      /* ★1015【#4「为什么有的有 diff 有的没有」根因修复】
       * 现象（反馈）：对话流里精确替换过程块，有的行尾带「+N-M 行」，有的不带。
       * 真因：这个 +N-M **完全依赖快照 changeId**，而 `snapshotFile()` 第一件事就是
       *   `const rel = path.relative(workDir, absPath); if (rel.startsWith('..')) return null`
       *   ⇒ **工作区外的文件一律不落快照** ⇒ changeId=null ⇒ diffInfo={} ⇒ 行尾什么都不显示。
       *   实证（本机 34 个会话 / 571 次 fs_edit）：工作区内 165 次、工作区外 406 次；
       *   成功的调用里恰有一大批落在工作区外（改 `<dev仓库>\**` 与 `<旧dev仓库>\**` 这类工程目录）。
       * 修法：本工具手里本来就有 before/after，快照给不出数字时自己算。
       *
       * ★1015b【性能修正 —— 我第一版闸门设错，实测抓出来的，别改回去】
       * 第一版写的是"整文件 diffStat，**3MB** 以上才跳过"。实测：diffStat 是 LCS O(n×m)，
       *   server.ts（1.24MB / 2 万行）一次要 **2.1~2.7 秒** —— 而 1.24MB 根本没碰到 3MB 闸门
       *   ⇒ "改一行"要卡两秒。不可接受：fs_edit 是高频工具，且这段是**同步**阻塞事件循环的。
       *   闸门必须按**行数**（决定 O(n×m) 的其实是行数，不是字节数），实测标定：
       *     1000 行 4ms / 3000 行 44ms / 5000 行 463ms / 2 万行 ~2000ms
       *   ⇒ 取 **3000 行**：≈40ms 可忽略，且覆盖绝大多数被改文件（2 万行的巨型文件才降级不显示）。
       * 中途试过"只 diff 命中行前后各 200 行的窗口"（想让巨型文件也快），**实测两个都不过关、已撤回**：
       *   ① 正确性：窗口内重复行（空行/`}`）在 LCS 里大量"假配"，改 1 行却报 +8/-121 这种噪声；
       *   ② 性能：400×400 的窗口对**中文长行**依然要 1.8s（O(n×m) 的代价跟行长相关，不是行数少就快）。
       *   ⇒ 结论：整文件 diffStat 才是**逐行对齐的真值**，只能在"文件够小"时用。 */
      const _DIFF_MAX_LINES = 3000
      const diffInfo = diff
        ? { added: diff.diffAdded, removed: diff.diffRemoved }
        : (() => {
            try {
              const beforeBuf = Buffer.from(before, 'utf8')
              const afterBuf = Buffer.from(after, 'utf8')
              // 行数闸门（判据见上：O(n×m) 的成本由行数决定）
              const nB = (before.match(/\n/g) || []).length + 1
              const nA = (after.match(/\n/g) || []).length + 1
              if (nB > _DIFF_MAX_LINES || nA > _DIFF_MAX_LINES) return {}
              const s = diffStat(beforeBuf, afterBuf)
              return { added: s.diffAdded, removed: s.diffRemoved }
            } catch { return {} }
          })()
      // 回报命中行号 + 替换后该处上下文（前后各 3 行，带行号）—— 让"改在点上了"可自证
      const anchorLine = lines[0] || 1
      const afterLines = after.split('\n')
      const newSpan = params.new_string.split('\n').length
      const ctxFrom = Math.max(0, anchorLine - 1 - 3)
      const ctxTo = Math.min(afterLines.length, anchorLine - 1 + newSpan + 3)
      const ctx = afterLines.slice(ctxFrom, ctxTo).map((l, i) => `${ctxFrom + i + 1}| ${l}`).join('\n')
      onUpdate?.({ content: [], details: { path: full, replacements: hits, lines, ...diffInfo } })
      return {
        content: [{
          type: 'text',
          text: `已替换 ${hits} 处（命中行：${lines.join(', ')}）→ ${full}${diff ? `（+${diff.diffAdded}/-${diff.diffRemoved} 行）` : ''}\n\n替换后上下文：\n${ctx}`,
        }],
        details: { path: full, replacements: hits, lines, ...diffInfo },
      }
      })
    },
  }
}

/* ── run_command：执行 shell 命令（cwd=会话工作区，超时保护） ── */
const cmdParams = Type.Object({
  command: Type.String({ description: '要执行的命令（如 "npm install"）' }),
  cwd: Type.Optional(Type.String({ description: '可选：覆盖工作目录' })),
  timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒（默认 120000）' })),
  /* ★ 0925g（用户定）：显式指定本条命令的终端 —— 自动选择被"混合语法"误判时的逃生舱 */
  shell: Type.Optional(Type.String({ description: '显式指定终端：cmd / powershell / pwsh（默认=设置里的命令终端；命令里混有两种语法导致误判时才需要填）' })),
  /* ★ s5（命令摘要 A 方案，需求）：可选的一句话业务意图 —— 前端折叠行**优先**显示它，
     比规则推断的「执行命令 · 查找文件」有信息量；不填=零影响（前端回退现有规则摘要）。
     只加在命令类工具上（run_command / bg_start），不给 105 个工具都加，控 schema token。 */
  intent: Type.Optional(Type.String({ description: '一句话说明这步要干什么（中文 10~20 字，面向用户，别用工具名或「执行命令」这类泛词重复；例：「在 server.ts 里找压缩触发逻辑」）。可选：不确定就不填' })),
})


/** 输出解码（0910）：Windows cmd 内置命令（dir/findstr/tree…）按本地代码页（中文=GBK/936）
 *  输出字节，默认 utf8 解码必出乱码（"ϵͳ�Ҳ���ָ����·��"），模型据此判断失败/绕路。
 *  策略：先按 UTF-8 严格解码；失败说明不是 UTF-8（多为 GBK）→ 用 GBK 解码；再失败退回 latin1。
 * ★ 0922c：导出给 backgroundTasks.ts 复用（后台任务按行探测解码）。 */
export function decodeOutput(buf: Buffer): string {
  if (!buf.length) return ''
  /* ★ 0922c：**不按 shell 猜，按字节探测**（本机实测 CP=936）：
     · cmd.exe / Windows PowerShell 5.1 / **pwsh 7.6** 的 stdout 都是本地代码页（GBK/cp936）
       —— 上一版把 pwsh 归到 utf-8，于是 pwsh 命令的中文全变乱码（"计时 1 分钟"任务实锤）；
     · 而 cmd 下跑 node/python 吐的是 UTF-8（上一版按 cmd→gbk 解 → 中文变乱码）。
     判据：严格 UTF-8 能解通就是 UTF-8（GBK 文本整段恰好全部构成合法 UTF-8 序列的概率极低）；
     否则按本地代码页 GBK 解，再不行退 latin1（binary 安全）。
     ⚠️ 这是"读得懂"级别的修复：源进程若已把字符编成 `?`（如 ⏰ 不在 cp936 里），信息在源头就没了。 */
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

/** Windows 多行命令：cmd.exe 的 /c 参数**只执行第一行**（实测 `echo a\necho b` 只输出 a，
 *  且第二行起被静默丢弃——成员"mkdir backend / mkdir backend/profiles / …"只建了第一个目录，
 *  正是本坑）。含换行的命令改写成临时 .cmd 批处理再执行：批处理天然支持多行、引号语义不变。
 *  返回清理函数（跑完删临时文件；删除失败不影响结果）。 */
/** 多行命令写成临时 .cmd（cmd.exe 对多行 /c 处理不可靠）
 *  0920：导出给 backgroundTasks.ts 复用（后台任务必须跟前台命令同一套 Shell 语义） */
/** ★ 1010-B：判断这条 PowerShell 命令是否该走「落盘 .ps1 再 -File 执行」。
 *  判据（宁枉勿缺——落盘只是多一次临时文件，不会改变语义）：
 *   ① 含正则字面量 /.../  或 -match /-replace/-split 等正则运算符；
 *   ② 含 JSON 形态 { ... }（可能带冒号引号）；
 *   ③ 同时出现「转义引号」与「变量拼接」（引号地狱的典型特征）。
 *  纯单引号/无嵌套的简单命令不落盘，避免无谓的临时文件。 */
export function needsPsFile(command: string): boolean {
  const c = command
  const hasRegexLiteral = /\/(?:[^/\\\n]|\\.)+\/[a-z]*/.test(c) || /-(?:match|replace|split|join)\b/.test(c)
  const hasJsonLike = /\{[^}]*[:"]/.test(c)
  const hasEscapedQuote = /\\"/.test(c) || /`"/.test(c)
  const hasVarConcat = /\$\w+\s*\+|[+]\s*\$\w+/.test(c)
  if (hasEscapedQuote && hasVarConcat) return true
  if (hasRegexLiteral || hasJsonLike) return true
  /* 1010 补漏：cmdlet 里带**大写/混合大小写参数的**深层调用也会在 -Command 整串里被引号吃掉
     （实测 `$raw | ConvertFrom-Json` 这类没有字面 `{` 也没有正则的写法同样脆弱）。
     判据：Cmdlet 名 + 大写参数（如 ConvertFrom-Json / ConvertTo-Json / Select-Object 的 -Raw 等）。*/
  const hasCmdletPipeline = /\b(?:ConvertFrom|ConvertTo|Convert|Select|Where|ForEach|Sort|Measure|Group|Join|Split|Compare|Import|Export|Format|Test|Resolve|Get|Set|New|Remove|Add|Update|Start|Stop|Restart)-[A-Z]\w+/.test(c)
  if (hasCmdletPipeline && /[|;]/.test(c)) return true
  return false
}

/** 把 PowerShell 脚本写成临时 .ps1（writeTempCmdFile 的同构版本） */
export function writeTempPs1File(script: string): { file: string; cleanup: () => void } | null {
  try {
    const dir = path.join(os.tmpdir(), 'nis-cmd')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.ps1`)
    // BOM：让 Windows PowerShell 5.1 正确识别 UTF-8 中文脚本（无 BOM 会按 ANSI 解码→中文乱码）
    fs.writeFileSync(file, '\ufeff' + script.replace(/\r\n/g, '\n'), 'utf8')
    return {
      file,
      cleanup: () => { try { fs.unlinkSync(file) } catch { /* ignore */ } },
    }
  } catch { return null }
}
export function writeTempCmdFile(command: string): { file: string; cleanup: () => void } | null {  try {
    const dir = path.join(os.tmpdir(), 'nis-cmd')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.cmd`)
    // @echo off：批处理默认回显每行命令，会污染模型看到的输出
    fs.writeFileSync(file, `@echo off\r\n${command}\r\n`, 'utf8')
    return { file, cleanup: () => { try { fs.rmSync(file, { force: true }) } catch { /* ignore */ } } }
  } catch { return null }
}

/** ★ 0925g（用户定）：node -e 内联脚本自动落盘 —— 内联参数里的引号/中文极易被
 *  shell + execFile 两层引号转义搞崩（实测中文引号直接 SyntaxError、多层引号各自为战）。
 *  整条命令恰好是 `node -e "…"` / `node --eval '…'` 形态时，提取脚本写成临时 .cjs 再跑。 */
function writeTempCjsFile(script: string): { file: string; cleanup: () => void } | null {
  try {
    const dir = path.join(os.tmpdir(), 'nis-cmd')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.cjs`)
    fs.writeFileSync(file, script, 'utf8')
    return { file, cleanup: () => { try { fs.rmSync(file, { force: true }) } catch { /* ignore */ } } }
  } catch { return null }
}

/** 识别 `node[.exe] -e|--eval "…"`（或单引号）整条形态，提取脚本体；
 *  首尾引号不配对/带其他参数/尾随内容 → 返回 null（不碰，保持原样执行）。 */
export function extractInlineNodeScript(command: string): { nodeExe: string; script: string } | null {
  const m = /^\s*("?[\w\\/.\-:]*node(?:\.exe)?["']?)\s+(?:-e|--eval)\s+([\s\S]+?)\s*$/.exec(command)
  if (!m) return null
  const rest = m[2]
  const q = rest[0]
  if (q !== '"' && q !== "'") return null
  if (rest[rest.length - 1] !== q) return null
  return { nodeExe: m[1], script: rest.slice(1, -1) }
}

/** 0914：读取「设置→通用→命令终端」——AI 命令工具使用的 Shell（每次执行时读，改完即生效）
 *  0918：新增 'auto'（自动选择）——按每条命令的语法特征挑 Shell，见 resolveShellForCommand()。 */
export type ShellKind = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'auto'

function currentShellKind(): ShellKind {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, 'settings.json'), 'utf-8')
    const v = String((JSON.parse(raw) || {}).cmdShell || '')
    if (v === 'powershell' || v === 'pwsh' || v === 'cmd' || v === 'bash' || v === 'auto') return v
  } catch { /* ignore */ }
  return 'cmd'
}

/* ── 0918：#8 终端「自动选择」 ──────────────────────────────────────────────
 *  背景：固定选一个 Shell 时，AI 写的命令常常"语法对不上 Shell"（PowerShell 语法进了 cmd，
 *  或反过来的批处理语法进了 PowerShell），表现就是一堆看不懂的报错。
 *  策略（保守优先 cmd —— exe 调用/多行批处理/引号语义都最稳）：
 *    ① 明显的批处理/cmd 特征（%VAR%、@echo off、for /f、set /a、goto/call）→ cmd
 *    ② 明显的 PowerShell 特征（Get-ChildItem 这类 Verb-Noun、$env:、-ErrorAction、
 *       比较运算符 -eq、$_、@{}、反引号转义…）→ PowerShell（装了 pwsh 优先 pwsh）
 *    ③ 其它（纯 exe、npm/pnpm/git、多行命令）→ cmd
 *  单条命令级判定，不改全局设置；判错了也只是"这次用哪个 shell"。 */
let _pwshPath: string | null | undefined

/** Store/MSIX 版 pwsh 的真实包路径：<ProgramFiles>\WindowsApps\Microsoft.PowerShell_<ver>_<arch>__8wekyb3d8bbwe\pwsh.exe
 *  ⚠️ 0921 实测：%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe 只是 AppExecLink 别名，Node 的 statSync
 *  对它报 EACCES ⇒ fs.existsSync=false；PATH 里往往也只有那个别名目录。于是「fixed 三条 + PATH 扫」
 *  在"商店版 pwsh"机器上恒判 false → 所有 PS 语法命令被静默降级到 powershell.exe(5.1)。 */
function findStorePwsh(): string | null {
  try {
    const wa = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
    for (const d of fs.readdirSync(wa)) {
      if (!/^Microsoft\.PowerShell_/i.test(d)) continue
      const exe = path.join(wa, d, 'pwsh.exe')
      try { if (fs.existsSync(exe)) return exe } catch { /* ignore */ }
    }
  } catch { /* 读不到就跳过（沙箱/权限） */ }
  return null
}

/** 可用的 pwsh.exe 绝对路径（找不到=null）。只看文件系统与 PATH，不 spawn（打包版 PATH 可能为空）。
 *  0921：① 加 Store 版真实包扫描；② 返回绝对路径并缓存 —— spawn 时不再依赖 PATH 里那个读不动的别名。 */
export function pwshExePath(): string | null {
  if (_pwshPath !== undefined) return _pwshPath
  const fixed = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ]
  for (const p of fixed) {
    try { if (p && fs.existsSync(p)) { _pwshPath = p; return p } } catch { /* ignore */ }
  }
  const store = findStorePwsh()
  if (store) { _pwshPath = store; return store }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      const exe = path.join(dir, 'pwsh.exe')
      if (fs.existsSync(exe)) { _pwshPath = exe; return exe }
    } catch { /* ignore */ }
  }
  _pwshPath = null
  return null
}


/* ── 1010：Git Bash（可选终端）──────────────────────────────────────────────
 * 动机：PowerShell 的引号语义（反引号转义 / 单引号不展开变量）经实测在 pwsh 7.6.6 上
 * 同样报错（PS5 与 pwsh 同语言），**换 PowerShell 版本挡不住**；Git Bash 的引号规则简单得多
 * （单引号内全为纯文本、无需转义），是 zcode 官方（zai-org/ZCode）的 Windows 首选。
 * ⚠️ 已知代价（实测）：① node 不在 bash 的 PATH 里 → 需用绝对路径调用；
 *    ② tasklist/netstat 等 Windows 命令经bash 调用时输出为 GBK 乱码。
 *    故作为**可选**项而非默认，默认仍是 cmd/自动选择。 */
let _bashPath: string | null | undefined
/** ★1010-D（已定案 A，仿 pwsh「装了才能用」）：Git Bash 探测 = NiusDream 自装 MinGit（<envDir>/gitbash）
 *  优先 → 系统 Git for Windows。未装则终端下拉置灰、自动选择绝不调 bash。
 *  envDir 每次现读 settings.json（与 defaultReadCap 同款「改完设置立刻生效」模式）。 */
function bashCandidates(): string[] {
  let envDir = ''
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'settings.json'), 'utf-8'))
    envDir = String(raw?.envDir || '').trim()
  } catch { /* 读不到就只探系统路径 */ }
  if (!envDir) envDir = path.join(DATA_ROOT, 'env')
  return [
    path.join(envDir, 'gitbash', 'usr', 'bin', 'bash.exe'),   // MinGit
    path.join(envDir, 'gitbash', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',                  // 系统 Git for Windows
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
}
export function bashExePath(): string | null {
  if (_bashPath !== undefined) return _bashPath
  for (const p of bashCandidates()) {
    try { if (p && fs.existsSync(p)) { _bashPath = p; return p } } catch { /* ignore */ }
  }
  _bashPath = null
  return _bashPath
}
/** ★1010-D：装/卸 Git Bash 后立刻失效缓存（否则装完不重启后端一直报"未安装"——实测坑） */
export function resetBashPath(): void { _bashPath = undefined }
/** Git Bash 是否可用（设置页据此决定要不要给「Git Bash」这一项） */
export function hasBash(): boolean { return bashExePath() !== null }
/** PowerShell 7（pwsh）是否可用 */
function hasPwsh(): boolean { return pwshExePath() !== null }

/** 批处理/cmd 专属语法 */
const CMD_SIGNAL_RE = [
  /^\s*@?echo\s+off\b/im,
  /%\w+%/,
  /\b(?:if|for)\s+\/[a-z]\b/i,
  /\bset\s+\/[ap]\b/i,
  /\b(?:goto|call)\s+[:@\w]/i,
  /\b(?:dir|del|copy|move|ren|rd|md|type|find|findstr|xcopy|robocopy|tasklist|taskkill|net|sc|reg|schtasks)\s+\/[a-z]/i,
  /* ★ 0925g：补高频漏网 —— `cd /d` 是最常拼的 cmd 用法，之前不在表里（实测
     `cd /d X && node -e "…'Content-Type'…"` 被 Content-Type 误判进 PowerShell → Set-Location 报错） */
  /^\s*cd\s+\/[a-z]\b/im,
  /\bfindstr\b/i,
]
/** ★ 0925g：cmd 首词闸（优先级最高）—— 首词是 cmd 内建且多带斜杠参数（/d /s /c /f …），
 *  PowerShell 根本不认这些参数，100% 是 cmd 语法，别再看别的信号。 */
const CMD_FIRST_TOKEN_RE = /^\s*(?:cd|copy|del|dir|type|findstr|xcopy|robocopy|tasklist|taskkill|schtasks|reg|sc|net|ren|move|rd|md|mkdir|rmdir|set|echo|where|title|cls|tree|ipconfig|winget|curl)\s+\/[a-z]\b/im
/** PowerShell 专属语法 */
const PS_SIGNAL_RE = [
  /\$env:/,
  /* ★ 0925g：Verb-Noun 收紧成**动词白名单** —— 原来 /\b[A-Z][a-z]{2,}-[A-Z][a-zA-Z]{2,}\b/ 太宽，
     Content-Type 这类普通连字符词会被误判成 PS 命令（实测踩坑）。 */
  /\b(?:Get|Set|New|Remove|Write|Read|Test|Select|Where|ForEach|Out|Invoke|Start|Stop|Restart|ConvertTo|ConvertFrom|Convert|Format|Import|Export|Clear|Add|Update|Copy|Move|Rename|Join|Split|Sort|Measure|Compare|Confirm|Find|Resolve|Expand|Compress|Protect|Unprotect|Wait|Debug|Trace|Push|Pop|Enter|Exit|Enable|Disable|Install|Uninstall|Register|Unregister|Connect|Disconnect|Send|Receive|Limit|Group|Tee|Restore|Save|Open|Close|Publish|Approve|Deny|Grant|Revoke|Backup|Mount|Dismount|Block|Unblock|Request|Submit|Sync|Merge|Reset|Repair|Optimize|Initialize)\-[A-Z][a-zA-Z]+\b/,
  /-(?:ErrorAction|NoProfile|NoLogo|ExecutionPolicy|Recurse|LiteralPath|Include|Exclude|Filter)\b/,
  /\[(?:System|string|int|bool|array|hashtable|regex|datetime|math)\.?/i,
  /@\{|@\(/,
  /\$_\b|\$null\b|\$true\b|\$false\b/,
  /\$\w+\s*(?:=[^=]|\+=|\|\||&&)/,
  /-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|join|split)\b/,
  /\|\s*(?:\?|%|ForEach-Object|Where-Object|Select-Object|Sort-Object)\b/,
  /`[A-Za-z0-9$"']/,                                            // 反引号转义
]

/** bash/unix 专属语法（★1010-D：**装了 Git Bash 才启用**；判据保守——只认 bash 独有形态，
 *  与 cmd/PS 信号冲突时绝不抢活（见 resolveShellForCommand：bashHit 须独占）。 */
const BASH_SIGNAL_RE = [
  /^\s*#!/m,                                            // shebang
  /(?:^|[\s=(;|&])~\//,                                 // 家目录简写 ~/
  /\$\([^)]+\)/,                                        // $(命令替换)
  /^\s*export\s+[A-Za-z_]\w*=/m,                        // export X=Y
  /\$[A-Za-z_]\w*\b(?![\w:.(])/,                        // 裸 $VAR（$env:/$_/$null 归 PS 信号）
  /(?:^|\s)(?:grep|sed|awk|chmod|chown|which|uname|stat|diff|patch|tar)\s+(?:-{1,2}\w|['"])/,
  /\/dev\/null/,
]

/** 把「自动选择」解析成具体 Shell（非 auto 时原样返回）；导出以便自检脚本直接验证 */
export function resolveShellForCommand(kind: ShellKind, command: string): 'cmd' | 'powershell' | 'pwsh' | 'bash' {
  if (kind !== 'auto') return kind
  /* ★ 0925g（用户定）：首词闸优先 —— `cd /d X && node -e "…Content-Type…"` 这类混合命令，
     曾被宽 Verb-Noun 正则误判进 PowerShell（Set-Location 不认识 /d 直接报错）。
     首词是 cmd 内建 + 斜杠参数 = 100% cmd 语法，不用再看别的信号。 */
  if (CMD_FIRST_TOKEN_RE.test(command)) return 'cmd'
  const cmdHit = CMD_SIGNAL_RE.some((re) => re.test(command))
  const psHit = PS_SIGNAL_RE.some((re) => re.test(command))
  /* ★1010-D：bash 只在「信号独占」时被选中 —— 命令必须是明确的 unix/bash 风格、
     且不带任何 cmd/PS 信号、且机器上装了 Git Bash。三者缺一就回落原逻辑（零行为变化）。 */
  if (!cmdHit && !psHit && hasBash() && BASH_SIGNAL_RE.some((re) => re.test(command))) return 'bash'
  if (psHit && !cmdHit) return hasPwsh() ? 'pwsh' : 'powershell'
  return 'cmd'
}

/** 给模型看的「当前终端」说明（自动模式下要告诉它两种语法都能用） */
function shellHintForModel(): string {
  const k = currentShellKind()
  if (k === 'auto') {
    return '当前终端为「自动选择」：你按最自然的方式写就行 —— PowerShell 语法（Get-ChildItem、$env:、-ErrorAction、Where-Object 等）会自动走 PowerShell，批处理/cmd 语法（%VAR%、@echo off、for /f、set /a）会走 cmd，纯 exe 调用（npm/git/node 等）默认走 cmd。'
  }
  const name = k === 'cmd' ? 'cmd.exe' : k === 'pwsh' ? 'PowerShell 7（pwsh.exe）' : k === 'bash' ? 'Git Bash（bash.exe）' : 'Windows PowerShell（powershell.exe）'
  return `当前终端固定为 ${name}，命令必须写成该 Shell 的语法。`
}

/** ★ 0922e：进程监控用的来源信息（哪条会话、哪个工具拉起的） */
interface RunMeta { tool?: string; conversationId?: string; projectId?: string }
function runCommand(cwd: string, command: string, timeoutMs: number, meta?: RunMeta, shellOverride?: 'cmd' | 'powershell' | 'pwsh' | 'auto', signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null; shell: string }> {
  return new Promise((resolve, reject) => {
    // 换行归一（CR 会被 cmd 当普通字符吞进参数——"mkdir backend\rofiles" 实锤）
    const isWin = process.platform === 'win32'
    let normalized = isWin ? command.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : command
    let cleanup: (() => void) | null = null
    /* ★ 0925g（用户定）：node -e 内联脚本自动落盘 —— 引号/中文经两层转义极易崩（实测踩坑），
     * 整条命令恰好是 `node -e "…"` 形态时提出来写临时 .cjs，跑完清理。
     * ★ 1010-C 修（实测必炸）：落盘后**直跑 node、不套 cmd** —— 原来拼 `"<exe>" "<file>"`
     *   交给 cmd /s /c + windowsVerbatimArguments，cmd 的「/s 剥掉首尾引号」规则会把
     *   exe 与参数粘成一个非法路径（报「文件名、目录名或卷标语法不正确」；带引号的 node
     *   路径 100% 复现，裸 `node` 只是恰好剥成合法形态才侥幸能跑）。直跑绕开 shell 引号层，
     *   语义与 `node <file>` 一致。 */
    let direct: { exe: string; arg: string } | null = null
    const inline = extractInlineNodeScript(normalized)
    if (inline) {
      const tmp = writeTempCjsFile(inline.script)
      if (tmp) {
        cleanup = tmp.cleanup
        direct = { exe: inline.nodeExe.replace(/^(['"])([\s\S]*)\1$/, '$2'), arg: tmp.file }
      }
    }
    let argv: string[]
    let exe = isWin ? 'cmd.exe' : '/bin/sh'
    /* 0920：把「这条命令实际走了哪个 Shell」带出去，供前端在命令过程行显示一个小标识 */
    let shellLabel: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh' = isWin ? 'cmd' : 'sh'
    if (isWin) {
      // 0914：命令终端（设置→通用）——cmd / Windows PowerShell / PowerShell 7，选了哪个就只用哪个
      // 0918：多了 'auto'（自动选择）→ 按本条命令的语法特征解析成具体 Shell
      // 0925g：shellOverride（run_command 的 shell 参数）优先于全局设置 —— 混合语法误判时的逃生舱
      const chosen = resolveShellForCommand(shellOverride || currentShellKind(), normalized)
      shellLabel = chosen
      if (chosen === 'bash') {
        // Git Bash：-c 而非 -lc（避免读登录 profile 带来的副作用与额外耗时）
        // ★1010-D：仿 pwsh「装了才能用」——未装给明确去路，别让模型对着 ENOENT 瞎猜
        const bp = bashExePath()
        if (!bp) throw new Error('Git Bash 未安装：请到 设置 → 运行环境 安装「Git Bash」，或把命令终端换回 自动选择/cmd/PowerShell')
        exe = bp
        argv = ['-c', normalized]
      } else if (chosen === 'powershell' || chosen === 'pwsh') {
        exe = chosen === 'pwsh' ? (pwshExePath() || 'pwsh.exe') : 'powershell.exe'
        // ★ 1010-B：引号风险高（嵌套引号 + 正则/JSON/$变量）时把脚本落成临时 .ps1 用 -File 跑，
        //   绕开「-Command 整串过 shell 时的多层引号剥离」。与已有的 node -e 自动落盘同构。
        const risky = needsPsFile(normalized)
        if (risky) {
          const tmp = writeTempPs1File(normalized)
          if (tmp) { cleanup = tmp.cleanup; argv = [`-NoLogo`, `-NoProfile`, `-NonInteractive`, `-ExecutionPolicy`, `Bypass`, `-File`, tmp.file] }
          else argv = [`-NoLogo`, `-NoProfile`, `-NonInteractive`, `-Command`, normalized] // 兜底：临时文件写不出时照旧
        } else {
          argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', normalized]
        }
      } else if (normalized.includes('\n')) {
        const tmp = writeTempCmdFile(normalized)
        /* ★ 1010-C 修（实测炸）：cmd 分支带 windowsVerbatimArguments，Node **不会**给 argv 加引号
         *  （旧注释写反了）—— tmp 路径带空格时（TMP 在用户目录下、用户名带空格即中招）裸路径
         *  会被空格拆开；cmd /s 的「剥首尾引号」规则下只有**双层引号** `""path""` 剥完剩一层
         *  才是合法形态（三例实测：裸路径炸 / 单层引号炸 / 双层引号过）。 */
        if (tmp) { cleanup = tmp.cleanup; argv = ['/d', '/s', '/c', `""${tmp.file}""`] }
        else argv = ['/d', '/s', '/c', normalized.split('\n')[0]] // 兜底：临时文件都写不出时至少跑第一行（旧行为）
      } else {
        argv = ['/d', '/s', '/c', normalized]
      }
    } else {
      argv = ['-c', normalized]
    }
    /* ★ 1010-C：node -e 落盘走直跑（exe/argv 已在上面备好），完全绕开 shell 引号层 */
    if (direct) { exe = direct.exe; argv = [direct.arg] }
    const cp = execFile(
      exe,
      argv,
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'buffer',
        /* ★ 0920 修一个真 bug：cmd.exe 下必须让 Node **原样**传参。
           Node 默认会按 CRT 规则给参数加引号/转义（`node -e "..."` → `node -e \"...\"`），
           可 cmd.exe 根本不认反斜杠转义、还带 `/s` 的引号剥离规则 ⇒
           带双引号的命令**静默变成空输出**（实测 `node -e "console.log(42)"` 返回空、`echo "hi"` 返回 `\"hi\"`）。
           PowerShell 相反：默认转义才是对的，加 verbatim 反而会把一个脚本拆成多个参数。
           所以只对 cmd.exe 开这个开关。 */
        windowsVerbatimArguments: isWin && /cmd\.exe$/i.test(exe),
      },
      (err: any, stdoutRaw: any, stderrRaw: any) => {
        /* ★ 0922e：命令跑完（成功/失败/超时）→ 从「进程监控」移除 */
        procEndByPid(cp.pid as number)
        cleanup?.()
        const stdout = decodeOutput(Buffer.isBuffer(stdoutRaw) ? stdoutRaw : Buffer.from(String(stdoutRaw ?? '')))
        const stderr = decodeOutput(Buffer.isBuffer(stderrRaw) ? stderrRaw : Buffer.from(String(stderrRaw ?? '')))
        if (err) {
          resolve({ stdout, stderr, code: typeof err.code === 'number' ? err.code : null, shell: shellLabel })
          return
        }
        resolve({ stdout, stderr, code: 0, shell: shellLabel })
      },
    )
    /* ★ 0922e：登记进「进程监控」注册表（结束/失败时在回调里注销） */
procRegister(cp.pid as number, { exe, cmdline: command, cwd, origin: { tool: meta?.tool || 'run_command', conversationId: meta?.conversationId, projectId: meta?.projectId, label: command } })
/* ★0930 修（实测"点停止分身还在跑命令，根本停不掉"）：**中止信号 = 立即树杀命令进程** ——
   工具 execute 本来就收 pi 的 AbortSignal（第 3 参），此前一直忽略（`_signal`）⇒
   点停止只断了 LLM 流，正在跑的命令子进程活到自然结束（2~5 分钟循环实测）。
   与超时树杀同一条 taskkill /T 路；监听器随 exit 拆除，不泄漏。 */
    const abortKill = () => {
      try { execFile('taskkill', ['/pid', String(cp.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
    }
    if (signal) {
      if (signal.aborted) abortKill()
      else signal.addEventListener('abort', abortKill, { once: true })
      cp.on('exit', () => signal.removeEventListener('abort', abortKill))
    }
// 0906 体检 P3#26：Windows 超时只杀直接子进程，npm→node 孙进程残留 → 树杀兜底
    if (process.platform === 'win32') {
      const treeKill = setTimeout(() => {
        try { execFile('taskkill', ['/pid', String(cp.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
      }, timeoutMs + 1000)
      treeKill.unref?.()
      const treeKillT0 = Date.now()
      /* 0927 netfix tree-keep-0927：只有"自然早退"才取消树杀兜底 —— 超时被杀时 exit 同样会到，
         原实现无条件清定时器 ⇒ 超时命令里内层 shell 起的孙进程永远残留。 */
      cp.on('exit', () => { if (Date.now() - treeKillT0 < timeoutMs) clearTimeout(treeKill) })
    }
    cp.on('error', (e: any) => {
      if (e?.code === 'ENOENT') {
        reject(new Error(`找不到 ${exe}：请到 设置→通用→命令终端 换一个 Shell（改成「自动选择」或「cmd」，或先在「运行环境」里安装它）`))
        return
      }
      reject(e)
    })
  })
}

function buildCmdTool(cwd: string, actor: string = DEFAULT_ACTOR, sessionId?: string): AgentTool<typeof cmdParams, /* ★1005 放宽声明：onUpdate 还会传 cwd / running / shell（跑起来时的即时态），原声明只有收尾三件套。 */
  /* 同 grep：进度帧只有 cwd/running/shell，收尾才给 code/stdout/stderr ⇒ 后者必须可选。 */
  { code?: number | null; stdout?: string; stderr?: string; cwd?: string; running?: boolean; shell?: string; intent?: string }> {
  return {
    name: 'run_command',
    label: '执行命令',
    description: '在会话工作区中执行 shell 命令并返回输出。适合安装依赖、运行测试、跑脚本、构建等。' +
      '参数 shell 可显式指定终端（cmd/powershell/pwsh）——命令里混有两种语法导致自动选择误判时用它兜底。' +
      'node -e 内联脚本会自动落盘成临时 .cjs 执行（引号/中文不再被转义搞崩），复杂脚本仍建议直接写文件跑。' +
      'Windows 注意：多行命令用 \\n 分隔；查文件内容用 fs_read（找内容可用 run_command 跑 node/rg，别用 findstr 搜中文）。' +
      '★ 命令摘要：尽量同时填 intent —— 一句话说清这步的业务目的（中文 10~20 字，面向用户，如「在 server.ts 里找压缩触发逻辑」），' +
      '不要写「执行命令」「查找文件」这类泛词；不确定就不填（界面会退回规则摘要）。' + shellHintForModel(),
    parameters: cmdParams,
    async execute(_callId, params, _signal, onUpdate) {
      const work = params.cwd ? resolvePath(cwd, params.cwd) : cwd
      const timeoutMs = params.timeoutMs ?? 120000
      /* s5：模型给的摘要（可缺）——只做归一化，不参与任何执行逻辑 */
      const intent = String((params as any).intent || '').trim() || undefined
      // 命令执行前拍工作区树快照（兜底覆盖 shell 重定向/脚本写入的文件变更）
      if (commandMayWrite(params.command)) {
              // ★1127：snapshotTree 已异步分片化（IO 走 fs.promises，每 32 个文件让出一次事件循环），
              // 这里必须 await —— 否则命令会先跑、快照拍到的是"执行后"状态。
              await snapshotTree({ workDir: cwd, actor: actor, sessionId, toolCallId: _callId, turn: getSnapshotTurn(sessionId) ?? undefined })
            }
      /* 0920：先按语法特征预判一次（与 runCommand 内部同一函数，结果一致），
         这样"执行中"那一帧就能显示终端标识，不用等命令跑完 */
      const shellPreview = process.platform === 'win32'
        ? resolveShellForCommand((params.shell as any) || currentShellKind(), params.command.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
        : 'sh'
      onUpdate?.({ content: [], details: { cwd: work, running: true, shell: shellPreview, ...(intent ? { intent } : {}) } })
      const { stdout, stderr, code, shell } = await runCommand(work, params.command, timeoutMs, { tool: 'run_command', conversationId: sessionId }, (params.shell as any) || undefined, _signal)
      const outText = [stdout.trim() ? `stdout:\n${tail(stdout)}` : '', stderr.trim() ? `stderr:\n${tail(stderr)}` : ''].filter(Boolean).join('\n')
      return {
        content: [{ type: 'text', text: outText || `(无输出) 退出码 ${code}` }],
        details: { code, stdout: tail(stdout), stderr: tail(stderr), shell, ...(intent ? { intent } : {}) },
      }
    },
  }
}


/* ══════ ★ g3：check_run —— 验收专用命令（只看退出码，不看输出）══════════════════════
 * 为什么要有（总方案 §2.5）：要真删「目标模式」，必须先把 `goalVerifier.runGate()` 那套
 * 「真跑命令、拿 exitCode 当硬判据」迁成通用能力 —— 目标模式里唯一不可替代的就是它。
 * 与 run_command 的分工：run_command 是"干活"（模型要读输出、据输出继续改）；check_run 是
 * "验收"（模型/前端/测试流程只关心 ok:true|false）。
 *
 * ★ 安全边界（本工具**不是**旁路，与 run_command 同级）：
 *   · 执行器同一个：runCommand() —— 同一套 shell 解析（自动选终端 / 多行落 .cmd）、同一套
 *     超时树杀与中止树杀、同一套进程登记、同一套 cwd 语义（默认会话工作区）。
 *     没有第二套实现 = 没有第二套漏洞面。
 *   · 审批链同一个：server.ts 的 assessRisk 里有与 run_command **逐条对齐**的 check_run 分支
 *     （DANGEROUS_CMD / MUTATING_CMD / 工作区外 三条判定 + 同样的 risk 分级 + 同样用命令串做
 *     会话级授权指纹）；approvalGate 里那条「无差别进程杀伤命令」硬拦截（full_access 也不放行）
 *     也已按 check_run 补齐（否则换名即绕过 0902 那次 taskkill /IM node.exe 事故的护栏）。
 *   · 这里**故意不做白名单 / 只读闸门**：验收命令天然会写盘（npm test、tsc 出 tsbuildinfo、
 *     jest 写 coverage），任何"看起来安全"的白名单都会误杀真实验收；更糟的是它会造出假象——
 *     模型以为"工具自己会拦"，于是把危险命令塞进来。真正可靠的判据只有「命令内容 + 审批链」，
 *     那属于 server.ts；工具层再判一次 = 两套判据必然漂移，漂移的那一边一定先失效。
 *   · 因此 `readOnly` 只是**意图声明**（默认 true），写进 details 供前端/验收流程展示，
 *     ⚠️ 它不参与任何放行判定 —— 传 false 也照旧走审批，传 true 也不会免审。
 */

export const CHECK_RUN_DEFAULT_TIMEOUT_MS = 120000
export const CHECK_RUN_MAX_TIMEOUT_MS = 600000
/** stdout+stderr 合计超过它就只留**末尾**（验收看的就是最后那批报错；32KB ≈ 8000 汉字） */
export const CHECK_RUN_MAX_OUTPUT_CHARS = 32 * 1024
/** 正文回给模型的尾部行数上限（再长的让它 fs_read 落盘正文，别把上下文撑爆） */
const CHECK_RUN_TAIL_LINES = 60

const checkRunParams = Type.Object({
  cmd: Type.String({ description: '要执行并验收的命令（如 "npm test" / "node check-b1-syntax.cjs"）' }),
  timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒（默认 120000，上限 600000）；超时按 FAIL 处理，exitCode 记 null' })),
  cwd: Type.Optional(Type.String({ description: '可选：覆盖工作目录（默认＝会话工作区）' })),
  readOnly: Type.Optional(Type.Boolean({ description: '（默认 true）仅声明"这条是只读检查"给界面看；⚠️ 不参与审批判定，也不影响执行' })),
  intent: Type.Optional(Type.String({ description: '一句话说明在验什么（中文 10~20 字，如「验 check-b1-syntax 语法」）' })),
})

/** 验收命令：真跑、拿 exitCode、给 ok 硬判据（details.ok = exitCode === 0） */
export function buildCheckRunTool(cwd: string, sessionId?: string): AgentTool<any> {
  return {
    name: 'check_run',
    label: '验收命令',
    description: '跑一条命令并返回**退出码** —— 用于验收：exitCode===0 算通过。'
      + '与 run_command 的区别：run_command 是"干活"（看输出）；check_run 是"验收"（看退出码）。'
      + '用户说"跑一下测试验一下"、或计划里写了验收命令时用它。'
      + '返回末尾若干行输出 + details.ok（可直接当硬判据）。',
    parameters: checkRunParams,
    async execute(_callId: string, params: any, signal?: AbortSignal, onUpdate?: any) {
      const command = String(params?.cmd || '').trim()
      if (!command) throw new Error('cmd 不能为空')
      const work = params?.cwd ? resolvePath(cwd, String(params.cwd)) : cwd
      const asked = Number(params?.timeoutMs)
      const timeoutMs = Math.min(
        Math.max(1000, Number.isFinite(asked) && asked > 0 ? asked : CHECK_RUN_DEFAULT_TIMEOUT_MS),
        CHECK_RUN_MAX_TIMEOUT_MS,
      )
      const readOnly = params?.readOnly !== false
      const intent = String(params?.intent || '').trim() || undefined
      /* 跑起来那一帧：与 run_command 同款（前端据此显示"进行中"），不带 shell —— 终端由执行器内部判 */
      onUpdate?.({ content: [], details: { running: true, cmd: command, cwd: work, ...(intent ? { intent } : {}) } })
      const t0 = Date.now()
      /* 与 run_command **完全同一个执行器**（shell 解析 / 超时树杀 / 中止树杀 / 进程登记都在里面） */
      const { stdout, stderr, code } = await runCommand(
        work, command, timeoutMs, { tool: 'check_run', conversationId: sessionId }, undefined, signal as any,
      )
      const durationMs = Date.now() - t0
      const ok = code === 0
      /* 输出截断：stdout+stderr 合计 > 32KB 只留**末尾**。
         ⚠️ 不复用 tail()：tail 是"头 35% + 尾 65%"（给模型看上下文用的），验收只关心尾部报错。 */
      const merged = [stdout, stderr].filter(s => s && s.trim()).join('\n')
      const truncated = merged.length > CHECK_RUN_MAX_OUTPUT_CHARS
      const kept = truncated ? merged.slice(-CHECK_RUN_MAX_OUTPUT_CHARS) : merged
      const lines = kept.replace(/\s+$/, '').split('\n').filter(l => l.trim())
      const tailLines = lines.slice(-CHECK_RUN_TAIL_LINES)
      const text = [
        `退出码：${code === null ? '（无：超时/被杀）' : code}`,
        `命令：${command}`,
        `耗时：${(durationMs / 1000).toFixed(2)}s${readOnly ? '' : '（已声明为写操作）'}`,
        `输出（尾部 ${tailLines.length} 行${truncated ? `；原文 ${merged.length} 字，已截至末尾 ${CHECK_RUN_MAX_OUTPUT_CHARS} 字` : ''}）：`,
        tailLines.length ? tailLines.join('\n') : '（无输出）',
        ok ? '结论：PASS（exitCode=0）' : `结论：FAIL（exitCode=${code === null ? 'null' : code}）`,
      ].join('\n')
      return {
        content: [{ type: 'text', text }],
        /* details.ok 是**硬判据**：前端/验收流程/后续 check_run 汇总直接读它，不用再解析文本 */
        details: { ok, exitCode: code, cmd: command, durationMs, readOnly, truncated, ...(intent ? { intent } : {}) },
      }
    },
  }
}

/** 会话工具集：cwd 绑定到该会话的工作区 */
/* ── 0910 三批⑤：项目档案（工作区根 NIS-notes.md）——跨对话/跨窗口的项目记忆 ──
 *  同一工作区的所有对话共享这一份文件；新窗口不必写交接词，让 AI 先读它即可了解项目与进度。
 *  约定/进度 = 整节替换（保持最新状态）；决策记录/产物清单 = 追加带时间戳的一条。
 *  ★1010：常量与"摘要/分节读取"都搬去 noteDigest.ts —— 档案会长到几十万字符，
 *   系统提示里注入"档案卡"，细节用 action=read 按节取，别再整份 fs_read。 */

const noteParams = Type.Object({
  action: Type.Optional(Type.String({ description: 'read=读（省 token：不传 section 给「档案目录+最近进度」，传 section 只给那一节）；不传=写（默认）' })),
  section: Type.Optional(Type.String({ description: `哪一节：${NOTE_SECTIONS.join(' / ')}（写时必填；read 时不传＝只看目录）` })),
  text: Type.Optional(Type.String({ description: '写入内容（仅写时用）。**任务日志/决策记录/产物清单＝追加一条**（最省 token，收尾记流水用这个）；项目约定/当前进度＝整节替换（必须给完整最新内容；很贵，只在重写总览时才用，且只留最近几条）' })),
  maxChars: Type.Optional(Type.Number({ description: 'action=read 读该节的字符上限（默认 12000）' })),
})

function upsertProjectNote(raw: string, section: string, text: string): string {
  const head = '# 项目档案（NiusDream 自动维护）\n\n> 同一工作区的所有对话共享这份档案；新窗口会自动在系统提示里看到它的「档案卡」（体量+各节行范围+最近任务）——要细节用 project_note(action="read", section="…") 按节取，**别整份读**。\n'
  const sections: Record<string, string[]> = {}
  for (const s of NOTE_SECTIONS) sections[s] = []
  if (raw) {
    /* 0927 netfix note-keep-0927：只认【已知小节名】的 '## ' 行做分节 —— 原 split(/^## /m) 把正文里
       用户自己写的 markdown 二级标题也切开，标题之后的整段内容被当成"未知小节"丢弃（丢档）。 */
    const KNOWN = new Set<string>(NOTE_SECTIONS)
    let cur = ''
    for (const line of raw.split('\n')) {
      const m = /^## (.+)$/.exec(line)
      if (m && KNOWN.has(m[1].trim())) { cur = m[1].trim(); continue }
      if (!cur) continue
      sections[cur].push(line)
    }
    for (const s of NOTE_SECTIONS) {
      const arr = sections[s]
      while (arr.length && !arr[arr.length - 1].trim()) arr.pop()
    }
  }
  /* ★1010b：追加型节 —— 任务日志/决策记录/产物清单（新条目追加在末尾，写一次几十字）；
     其余（项目约定/当前进度）= 整节替换。 */
  if (section === '任务日志' || section === '决策记录' || section === '产物清单') {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    sections[section] = [...sections[section].filter(l => l && l !== '（暂无）'), `- [${stamp}] ${text}`]
  } else {
    sections[section] = text.split('\n')
  }
  let out = head
  for (const s of NOTE_SECTIONS) {
    out += `\n## ${s}\n${sections[s].length ? sections[s].join('\n') + '\n' : '（暂无）\n'}`
  }
  return out
}

export function buildProjectNoteTool(cwd: string): AgentTool<typeof noteParams, { path: string }> {
  return {
    name: 'project_note',
    label: '项目档案（读/写）',
    description: '维护工作区根的项目档案（NIS-notes.md）：项目约定/当前进度/任务日志/决策记录/产物清单。'
      + '**读**：action="read" —— 不传 section＝档案目录（体量+各节行范围+最近进度），传 section＝只取那一节（省 token 的正道，'
      + '**别用 fs_read 整份读它**：档案会长到几十万字符）；'
      + '**写**：不传 action。**收尾记流水优先用「任务日志」（追加一条，零重写成本）**；决策记录/产物清单同样追加；'
      + '「当前进度」＝整节替换（很贵：只在需要重写总览时才用，且只留最近 3~5 条，旧任务压成一行挪进任务日志 —— 档案越长，每个新窗口都要多花 token 读它）。',
    parameters: noteParams,
    async execute(_callId, params: any) {
      const action = String(params?.action || 'write').trim().toLowerCase()
      const section = String(params?.section || '').trim()
      const abs = path.join(cwd, PROJECT_NOTE_FILE)
      if (action === 'read') {
        if (section) {
          if (!(NOTE_SECTIONS as readonly string[]).includes(section)) throw new Error(`section 必须是：${NOTE_SECTIONS.join(' / ')}`)
          const sec = readNoteSection(cwd, section, Math.min(60000, Number(params?.maxChars) || 12000))
          if (!sec) throw new Error(`读不到档案的「${section}」节：${abs}（档案不存在、或该节名未知；已知节：${NOTE_SECTIONS.join(' / ')}）`)
          const pos = sec.startLine ? `第 ${sec.startLine}-${sec.endLine} 行，` : ''
          return {
            content: [{ type: 'text', text: `档案「${section}」节（${pos}共 ${sec.chars} 字符${sec.truncated ? '，已截断' : ''}）：\n${sec.text || '（空）'}` }],
            details: { path: PROJECT_NOTE_FILE, section, chars: sec.chars },
          }
        }
        const d = buildNoteDigest(cwd, 4000)
        if (!d.exists) throw new Error(`工作区还没有项目档案：${abs}（用 project_note 写一条即创建）`)
        const list = d.sections.length
          ? d.sections.map((s: any) => `· ${s.name}：第 ${s.startLine}-${s.endLine} 行，${s.chars} 字符${['任务日志', '决策记录', '产物清单'].includes(s.name) ? `，${s.entries} 条` : ''}`).join('\n')
          : '（没解析到已知节：档案是空的或格式异常 —— 随便写一条 project_note 会自动补全四节）'
        return {
          content: [{ type: 'text', text: `项目档案 ${d.file}：${d.lines} 行 / ${d.chars} 字符（≈${d.tokens} token）\n${list}\n\n要哪一节：action="read" + section="当前进度"（别整份 fs_read 它）。` }],
          details: { path: PROJECT_NOTE_FILE, chars: d.chars },
        }
      }
      const text = String(params?.text || '').trim()
      if (!(NOTE_SECTIONS as readonly string[]).includes(section)) throw new Error(`写档案必须给 section（${NOTE_SECTIONS.join(' / ')}）`)
      if (!text) throw new Error('text 不能为空')
      let raw = ''
      try { if (fs.existsSync(abs)) raw = fs.readFileSync(abs, 'utf8') } catch { raw = '' }
      fs.writeFileSync(abs, upsertProjectNote(raw, section, text), 'utf8')
      const d = buildNoteDigest(cwd, 900)   // 写完顺带回个体量/行范围，省掉"确认式回读"
      return {
        content: [{ type: 'text', text: `已更新项目档案 ${PROJECT_NOTE_FILE} 的「${section}」——现 ${d.lines} 行 / ${d.chars} 字符（≈${d.tokens} token）；各节行范围：${d.sections.map((s: any) => `${s.name} ${s.startLine}-${s.endLine}`).join('｜')}` }],
        details: { path: PROJECT_NOTE_FILE },
      }
    },
  }
}

/* ── 0920：后台任务工具（挂后台 / 查进度 / 读输出 / 停） ──
 *  为什么要有这一组：装依赖、下载大文件、长命令在工具里同步等会**卡住整轮对话**。
 *  挂后台 → 立刻拿到 task_id 继续干别的；结束时 server 会 steer 一条通知回来（见 backgroundTasks.ts）。
 */
const bgStartParams = Type.Object({
  title: Type.String({ description: '任务名（给人看的短标题，如「下载 NiusDream 模型」「npm install」）' }),
  command: Type.Optional(Type.String({ description: '要后台执行的 shell 命令（与 run_command 同一套 Shell 语义）；与 url 二选一' })),
  url: Type.Optional(Type.String({ description: '要后台下载的 http(s) 地址；配 dest 使用' })),
  dest: Type.Optional(Type.String({ description: '下载保存路径（绝对路径或相对会话工作区）' })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: '(仅 url 模式) 自定义请求头（鉴权直链用，带了才有进度条/可暂停）' })),
  est_sec: Type.Optional(Type.Number({ description: '预计秒数（面板画「预计」条+约剩多久）——只在对时长有把握时给；守护型任务（服务/监听）不要给' })),
  cwd: Type.Optional(Type.String({ description: '命令的工作目录（缺省=会话工作区）' })),
  /* s5：同 run_command 的 intent —— 挂后台时也让人一眼看出这一步在干什么 */
  intent: Type.Optional(Type.String({ description: '一句话说明这步要干什么（中文 10~20 字，面向用户，别用工具名或「执行命令」这类泛词重复；例：「后台重装依赖修 npm 缓存」）。可选：不确定就不填' })),
})

const bgWatchParams = Type.Object({
  task_id: Type.Optional(Type.String({ description: '要回访的后台任务 id（bg_start 返回的）；不填 = 回看该会话全部在跑的任务' })),
  after_sec: Type.Number({ description: '多少秒后回来（5 ~ 1800，默认 30）' }),
  note: Type.Optional(Type.String({ description: '回来要干什么（会原样带给你自己），如"看下载进度，太慢就换源"' })),
})

const bgIdParams = Type.Object({
  task_id: Type.String({ description: '后台任务 id（bg_start 返回的那个）' }),
  lines: Type.Optional(Type.Number({ description: 'bg_read 时取末尾多少行，默认 60' })),
})

/** ★ 0922c-7（Q2）：AI 自报进度（命令类任务也能有读条） */
const bgNoteParams = Type.Object({
  task_id: Type.String({ description: '后台任务 id（bg_start 返回的那个）' }),
  note: Type.Optional(Type.String({ description: '一行说明，如「编译 3/8 模块」「已处理 120/500」' })),
  percent: Type.Optional(Type.Number({ description: '整体进度百分比 0~100（知道总量就报，不知道就别报——别编一个假的）' })),
  est_sec: Type.Optional(Type.Number({ description: '修正"预计总时长"（秒）——发现跑得比预想快/慢时更新它，面板的「预计」条会跟着变' })),
})

const bgEmptyParams = Type.Object({})

export function buildBgTools(cwd: string, sessionId?: string): AgentTool<any>[] {
  const convId = String(sessionId || '')
  // ★ 0929 刀①：以下 6 个 bg_* 保留为【家族内部实现】（不外挂），外面合并成 bg(action=…)
  const subs: any[] = [
    {
      name: 'bg_start',
      label: '挂到后台',
      description:
        '把一个**耗时**动作挂到后台执行，立刻返回 task_id，不阻塞当前对话。适用于：装依赖、下载大文件、跑几分钟以上的构建/测试/脚本。' +
        '两种模式**按情况选**（选错会让用户看不到进度）：\n' +
        '① **url + dest（下载模式）**：有**进度条 / 速度 / 剩余时间，且用户可暂停继续**。' +
        '**有时长把握就填 est_sec**（秒）——没百分比的挂机/长命令也会因此显示「预计」条与"约剩多久"。' +
        '仅用于「公开直链、服务端返回 content-length」的文件；需要鉴权就给 headers（如 Authorization/Cookie）。' +
        '限制：只支持 GET、只认 200、不跟随需要重放头部的复杂跳转、无断点续传/代理；服务器不返 content-length 时没有百分比（只有字节数）。\n' +
        '② **command（命令模式）**：**只有计时与输出，没有进度条**（面板按"挂机类"显示）。需要 POST、多文件、' +
        '本来就得用 curl / aria2c / hf download / git clone / pip / Invoke-WebRequest 等 CLI 的下载，**用命令模式**；' +
        '这种情况要主动告诉用户"这个任务看不到百分比"。\n' +
        '⚠️ 只有"值得挂后台"的才用它（几秒就完的直接 run_command）；挂完可以继续做别的事，任务结束时会收到通知。' +
        '**任务失败时**：能自愈（网络抖动/换源/临时占用）就自己重试一次并说明；需要用户拍板或已失败两次 → 停下来用 ask_user 问用户，别默默重试到天荒地老。',
      parameters: bgStartParams,
      async execute(callId, params) {
        const title = String((params as any).title || '').trim() || '后台任务'
        const cmd = String((params as any).command || '').trim()
        const url = String((params as any).url || '').trim()
        const dest = String((params as any).dest || '').trim()
        const work = (params as any).cwd ? resolvePath(cwd, String((params as any).cwd)) : cwd
        const hdr = (params as any).headers
        if (cmd && url) return { content: [{ type: 'text', text: '【错误】command 与 url 只能给一个。' }], details: { ok: false } }
        if (hdr && !url) return { content: [{ type: 'text', text: '【错误】headers 只在 url（下载）模式下生效；命令模式请把 header 写进命令里（如 curl -H）。' }], details: { ok: false } }
        const estSec = Number((params as any).est_sec) > 0 ? Math.round(Number((params as any).est_sec)) : undefined
        if (url) {
          const abs = resolvePath(cwd, dest)
          const r = bgStartDownload(url, abs, { title, conversationId: convId, cwd: work, headers: hdr, estSec, spawnedByCall: String(callId || '') })
          if (!r.ok) return { content: [{ type: 'text', text: `【挂后台失败】${r.error}` }], details: { ok: false } }
          return {
            content: [{ type: 'text', text: `已在后台开始下载：${title}\n· task_id = ${r.task!.task_id}\n· 保存到 ${abs}${hdr ? '\n· 已带自定义请求头' : ''}\n（用户可暂停/继续，面板有进度条）继续做别的事即可；跑完会自动通知你（也可以随时用 bg_list / bg_read 查）。\n· 想中途看一眼：约 ${bgSuggestWatchSec(r.task!.task_id)} 秒后回访（用 bg_watch）；不约也行，跑完会通知你。` }],
            details: { ok: true, taskId: r.task!.task_id, kind: 'download' },
          }
        }
        if (!cmd) return { content: [{ type: 'text', text: '【错误】command 与 url 至少要给一个。' }], details: { ok: false } }
        const r = bgStartCommand(cmd, { title, conversationId: convId, cwd: work, estSec, spawnedByCall: String(callId || '') })
        if (!r.ok) return { content: [{ type: 'text', text: `【挂后台失败】${r.error}` }], details: { ok: false } }
        return {
          content: [{ type: 'text', text: `已挂到后台执行：${title}\n· task_id = ${r.task!.task_id}\n· 工作目录 ${work}\n· 命令 ${cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd}\n继续做别的事即可；跑完会自动通知你（也可以随时用 bg_list / bg_read 查）。\n· 知道总步数/总量的话，中途可用 bg_note 报进度（面板就会画读条）；想中途看一眼可约 ${bgSuggestWatchSec(r.task!.task_id)} 秒后回访。` }],
          details: { ok: true, taskId: r.task!.task_id, kind: 'command' },
        }
      },
    } as any,
    {
      name: 'bg_list',
      label: '后台任务列表',
      description: '列出后台任务（含状态、进度、结果摘要）。**开始新一轮或用户问"那个下载好了吗"时先看这个**，不用等通知。',
      parameters: bgEmptyParams,
      async execute() {
        return { content: [{ type: 'text', text: bgSummaryForModel(12) }], details: { ok: true } }
      },
    } as any,
    {
      name: 'bg_read',
      label: '读后台输出',
      description: '读某个后台任务的末尾输出（stdout/stderr 混在一起，失败行以 [err] 开头）。',
      parameters: bgIdParams,
      async execute(_callId, params) {
        const r = bgReadOutput(String((params as any).task_id || ''), Number((params as any).lines) || 60)
        if (!r.ok) return { content: [{ type: 'text', text: `【读取失败】${r.error}` }], details: { ok: false } }
        return { content: [{ type: 'text', text: `任务状态：${r.status}\n${r.text || '（暂无输出）'}` }], details: { ok: true, status: r.status } }
      },
    } as any,
    {
      name: 'bg_stop',
      label: '停止后台任务',
      description: '停掉一个还在跑的后台任务（会连子进程一起杀）。',
      parameters: bgIdParams,
      async execute(_callId, params) {
        const r = bgStop(String((params as any).task_id || ''))
        return { content: [{ type: 'text', text: r.ok ? '已停止该后台任务。' : `【停止失败】${r.error}` }], details: { ok: r.ok } }
      },
    } as any,
    {
      name: 'bg_note',
      label: '报后台进度',
      description:
        '给正在跑的后台任务**补一条进度**（一行说明 / 百分比 0~100），面板会把它显示成读条或灰字。' +
        '命令类任务尤其用得上：长构建、批量处理、多阶段脚本，你每推进一步就报一次（如 percent=3/8 步的 37、note="编译 nis-ui"）。' +
        '没有可靠百分比的（如"预计跑 8 分钟"的脚本），就只给 note + est_sec（面板画「预计」时间条，不编假百分比）。' +
        '⚠️ 下载类自带进度，不用你报；**不知道总量就别编百分比**（宁可只给 note）；任务结束后不用再报。',
      parameters: bgNoteParams,
      async execute(_callId, params) {
        const id = String((params as any).task_id || '').trim()
        const note = (params as any).note == null ? undefined : String((params as any).note)
        const raw = (params as any).percent
        const pct = raw == null || raw === '' ? undefined : Number(raw)
        const rawEst = (params as any).est_sec
        const est = rawEst == null || rawEst === '' ? undefined : Number(rawEst)
        const r = bgNote(id, note, pct, est)
        if (!r.ok) return { content: [{ type: 'text', text: `【报进度失败】${r.error}` }], details: { ok: false } }
        return { content: [{ type: 'text', text: `已记下该任务的进度${pct != null ? `（${Math.round(pct)}%）` : ''}${note ? `：${note}` : ''}${est != null && est > 0 ? `（预计总时长 ${Math.round(est / 60)} 分）` : ''}` }], details: { ok: true } }
      },
    } as any,
    {
      name: 'bg_watch',
      label: '约个回访',
      description:
        '约定「过一会儿回来看看后台任务」：到点后端会把任务当前状态（状态/进度/输出尾部）推回给你，你据此汇报或调整策略。' +
        '适合长任务中途检查（例：挂完下载后约 30 秒回看进度，太慢就换源重挂）。' +
        '⚠️ task_id 不填 = 回看该会话全部在跑的任务。' +
        '**回访看到失败时**：能自愈的（网络抖动、源太慢、临时占用）就自己重试**一次**并说明；' +
        '需要用户拍板的（凭据/路径/是否覆盖/预期不符）、或同一任务已失败两次 → **停下来用 ask_user 问用户**，不要默默无限重试。' +
        '**别拿它当轮询**：① 任务结束会自动通知你，不需要回访等结果；② 到点时若任务已结束且结果已通知，这次回访会被直接丢弃；' +
        '③ 同一任务最多回访 5 次。建议时间看 bg_start 回执里的"建议 N 秒"，或让 after_sec 跟进度匹配（长任务别 30 秒一看）。' +
        '④ **只给真需要中途看一眼的任务约回访**：结果不确定/耗时长/可能卡住才值得；例行小事、几分钟内跑完的、结束会自动通知的——**别约**' +
        '（回访到点还会有 LLM 裁决把关，一切正常就不会打扰）。',
      parameters: bgWatchParams,
      async execute(_callId, params) {
        const taskId = String((params as any).task_id || '').trim()
        const afterSec = Number((params as any).after_sec) || 30
        const note = String((params as any).note || '').trim()
        const r = bgWatch(convId, taskId, afterSec, note)
        if (!r.ok) return { content: [{ type: 'text', text: `【约回访失败】${r.error}` }], details: { ok: false } }
        const when = new Date(r.watch!.dueAt).toLocaleTimeString('zh-CN', { hour12: false })
        const sug = bgSuggestWatchSec(taskId || undefined)
        const drift = Math.abs(sug - r.watch!.afterSec) >= Math.max(15, r.watch!.afterSec * 0.4)
          ? `\n· 提示：按当前进度/同类历史，更合适的间隔约 ${sug} 秒（你约的和建议值差得有点多）`
          : ''
        return {
          content: [{
            type: 'text',
            text: `已约好回访：${r.watch!.afterSec} 秒后（约 ${when}）我把${taskId ? `任务 ${taskId} ` : '这个会话在跑的任务'}的现状推回给你${note ? `\n· 你的备忘：${note}` : ''}${drift}\n（到点若你正在跑就插话进来；若已空闲就自动把你叫起来。任务结束了就没必要再约——完成通知会自己来。）`,
          }],
          details: { ok: true, watchId: r.watch!.id },
        }
      },
    } as any,

  ]
  // ★ 0929 刀③：精炼描述（纪律一条不丢，只删套话/重复/长例）——测量背书：原"全文内联"1681 token→约 800
  return [buildFamilyTool({
    name: 'bg',
    label: '后台任务',
    group: '后台任务',
    variant: 'bash',
    tab: 'system',
    risky: true,   // 家族里 start 是高危（审批门禁按 action 分流：仅 start 弹卡）
    fullMemberDescriptions: false,
    description: '后台任务工具箱（六动作）：把耗时动作挂后台，立刻返回不阻塞对话。'
      + '· start：装依赖/下载大文件/几分钟以上的构建·测试·脚本才挂（几秒就完的直接 run_command）；command 或 url+dest 二选一——'
      + '★ 尽量填 intent：一句话说清这步业务目的（中文 10~20 字，如「后台装依赖」「下载模型权重」），别写「执行命令」这种废话；不确定就不填。'
      + 'url 下载有进度条、用户可暂停继续；POST/多文件/CLI 的下载走 command 模式（只有计时没有百分比，要主动告知用户）。'
      + 'est_sec 只在对时长有把握时给；服务/监听等守护型任务不要给（没有结束时间，给了就是假倒计时）。'
      + '· list：列任务（状态/进度/结果摘要）。· read：读输出尾部（失败行以 [err] 开头）。· stop：停止（连子进程一起杀）。'
      + '· note：给任务报进度（note/percent/est_sec）——不知道总量就别编百分比（宁可只给 note）；下载类自带进度不用报。'
      + '· watch：约 N 秒后回访（5~1800）——别拿它当轮询：结束会自动通知、到点若已结束这次回访会被丢弃、同一任务最多 5 次回访。'
      + '失败处理：能自愈（网络抖动/换源/临时占用）就自己重试一次并说明；需要用户拍板或已失败两次 → 停下来用 ask_user 问用户，别默默无限重试。',
    members: [
      { action: 'start', tool: subs[0], required: ['title'], summary: '挂后台执行（command 或 url+dest 下载，二选一）' },
      { action: 'list', tool: subs[1], summary: '列后台任务（状态/进度/结果摘要）' },
      { action: 'read', tool: subs[2], required: ['task_id'], summary: '读任务输出尾部（失败行 [err] 开头）' },
      { action: 'stop', tool: subs[3], required: ['task_id'], summary: '停止任务（连子进程一起杀）' },
      { action: 'note', tool: subs[4], required: ['task_id'], summary: '给任务报进度（note/percent/est_sec）' },
      { action: 'watch', tool: subs[5], required: ['after_sec'], summary: '约 N 秒后回访任务现状' },
    ],
  })]
}

/* ★1128【工具执行模式】实现搬到 toolExecMode.ts（纯逻辑、可单独测试）：
   · 分级名单（哪些工具必须 sequential）
   · 按会话的并行闸门（只读工具并行但有上限）
   本文件 import 一次（自用）+ re-export（外部照旧从 tools.ts 拿）。 */
import { applyExecutionModes } from './toolExecMode.ts'
export { applyExecutionModes, createToolGate, SEQUENTIAL_TOOL_NAMES } from './toolExecMode.ts'

export function buildSessionTools(cwd: string, actor: string = DEFAULT_ACTOR, sessionId?: string, lockCtx?: FileLockCtx, grepOpts?: GrepOpts): AgentTool<any>[] {
  const list: AgentTool<any>[] = [buildReadTool(cwd), buildGrepTool(cwd, grepOpts), buildWriteTool(cwd, actor, sessionId, lockCtx), buildEditTool(cwd, actor, sessionId, lockCtx), buildCmdTool(cwd, actor, sessionId), ...buildBgTools(cwd, sessionId)]
  return applyExecutionModes(list)
}

/* ★ 0929 刀②：低频能力包按需加载器（喊一声才加载）—— 工具始终挂载（能力不减），
 * 说明书按需发（省每跳固定开销）；加载在【下一次请求】的工具表里生效，同轮后续调用即可用。 */
export function buildLoadToolsTool(opts: { markLoaded: (family: string) => void; getTools: () => any[] }): AgentTool<any> {
  const famList = Object.entries(LAZY_FAMILIES).map(([k, v]) => `${k}=${v.label}（${v.hint}）`).join('；')
  return {
    name: 'load_tools',
    label: '加载能力包',
    description: '低频能力包的按需加载器：这些包的工具**一直挂着可用**，但说明书不常驻（省上下文）；'
      + '要用某个包的工具时，先调本工具把它的说明书展开，然后直接照着调用。'
      + '什么时候调：需要用浏览器/安装技能等能力包时（系统提示的能力包目录里列了有哪些）。'
      + '加载一次后本会话一直有效，不用重复加载。高频核心工具（文件/命令/记忆/计划）是常驻的，不需要也不应该走这里。',
    parameters: Type.Object({
      family: Type.String({ description: '要加载的能力包：' + famList }),
    }),
    async execute(_callId, params: any) {
      const family = String(params?.family || '').trim()
      if (!LAZY_FAMILIES[family]) {
        return {
          content: [{ type: 'text', text: `【错误】没有「${family}」这个能力包。可用：${Object.keys(LAZY_FAMILIES).join(' / ')}` }],
          details: { ok: false },
        }
      }
      opts.markLoaded(family)
      return {
        content: [{ type: 'text', text: familyToolDocs(family, opts.getTools()) + '\n（已记住：本会话无需再 load）' }],
        details: { ok: true, family },
      }
    },
  }
}

/* ══════ ★ 0929 批次A：三个新工具（便宜三件套）══════ */

/* list_dir：列目录（瞬时）——补"没有列目录工具、只能 run_command dir 兜底"的缺口 */
export function buildListDirTool(cwd: string): AgentTool<any> {
  return {
    name: 'list_dir',
    label: '列目录',
    description: '列出目录内容（文件/子目录 + 大小），毫秒级返回。找文件/看结构用它，别再 run_command dir。'
      + 'path 不填=会话工作区根；要看更深层就带 depth（默认 1 层，最多 3）。工作区外的「允许根」（文档/桌面/下载/NiusDream 工程目录等）也能列。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '目录路径（相对工作区或绝对路径；不填=工作区根；允许根内的工作区外目录也可）' })),
      depth: Type.Optional(Type.Number({ description: '递归层数（默认 1，最多 3；大目录别贪深）' })),
    }),
    async execute(_callId, params: any) {
      const rel = String(params?.path || '').trim()
      const depth = Math.min(3, Math.max(1, Number(params?.depth) || 1))
      const base = path.resolve(cwd)
      const abs = path.resolve(base, rel || '.')
      /* ★1016 s1：原来是硬限会话工作区（实测：工作区外的目录列不出来）。现在放开到「允许根」
         （会话工作区 + settings.json 的 allowedReadRoots，默认含 文档/桌面/下载/NiusDream 工程根/数据根）；
         越界时把可用根列出来，不再说含糊的"超出会话工作区"。写工具（fs_write/fs_edit）不在此列。 */
      if (!isReadablePath(abs, base)) throw new Error(readRootsDenyMessage(rel || abs, base))
      if (!fs.existsSync(abs)) throw new Error(`目录不存在：${rel || '.'}`)
      const lines: string[] = []
      const walk = (dir: string, prefix: string, d: number) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
          .slice(0, 200)
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') { lines.push(`${prefix}${e.name}/（略）`); continue }
          if (e.isDirectory()) {
            lines.push(`${prefix}${e.name}/`)
            if (d < depth) walk(path.join(dir, e.name), `${prefix}  `, d + 1)
          } else {
            let size = 0
            try { size = fs.statSync(path.join(dir, e.name)).size } catch { /* 拿不到大小就略过 */ }
            lines.push(`${prefix}${e.name}（${size > 1024 ? Math.round(size / 1024) + 'KB' : size + 'B'}）`)
          }
        }
      }
      walk(abs, '', 1)
      return {
        content: [{ type: 'text', text: `${rel || '.'}/（${lines.length} 项）\n${lines.join('\n')}` }],
        details: { count: lines.length, path: rel || '.' },
      }
    },
  }
}

/** ★1118：读「某条定时任务最近一次执行产出」的注入口。
 *
 *  为什么由 server 注入而不是 tools 里直接读：产出是**执行会话里的 assistant 文本**，
 *  而会话表（sessions）是 server.ts 的模块级状态。tools 层不越界去摸它，依赖由上往里传
 *  （与 setTaskRunner / setTaskSessionResolver 同一个思路，但不走全局单例）。
 *
 *  用途：**值守任务看执行层的产出** —— 执行层（定时任务）在自己会话里正常跑，
 *  决策层（值守任务）到点读它的产出，再按值守规则决定「修 / 报 / 问」。 */
export type ScheduleResultReader = (taskId: string, chars: number) => {
  ok: boolean
  sessionId?: string
  text?: string
  error?: string
  runAt?: number
  status?: string
}

/** schedule：定时任务（create/list/update/remove/run_now）—— scheduledTasks.ts 能力已有，0929 开工具口
 *
 *  ★1118：补 `target` / `watch` 两个口 —— 底层 `createTask`/`updateTask` 早就支持
 *  `targetSessionId` / `watch`（scheduledTasks.ts），但工具层从来没接出来，结果
 *  「AI 给自己在某个对话开值守」只能绕过工具去调 HTTP RPC，还得自己摸后端端口、猜会话 id。
 *  这是**接口断裂**（不是缺功能），根源在工具层：参数没暴露 = 模型不知道有这个能力。
 */
export function buildScheduleTools(convId: string, readResult?: ScheduleResultReader): AgentTool<any>[] {
  /** target 解析：'this'=当前对话 / 'own'=任务专属会话（默认）/ 其它按 sessionId 原样。
   *  不做兜底：`'this'` 却拿不到 convId 属于调用环境错误（工具构建时没传），直接报错暴露。 */
  const resolveTarget = (v: any): string => {
    const s = String(v ?? '').trim()
    if (!s || s === 'own') return 'own'
    if (s === 'this') {
      if (!convId) throw new Error("target='this' 但拿不到当前会话 id（buildScheduleTools 没收到 convId）")
      return convId
    }
    return s
  }
  const subs: any[] = [
    {
      name: 'schedule_create', label: '新建定时任务',
      description: '建一条定时任务：到点自动把 prompt 发给 AI 执行（在任务专属会话里，可配结果通知）。用户说"每天X点提醒我/每周跑一次XX"时用。',
      parameters: Type.Object({
        name: Type.String({ description: '任务名（短，如「每天早报」「每周依赖检查」）' }),
        prompt: Type.String({ description: '到点发给 AI 的内容（提醒类就写提醒语；活类写清要干什么）' }),
        kind: Type.String({ description: 'once=单次 / hourly=每小时 / daily=每天 / weekly=每周 / monthly=每月' }),
        at: Type.Optional(Type.String({ description: '（once 必填）ISO 时间，如 2026-09-30T09:00' })),
        time: Type.Optional(Type.String({ description: '（daily/weekly/monthly 用）HH:mm，如 09:00' })),
        weekdays: Type.Optional(Type.Array(Type.Number(), { description: '（weekly 用）周几（0=周日…6=周六），如 [1,3,5]' })),
        dayOfMonth: Type.Optional(Type.Number({ description: '（monthly 用）几号（1-28）' })),
        interval: Type.Optional(Type.Number({ description: '每 N 个周期（默认 1；hourly 最小粒度=小时，别建更高频）' })),
        target: Type.Optional(Type.String({ description: "'this'=绑到当前对话（开值守用）/ 'own'=任务专属会话（默认）/ 具体会话 id" })),
        watch: Type.Optional(Type.Boolean({ description: 'true=值守任务（结果落进绑定的对话、只在输入框旁「值守」弹窗管理，不进定时任务列表）' })),
      }),
      async execute(_c: string, params: any) {
        const kind = String(params?.kind || '')
        if (!['once', 'hourly', 'daily', 'weekly', 'monthly'].includes(kind)) throw new Error(`kind 不认识：${kind}（once/hourly/daily/weekly/monthly）`)
        if (kind === 'once' && !params?.at) throw new Error('kind=once 必须给 at（ISO 时间）')
        const t = createTask({
          name: params.name, prompt: params.prompt,
          schedule: { kind, at: params.at, time: params.time, weekdays: params.weekdays, dayOfMonth: params.dayOfMonth, interval: params.interval },
          targetSessionId: resolveTarget(params?.target),
          watch: params?.watch === true,
          /* ★1118：不再默认塞 {channel:'list'} —— 「列表通知」这个通知目标已按 ★1119k 定案废掉
             （任务永不进对话列表，task.notifyTargets 也不再 enumerate 出它），旧默认值只会给每条
             新任务留一条无效配置（巡检任务就是这么带上它的）。真实推送目标现在由用户在任务详情页选。 */
          notifyTargets: [],
        })
        return {
          content: [{ type: 'text', text: `已创建定时任务「${t.name}」（${describeSchedule(t.schedule)}）· id=${t.id} · 下次：${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '（无）'}` }],
          details: { ok: true, id: t.id },
        }
      },
    },
    {
      name: 'schedule_list', label: '定时任务列表',
      description: '列出全部定时任务（周期/下次时间/最近状态）。',
      parameters: Type.Object({}),
      async execute() {
        const rows = listTasks()
        if (!rows.length) return { content: [{ type: 'text', text: '（还没有定时任务）' }], details: { count: 0 } }
        const lines = rows.map(t => `${t.id}「${t.name}」${describeSchedule(t.schedule)}｜下次 ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—'}｜${t.enabled ? '启用' : '停用'}｜已跑 ${t.runCount} 次${t.lastStatus ? '｜最近 ' + t.lastStatus : ''}`)
        return { content: [{ type: 'text', text: `定时任务（${rows.length} 条）：\n${lines.join('\n')}` }], details: { count: rows.length } }
      },
    },
    {
      name: 'schedule_update', label: '改定时任务',
      description: '改定时任务（停用/启用、换时间、改内容、绑/解绑对话、开关值守）。先 list 拿 id；改动哪个字段给哪个。'
        + '把已有任务变成本对话的值守任务：target="this" + watch=true。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id（schedule_list 返回）' }),
        name: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean({ description: 'true=启用 / false=暂停' })),
        time: Type.Optional(Type.String({ description: '新的 HH:mm' })),
        kind: Type.Optional(Type.String({ description: '新的周期类型' })),
        at: Type.Optional(Type.String({ description: '（once）ISO 时间' })),
        target: Type.Optional(Type.String({ description: "'this'=绑到当前对话（开值守用）/ 'own'=任务专属会话 / 具体会话 id" })),
        watch: Type.Optional(Type.Boolean({ description: 'true=值守任务 / false=转回普通定时任务' })),
      }),
      async execute(_c: string, params: any) {
        const patch: any = {}
        if (params?.name !== undefined) patch.name = params.name
        if (params?.prompt !== undefined) patch.prompt = params.prompt
        if (params?.enabled !== undefined) patch.enabled = !!params.enabled
        if (params?.kind || params?.time || params?.at) patch.schedule = { kind: params.kind, time: params.time, at: params.at }
        if (params?.target !== undefined) patch.targetSessionId = resolveTarget(params.target)
        if (params?.watch !== undefined) patch.watch = !!params.watch
        const t = updateTask(String(params?.id || ''), patch)
        if (!t) throw new Error(`没有这个任务：${params?.id}（用 schedule_list 查）`)
        const where = t.watch ? `值守（结果落 ${String(t.targetSessionId || '').slice(0, 8)}）` : `投递 ${String(t.targetSessionId || 'own') === 'own' ? '任务专属会话' : String(t.targetSessionId).slice(0, 8)}`
        return { content: [{ type: 'text', text: `已更新「${t.name}」：${describeSchedule(t.schedule)}｜${t.enabled ? '启用' : '停用'}｜${where}` }], details: { ok: true, id: t.id } }
      },
    },
    {
      name: 'schedule_remove', label: '删定时任务',
      description: '删除定时任务（彻底）。只是想暂停用 update 把 enabled 置 false。',
      parameters: Type.Object({ id: Type.String({ description: '任务 id' }) }),
      async execute(_c: string, params: any) {
        const ok = removeTask(String(params?.id || ''))
        if (!ok) throw new Error(`没有这个任务：${params?.id}`)
        return { content: [{ type: 'text', text: `已删除任务 ${params.id}` }], details: { ok: true, id: params.id } }
      },
    },
    {
      name: 'schedule_run_now', label: '立即跑一次',
      description: '不等到点、立刻执行一次该任务（调试/补跑用）。',
      parameters: Type.Object({ id: Type.String({ description: '任务 id' }) }),
      async execute(_c: string, params: any) {
        const r = await runTaskNow(String(params?.id || ''))
        if (!r.ok) throw new Error(r.error || '执行失败')
        return { content: [{ type: 'text', text: `已触发执行 ${params.id}${r.sessionId ? `（会话 ${r.sessionId.slice(0, 8)}）` : ''}` }], details: { ok: true, id: params.id } }
      },
    },
    {
      name: 'schedule_result', label: '读任务产出',
      description: '读某条定时任务**最近一次执行**的产出（执行会话里最后一段 AI 文本全文）。'
        + '值守任务的标准动作：先读执行层今天干了什么，再按值守规则决策/动手。'
        + '返回值带 runAt（执行时间）——先核对是不是今天的，昨天的不算今日产出。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id（schedule_list 返回）' }),
        chars: Type.Optional(Type.Number({ description: '最多返回多少字符（默认 4000，上限 20000）' })),
      }),
      async execute(_c: string, params: any) {
        if (!readResult) throw new Error('当前会话没有注入「任务产出读取」能力（buildScheduleTools 没收到 readResult）')
        const id = String(params?.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const chars = Math.min(20000, Math.max(200, Number(params?.chars) || 4000))
        const r = readResult(id, chars)
        if (!r?.ok) throw new Error(r?.error || '读取失败')
        const when = r.runAt ? new Date(r.runAt).toLocaleString('zh-CN', { hour12: false }) : '—'
        return {
          content: [{ type: 'text', text: `「${id}」最近一次执行：${when}｜状态 ${r.status || '—'}｜会话 ${String(r.sessionId || '').slice(0, 8)}\n\n${r.text || '（无文本产出）'}` }],
          details: { ok: true, id, sessionId: r.sessionId, runAt: r.runAt },
        }
      },
    },
  ]
  return [buildFamilyTool({
    name: 'schedule',
    label: '定时任务',
    group: '定时任务',
    variant: 'others',
    tab: 'system',
    risky: true,
    fullMemberDescriptions: false,
    description: '定时任务工具箱（六动作）：到点自动把 prompt 发给 AI 执行（提醒/周期活）。'
      + '· create：新建（kind=once/hourly/daily/weekly/monthly）。'
      + '· list：看全部任务。· update：改/停用/启用/绑对话/开关值守（先 list 拿 id）。'
      + '· remove：删（只想暂停就 update enabled=false）。· run_now：立刻跑一次（调试/补跑）。'
      + '· result：读某任务**最近一次执行的产出全文**（含 runAt，先核对是不是今天的）。'
      + '落点：默认 target="own"=任务专属会话（自己单独跑、自己产出，不进主列表）；'
      + '要结果落在用户当前这个对话就传 target="this"，再加 watch=true 即建成**值守任务**'
      + '（只在输入框旁「值守」弹窗里管理，输入框图标变绿）。'
      + '★两层别混：执行任务（target="own"）自己跑自己产出；值守任务（watch=true + target="this"）到点用 result 读执行层的产出，再按值守规则决策。'
      + '纪律：频率最小粒度=小时，别建分钟级；改删先 list 查 id；用户只要提醒就建 once/daily，别整复杂。',
    members: [
      { action: 'create', tool: subs[0], required: ['name', 'prompt', 'kind'], summary: '建定时任务（提醒/周期活/值守）' },
      { action: 'list', tool: subs[1], summary: '列任务（周期/下次/状态）' },
      { action: 'update', tool: subs[2], required: ['id'], summary: '改/停用/启用/绑对话/开关值守' },
      { action: 'remove', tool: subs[3], required: ['id'], summary: '删除任务' },
      { action: 'run_now', tool: subs[4], required: ['id'], summary: '立刻执行一次' },
      { action: 'result', tool: subs[5], required: ['id'], summary: '读任务最近产出（值守用）' },
    ],
  })]
}

/* ══════ ★ 0929 批次B：git 族（status/diff/log/commit）——核心：大 diff 自动裁剪成摘要 ══════ */
function gitRun(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    /* ★0930 修弹窗：后端主进程没有控制台，凡没 windowsHide 的子进程都会弹出可见控制台窗
       （git/python/cmd 弹窗的统一根因）。 */
    /* ★0930b：git 走绝对路径解析——后端 PATH 没有 Git\cmd，裸名恒 ENOENT（"设置里装了却说没装"） */
    execFile(gitExe(), args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err && (err as any).code === 'ENOENT') return reject(new Error('本机没有安装 git（或不在 PATH）—— 装一个 git（如 winget install Git.Git）后重试；版本管理工具链没 git 跑不了'))
      if (err) reject(new Error(`git ${args[0]} 失败：${String(stderr || err.message).slice(0, 300)}`))
      else resolve(String(stdout))
    })
  })
}

/* ══════ ★ 0929 批次C：repo 族（仓库地图 + 符号/概念级代码搜索）══════ */
export function buildRepoTools(cwd: string): AgentTool<any>[] {
  const subs: any[] = [
    {
      name: 'repo_map', label: '仓库地图',
      description: '仓库结构概览：目录树（深度 2）+ 文件数/大小 + 语言分布。进大仓库先看地图，比逐个翻目录快。',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: repoMap(cwd) }], details: { ok: true } }
      },
    },
    {
      name: 'repo_search', label: '代码语义搜索',
      description: '按**符号/概念**找代码位置（"用户校验在哪个文件""调度器的实现"这类问题）——比 fs_grep 撞字面聪明：'
        + '符号名/路径词加权打分，返回 文件:定义行 + 上下文。没有索引会自动建（首次稍慢）。找具体文本内容请用 fs_grep。',
      parameters: Type.Object({
        query: Type.String({ description: '符号名或概念词（如 loadSessions、定时任务、用户校验）' }),
        limit: Type.Optional(Type.Number({ description: '最多返回多少个文件（默认 15）' })),
      }),
      async execute(_c: string, params: any) {
        let idx = loadIndex(cwd)
        if (!idx) idx = buildIndex(cwd)
        const theIdx = idx
        const q = String(params?.query || '').trim()
        if (!q) throw new Error('query 不能为空')
        const rows = searchIndex(idx, cwd, q, Math.min(50, Number(params?.limit) || 15))
        /* ★1010：索引新鲜度校验 —— 命中的文件若有比索引更新的（内容改过），必须明说"可能陈旧"。
           此前索引一旦落盘就被无条件信任（本工作区那份索引实测是 10 天前建的），搜出来是旧代码却无人知。 */
        const stale = rows.filter(r => { try { return fs.statSync(path.join(cwd, r.rel)).mtimeMs > theIdx.builtAt } catch { return false } })
        const ageMs = Date.now() - theIdx.builtAt
        const age = ageMs < 3600000 ? `${Math.max(1, Math.round(ageMs / 60000))} 分钟` : ageMs < 48 * 3600000 ? `${(ageMs / 3600000).toFixed(1)} 小时` : `${Math.round(ageMs / 86400000)} 天`
        /* ★1010c：警告改成**前置**（原先跟在结果末尾，容易被"扫一眼就走"的读法忽略） */
        const warn = stale.length
          ? `⚠ 索引可能陈旧（建于 ${age}前）：${stale.slice(0, 3).map(r => r.rel).join('、')}${stale.length > 3 ? ` 等 ${stale.length} 个文件` : ''} 在索引之后改过 —— 要最新结果请调 repo(action="build") 重建。\n`
          : ''
        if (!rows.length) return { content: [{ type: 'text', text: `${warn}（没找到与「${q}」相关的符号/概念；换个说法或用 fs_grep 撞字面。索引建于 ${age}前｜${Object.keys(theIdx.files).length} 个文件）` }], details: { count: 0 } }
        const lines = rows.map(r => `▸ ${r.rel}${r.line ? `:${r.line}` : ''}（${r.score.toFixed(1)}分｜${r.hits.join('、')}）${r.context ? `\n    ${r.context.split('\n')[0].trim().slice(0, 120)}` : ''}`)
        return { content: [{ type: 'text', text: `${warn}「${q}」相关位置（${rows.length} 处）：\n${lines.join('\n')}\n（索引建于 ${age}前｜${Object.keys(theIdx.files).length} 个文件）` }], details: { count: rows.length, indexed: Object.keys(theIdx.files).length, stale: stale.length } }
      },
    },
    {
      name: 'repo_build', label: '重建代码索引',
      description: '建/刷新代码索引（repo_search 的数据源）。大仓库改动很多后手动刷一次；平时 search 会自动建/沿用。',
      parameters: Type.Object({}),
      async execute() {
        const idx = buildIndex(cwd)
        return { content: [{ type: 'text', text: `索引已重建：${Object.keys(idx.files).length} 个文件${idx.truncated ? '（触到预算上限，已截断）' : ''}` }], details: { ok: true, files: Object.keys(idx.files).length } }
      },
    },
  ]
  return [buildFamilyTool({
    name: 'repo',
    label: '仓库地图',
    group: '文件',
    variant: 'search',
    tab: 'system',
    fullMemberDescriptions: false,
    description: '仓库导航工具箱（三动作）：进陌生/大型代码库先用它建立全局观。'
      + '· map：结构概览（目录树+规模+语言分布）。· search：按符号/概念找代码位置（打分排序，带定义行上下文；索引自动建，首次稍慢）。'
      + '· build：重建索引（大改动后手动刷）。定位：repo 找"东西在哪"，fs_grep 找"文本在哪"，两者互补不重复。',
    members: [
      { action: 'map', tool: subs[0], summary: '仓库结构概览（目录树/规模/语言）' },
      { action: 'search', tool: subs[1], required: ['query'], summary: '按符号/概念找代码位置' },
      { action: 'build', tool: subs[2], summary: '重建代码索引' },
    ],
  })]
}

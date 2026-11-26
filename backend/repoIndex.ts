/* repoIndex.ts —— 批次C：仓库地图 + 代码语义级搜索的索引核心（0929）
 * 定位：fs_grep 是"按字面找文本"，repo_search 是"按符号/概念找位置"（哪个文件定义了什么、
 *      某功能大概在哪）——介于 grep 与真语义向量之间：**符号 + 词元打分**，零依赖零模型。
 * 索引：.nis-repo-index.json（落工作区，幂等重建；预算护栏同 project_fs_grep 口径）。
 *
 * ★1126 结构性重做「索引新鲜度」——旧实现的病根（老板实测：repo 几乎没人用）：
 *   ① `loadIndex` 只校验 version + workDir，**不校验内容是否过期** ⇒ 索引一旦落盘就被永久信任
 *      （实测本工作区那份是 58 天前建的、D:\nis0924 那份是 48 天前且 truncated），搜出来是旧代码；
 *   ② 旧版只在 search **命中结果**里比对文件 mtime，只警告不重建 ⇒ 改过的文件没被搜到就完全无感；
 *   ③ 取"用不用旧索引"的判断必须来自**源数据的真实变化**，不是"时间到了"（TTL 是拍脑袋，24 小时内改 500 次照样用旧的）。
 *   现在的判据（两档，都是源驱动、成本 O(1)~O(目录数)）：
 *     · git 仓库 → 存 `HEAD sha + 未提交改动指纹`；任一变化即重建（精确，毫秒级）；
 *     · 非 git 目录 → 存**每个目录的 mtime 快照**（文件增删必改所在目录 mtime；目录数比文件数少一个数量级）。
 *   另：`truncated`（预算不够没扫全）必须在结果里显式告知模型 —— 否则"搜不到"会被误读成"不存在"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { gitExe } from './gitExe.ts'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.nis-history', 'target', '__pycache__', '.venv', 'venv', 'coverage', '.next', '.cache', 'toolchain', '.turbo', '.parcel-cache',
  /* ★1126：**运行时数据目录**也不能进代码索引。实测 D:\nis0924 被 backend/data 下的会话存档吃掉预算
     （单个 transcript.json 75.7MB），扫到 3,125 个文件就撞 256MB 上限 ⇒ truncated，真源码反而没索引全。
     这里只放"名字本身就说明是运行时产物"的目录；`data` 本身不跳过（不少项目 src/data 是源码）。 */
  'sessions', 'sessions.trash', 'backups', 'logs', 'exports', 'uploads', 'memory', 'media', 'gallery'])
/** 单文件超过这个大小：只登记 rel/size 不解析内容，且**不计入字节预算**（否则一个 75MB 的会话存档就吃掉 30% 预算） */
const BIG_FILE_BYTES = 2 * 1024 * 1024
/* ★1126 分层预算（老板拍板 B 方案）：**代码与文档分开算**。
   实测 D:\nis0924 有 6,727 个候选文件（含大量 md/json），文档把 256MB 预算吃完 ⇒ 真源码被挤到 truncated 之外。
   文档对"找代码位置"的边际价值低（找 md 内容用 fs_grep 更准），所以给它一份独立的小预算：
   超出就只记路径词、不读内容 —— 代码那边就能扫全。 */
const MAX_DOC_FILES = 4000
const MAX_DOC_BYTES = 32 * 1024 * 1024
/* ★1010c：构建产物/缓存目录**常有别名**（dist2、dist-probe-1012、.vite-mcptest）—— 精确匹配漏掉它们，
   实测 NiusDream 仓库被 toolchain/codex(2127 文件)、frontend/.vite*(738)、dist2/dist-probe-1012(369) 吃掉预算，
   索引 truncated 而真源码反而没扫全。这里补"前缀式"判断（这些名字本身就是构建/依赖语义）。 */
const skipDirName = (name: string): boolean =>
  SKIP_DIRS.has(name) || /^(dist|build|out)[-._0-9]/i.test(name) || /^\.vite/.test(name) || /^\.turbo/.test(name)
  /* ★1126：打包/交付产物目录（实测 _pack_out、_team_v2_delivery_dist 里的 .ts 会挤进搜索结果前排） */
  || /^_pack/i.test(name) || /_dist$/i.test(name) || /_out$/i.test(name)
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.vue', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.h', '.cpp', '.hpp', '.md', '.json', '.yml', '.yaml', '.toml', '.sh', '.ps1'])
/** 文档/数据类扩展名：参与索引但搜索时降权（见 searchIndex 的 ★1126 注释） */
const DOC_EXT = new Set(['.md', '.json', '.yml', '.yaml', '.toml', '.txt', '.csv'])
const MAX_FILES = 20000
const MAX_BYTES = 256 * 1024 * 1024
const MAX_MS = 40000
const INDEX_FILE = '.nis-repo-index.json'

interface RepoFileEntry {
  rel: string
  lines: number
  bytes: number
  symbols: Array<{ name: string; line: number }>
  words: string[]
  /** ★1126：建索引时的文件 mtime —— 非 git 目录靠它抓"改了内容但没增删"（目录 mtime 抓不到这种变化） */
  mtime?: number
}

interface RepoIndex {
  version: number
  builtAt: number
  workDir: string
  files: Record<string, RepoFileEntry>
  truncated: boolean
  /** ★1126：建索引那一刻的「源指纹」——加载时与当前值比对，不一致即判陈旧。 */
  source?: SourceStamp
}

/** 源指纹：决定"索引还能不能信"的唯一依据（源驱动，不再是时间驱动） */
interface SourceStamp {
  /** git 仓库：HEAD sha（非 git 仓库 / 本机没 git ⇒ null） */
  gitHead: string | null
  /** git 仓库：未提交改动（含未跟踪文件）的指纹；内容改动会让它变 ⇒ 不必等 HEAD 前进 */
  gitDirty: string | null
  /** 目录 mtime 快照（rel → mtimeMs）：非 git 目录的主判据，git 仓库也存一份兜底 */
  dirs: Record<string, number>
  /** 根目录下条目名的摘要（不含 `.nis-*`）——抓"往根里直接增删文件"。
   *  为什么不记根目录 mtime：索引文件 `.nis-repo-index.json` 就写在根里，每次写盘都会改根 mtime
   *  ⇒ build 完立刻 load 就判 stale、无限重建（1126 实测踩到）。 */
  rootSig?: string
}

const INDEX_VERSION = 2
/** 目录快照上限：防病态目录树把一次校验拖成几秒（超过就算 truncated 判据，交给上级预算） */
const MAX_STAMP_DIRS = 4000

const IDENT = /[A-Za-z_$][\w$]*/g
const CJK_RUN = /[\u4e00-\u9fa5]{2,}/g
const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|interface|type|enum|struct|impl)\s+([A-Za-z_$][\w$]*)/g

function tokenize(s: string): string[] {
  const out = new Set<string>()
  const str = String(s || '')
  for (const m of str.toLowerCase().matchAll(IDENT)) {
    const w = m[0]
    if (w.length >= 2) out.add(w)
  }
  // 中文：整词 + 二元组（"定时任务"→定时/时任/任务 —— 无分词库的标准打法，召回稳）
  for (const m of str.matchAll(CJK_RUN)) {
    const run = m[0]
    out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/** ★1126：算当前「源指纹」。成本：一次 git rev-parse/status（毫秒~百毫秒）+ 一次目录 mtime 遍历（O(目录数)）。 */
function currentStamp(workDir: string): SourceStamp {
  let gitHead: string | null = null
  let gitDirty: string | null = null
  try {
    const exe = gitExe()
    /* `--porcelain` 带未跟踪文件：只改内容（不提交）也算变了 —— 这才是"源码变了"的真实信号。
       `core.quotepath=false` 免得中文路径被转义成 \xxx 影响指纹稳定性。 */
    const head = spawnSync(exe, ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8', timeout: 3000, windowsHide: true })
    if (head.status === 0) {
      gitHead = String(head.stdout || '').trim() || null
      const st = spawnSync(exe, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=normal'],
        { cwd: workDir, encoding: 'utf8', timeout: 8000, windowsHide: true })
      if (st.status === 0) {
        /* 只留"路径 + 状态位"的摘要。⚠️ 必须滤掉 `.nis-*`（索引文件/锁文件自身）：
           索引写盘后 porcelain 会把它列成未跟踪文件 ⇒ 下一次 load 的 dirty 就与建索引时不等
           ⇒ 每次 load 都判 stale、无限重建（1126 实测踩到，build 完立刻 load 就是 stale）。 */
        const lines = String(st.stdout || '').split('\n').filter(l => {
          if (!l.trim()) return false
          const p = l.slice(3).trim()
          return !!p && !p.startsWith('.nis-') && !p.includes('/.nis-')
        })
        gitDirty = createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16)
      }
    }
  } catch { /* 没 git / 不是仓库 / 超时 ⇒ 退回目录快照判据 */ }

  const dirs: Record<string, number> = {}
  /* 根目录的条目名摘要（**不用 mtime**：索引文件就写在根里，写盘即改根 mtime，会自判 stale）。
     过滤 `.nis-*` 与 git 侧同口径 ⇒ 索引文件自身永远不影响判据。 */
  let rootSig: string | undefined
  try {
    const ents = fs.readdirSync(workDir, { withFileTypes: true })
    rootSig = createHash('sha1')
      .update(ents.map(e => e.name).filter(n => !n.startsWith('.nis-')).sort().join('|'))
      .digest('hex').slice(0, 16)
  } catch { /* ignore */ }
  const stack: string[] = ['']
  while (stack.length && Object.keys(dirs).length < MAX_STAMP_DIRS) {
    const rel = stack.pop()!
    const abs = rel ? path.join(workDir, rel) : workDir
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (skipDirName(e.name) || e.name.startsWith('.nis-')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      try { dirs[r] = fs.statSync(path.join(abs, e.name)).mtimeMs } catch { /* ignore */ }
      stack.push(r)
    }
  }
  return { gitHead, gitDirty, dirs, rootSig }
}

/** 索引是否该重建（**源驱动**，与时间无关）。
 *  · git 仓库：HEAD sha 或"未提交改动指纹"变了 ⇒ 立刻重建（porcelain 连内容改动都抓得到）；
 *  · 任何情况都要再做一档**文件 mtime 兜底**：git 只在"git 视角"下看改动 —— 实测本项目 .gitignore 有
 *    `_*.ts` 规则（探针脚本约定），新建/改这类文件 porcelain 里根本不出现，而 walkFiles 照样把它们收进索引
 *    ⇒ 只信 git 会漏。这一档也覆盖"非 git 目录的纯内容修改"（目录 mtime 只反映增删）。
 *  · 目录 mtime 快照：抓增删/改名（非 git 目录下尤其有效，成本 O(目录数)）。
 *  ⚠️ 判定必须"任一变化即 stale"，不许攒够 N 个才算 —— 1126 初版写成 `changed > 3`，小仓库永远判 fresh（实测踩到）。 */
function stampDiffers(idx: RepoIndex, cur: SourceStamp): boolean {
  const a = idx.source
  if (!a) return true
  if ((a.gitHead || null) !== (cur.gitHead || null)) return true
  if ((a.gitDirty || null) !== (cur.gitDirty || null)) return true
  if ((a.rootSig || null) !== (cur.rootSig || null)) return true
  const ka = Object.keys(a.dirs || {})
  const kb = Object.keys(cur.dirs || {})
  if (ka.length !== kb.length) return true
  for (const k of kb) if ((a.dirs || {})[k] !== cur.dirs[k]) return true
  /* 文件级兜底：任意一个已索引文件的 mtime 变了（或被删）⇒ stale。3125 个文件实测 ~100ms 级。 */
  for (const f of Object.values(idx.files)) {
    let m: number
    try { m = fs.statSync(path.join(idx.workDir, f.rel)).mtimeMs } catch { return true /* 文件没了 ⇒ 变 */ }
    if (f.mtime != null && Math.abs(m - f.mtime) > 1) return true
  }
  return false
}

function walkFiles(root: string, onFile: (abs: string, rel: string, isDoc: boolean) => boolean): { count: number; truncated: boolean } {
  let count = 0
  let bytes = 0
  let docCount = 0
  let docBytes = 0
  let truncated = false
  const t0 = Date.now()
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.nis-')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirName(e.name)) continue
        stack.push(abs)
      } else {
        const ext = path.extname(e.name).toLowerCase()
        if (!CODE_EXT.has(ext)) continue
        let size = 0
        try { size = fs.statSync(abs).size } catch { continue }
        const isDoc = DOC_EXT.has(ext)
        if (isDoc) {
          /* 文档走独立小预算：超了就**不再收**（不置 truncated —— 代码优先，文档少收不影响"找代码位置"） */
          if (docCount >= MAX_DOC_FILES || docBytes >= MAX_DOC_BYTES) continue
          docCount++
          docBytes += size
        } else {
          count++
          /* ★1126：大文件不解析（buildIndex 里只登记）、也**不计字节预算** —— 否则一个 75MB 的会话存档
             就吃掉 256MB 预算的 30%，把真源码挤到 truncated 之外。 */
          if (size <= BIG_FILE_BYTES) bytes += size
          if (count > MAX_FILES || bytes > MAX_BYTES || Date.now() - t0 > MAX_MS) { truncated = true; return { count, truncated } }
        }
        if (!onFile(abs, path.relative(root, abs).replace(/\\/g, '/'), isDoc)) return { count, truncated: true }
      }
    }
  }
  return { count, truncated }
}

/** ★1126：优先用 **git 自己的文件清单**（跟踪的 + 未跟踪但没被 ignore 的）。
    为什么：靠目录名黑名单永远追不上临时目录 —— 实测 D:\nis0924 被 dev-xxx 与 _p44_xxx 这类未跟踪目录撑到 2 万文件、
    19 秒撞预算仍 truncated。项目自己已经用 .gitignore 声明了"哪些是它的文件"，就别去猜。
    非 git 目录 / 没装 git ⇒ null，退回目录遍历（walkFiles）。 */
function gitCandidateFiles(workDir: string): string[] | null {
  try {
    const exe = gitExe()
    const run = (args: string[]) => spawnSync(exe, args, {
      cwd: workDir, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
    })
    const tracked = run(['-c', 'core.quotepath=false', 'ls-files', '-z'])
    if (tracked.status !== 0) return null
    const untracked = run(['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard'])
    const out: string[] = []
    for (const chunk of [tracked.stdout || '', untracked.status === 0 ? (untracked.stdout || '') : '']) {
      for (const rel of String(chunk).split('\0')) if (rel) out.push(rel.replace(/\\/g, '/'))
    }
    return out
  } catch { return null }
}

/** 建/重建索引（幂等）：每个文件 → 符号 + 词元。
 *  ★1126 三条结构：
 *    ① 文件清单优先取 git（跟踪 + 未被忽略的未跟踪），非 git 才遍历目录 —— 黑名单追不上临时目录；
 *    ② 增量：`prev` 里 mtime 没变的文件直接复用条目、不读盘（首次全量 ~20s，之后毫秒级）；
 *    ③ 分层预算：代码吃主预算、文档走独立小预算且**不读内容**（文档对"找代码位置"边际价值低）。 */
export function buildIndex(workDir: string, prev?: RepoIndex): RepoIndex {
  const files: Record<string, RepoFileEntry> = {}
  const t0 = Date.now()
  let reused = 0, count = 0, bytes = 0, docCount = 0, docBytes = 0
  let truncated = false

  const cands: Array<{ rel: string; abs: string }> = []
  const gitList = gitCandidateFiles(workDir)
  if (gitList) for (const rel of gitList) cands.push({ rel, abs: path.join(workDir, rel) })
  else walkFiles(workDir, (abs, rel) => { cands.push({ rel, abs }); return true })

  for (const { rel, abs } of cands) {
    if (truncated) break
    const ext = path.extname(rel).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    let size = 0, mtime: number | undefined
    try { const st = fs.statSync(abs); size = st.size; mtime = st.mtimeMs } catch { continue }
    const isDoc = DOC_EXT.has(ext)
    if (isDoc) {
      if (docCount >= MAX_DOC_FILES || docBytes >= MAX_DOC_BYTES) continue
      docCount++; docBytes += size
    } else {
      count++
      if (size <= BIG_FILE_BYTES) bytes += size
      if (count > MAX_FILES || bytes > MAX_BYTES || Date.now() - t0 > MAX_MS) { truncated = true; break }
    }
    const old = prev?.files?.[rel]
    if (old && old.mtime != null && mtime != null && Math.abs(old.mtime - mtime) <= 1) { files[rel] = old; reused++; continue }
    if (isDoc) { files[rel] = { rel, lines: 0, bytes: 0, symbols: [], words: tokenize(rel).slice(0, 200), mtime }; continue }
    let text = ''
    try {
      if (size > BIG_FILE_BYTES) { files[rel] = { rel, lines: 0, bytes: size, symbols: [], words: [], mtime }; continue }
      text = fs.readFileSync(abs, 'utf8')
    } catch { continue }
    const symbols: Array<{ name: string; line: number }> = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && symbols.length < 200; i++) {
      for (const m of lines[i].matchAll(SYMBOL_RE)) symbols.push({ name: m[1], line: i + 1 })
    }
    files[rel] = {
      rel,
      lines: lines.length,
      bytes: Buffer.byteLength(text),
      symbols,
      // 词元=路径词+符号词+内容词（内容词限量防索引膨胀；中文 bigram 让"定时任务"这类概念词搜得到）
      words: [...new Set([...tokenize(`${rel} ${symbols.map(s => s.name).join(' ')}`), ...tokenize(text.slice(0, 60000))])].slice(0, 1500),
      mtime,
    }
  }

  const idx: RepoIndex = { version: INDEX_VERSION, builtAt: Date.now(), workDir, files, truncated, source: currentStamp(workDir) }
  if (reused) console.log(`[repoIndex] 增量：复用 ${reused} / 重算 ${Object.keys(files).length - reused} 个文件（${Date.now() - t0}ms）`)
  try { fs.writeFileSync(path.join(workDir, INDEX_FILE), JSON.stringify(idx)) } catch { /* 索引写不进就算了，内存照用 */ }
  return idx
}

/** 加载结果：`stale` 由**源指纹**判定（不是时间）。调用方拿到 stale 必须重建，不许拿旧索引直接答。 */
export interface LoadedIndex {
  idx: RepoIndex
  stale: boolean
  /** 校验耗时（ms）——repo_search 会把它带进结果，便于发现"校验很慢"的异常仓库 */
  checkedMs: number
}

export function loadIndex(workDir: string): LoadedIndex | null {
  try {
    const raw = fs.readFileSync(path.join(workDir, INDEX_FILE), 'utf8')
    const idx = JSON.parse(raw) as RepoIndex
    /* ★1003 安全批 4.35：索引来自磁盘（可篡改/陈旧）——workDir 对不上的索引直接不用，
     * 否则别的目录建的索引被静默套用（rel 是相对另一棵树的，叠加越界读风险）。
     ★1126：version 提升到 2 —— 老索引没有 source 指纹，无条件重建一次（而不是继续信它）。 */
    if (!(idx?.version === INDEX_VERSION && idx.files && (!idx.workDir || path.resolve(String(idx.workDir)) === path.resolve(workDir)))) return null
    const t0 = Date.now()
    const stale = stampDiffers(idx, currentStamp(workDir))
    return { idx, stale, checkedMs: Date.now() - t0 }
  } catch { return null }
}

/** 符号/概念级搜索：query 分词 → 符号命中(权重3) + 词元命中(1) + 路径命中(0.5) → top 结果带定义行 */
export function searchIndex(idx: RepoIndex, workDir: string, query: string, limit = 15): Array<{ rel: string; score: number; hits: string[]; line?: number; context?: string }> {
  const qTokens = tokenize(query)
  if (!qTokens.length) return []
  const scored: Array<{ rel: string; score: number; hits: string[]; line?: number }> = []
  for (const f of Object.values(idx.files)) {
    let score = 0
    const hits: string[] = []
    let bestLine: number | undefined
    for (const q of qTokens) {
      for (const s of f.symbols) {
        const n = s.name.toLowerCase()
        if (n === q) { score += 3; hits.push(`符号 ${s.name}`); bestLine = bestLine ?? s.line }
        else if (n.includes(q)) { score += 1.5; if (!hits.includes(`符号 ${s.name}`)) hits.push(`符号 ~${s.name}`); bestLine = bestLine ?? s.line }
      }
      if (f.words.includes(q)) { score += 1; if (!hits.some(h => h.includes(q))) hits.push(`词 ${q}`) }
      if (f.rel.toLowerCase().includes(q)) { score += 0.5; hits.push(`路径含 ${q}`) }
    }
    if (score > 0) {
      /* ★1126：文档降权 —— 实测搜 `team_dispatch` 时，10 月那份盘点 .md 靠字面命中把 server.ts 的
         真实定义挤到后面（结果全是没用文档）⇒ 模型搜一次就弃用。符号/概念搜索里"代码优先"是基本排序约束，
         不是偏好；文档仍可被搜到，只是排在代码后面（×0.55，不清零）。 */
      const ext = path.extname(f.rel).toLowerCase()
      if (DOC_EXT.has(ext)) score *= 0.55
      /* ★1126：根目录的 `_*.mjs/_*.ts` 探针脚本、以及各类 `_xxx` 临时目录 —— 实测搜 team_dispatch 时
         它们会排在真源码前面（它们确实含关键词，但不是"问题点"）。降权而不是排除：临时脚本有时也是好线索。 */
      else if (/^_/.test(f.rel) || /(^|\/)_/.test(f.rel)) score *= 0.6
      scored.push({ rel: f.rel, score, hits: hits.slice(0, 4), line: bestLine })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(r => {
    // 附上下文：命中符号所在行 ±2
    let context = ''
    if (r.line) {
      try {
        /* ★1003 安全批 4.35：r.rel 来自磁盘索引（可被篡改）—— path.join(workDir,'../../x') 直接
         * 逃出工作区 = 被篡改的 .nis-repo-index.json 变成任意文件读（最多整文件）。resolve 后
         * 必须仍在工作区内才读，越界当读不到处理。 */
        const rootAbs = path.resolve(workDir)
        const abs = path.resolve(rootAbs, String(r.rel || ''))
        if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) return { ...r, context: '' }
        const lines = fs.readFileSync(abs, 'utf8').split('\n')
        context = lines.slice(Math.max(0, r.line - 1), Math.max(0, r.line - 1) + 3).join('\n').slice(0, 200)
      } catch { /* 读不到就裸结果 */ }
    }
    return { ...r, context }
  })
}

/** 仓库地图：目录树概览（深度 2）+ 规模/语言分布 */
export function repoMap(workDir: string): string {
  const dirs: Array<{ rel: string; files: number; bytes: number }> = []
  const extCount: Record<string, number> = {}
  let totalFiles = 0
  let totalBytes = 0
  walkFiles(workDir, (abs, rel) => {
    const top = rel.split('/').slice(0, 2).join('/')
    let d = dirs.find(x => x.rel === top)
    if (!d) { d = { rel: top, files: 0, bytes: 0 }; dirs.push(d) }
    let size = 0
    try { size = fs.statSync(abs).size } catch { /* ignore */ }
    d.files++
    d.bytes += size
    totalFiles++
    totalBytes += size
    const ext = path.extname(rel).toLowerCase() || '(无)'
    extCount[ext] = (extCount[ext] || 0) + 1
    return true
  })
  dirs.sort((a, b) => b.bytes - a.bytes)
  const topLangs = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}×${n}`).join('、')
  const topDirs = dirs.slice(0, 25).map(d => `  ${d.rel}/（${d.files} 文件 ${(d.bytes / 1024).toFixed(0)}KB）`).join('\n')
  return `仓库地图（${totalFiles} 个代码文件 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，深度 2 概览）：\n${topDirs}\n语言/类型分布：${topLangs}\n（找具体符号用 repo(action=search)；全文内容用 fs_grep）`
}

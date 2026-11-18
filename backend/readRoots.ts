/**
 * 允许根（★1016 s1）—— 工作区外「只读 / 预览」放开，「写」仍限会话工作区。
 *
 * 病（实测）：只能读工作区以内的东西；产出物落在工作区外（如 <dev仓库>\…「展开卡方案对比.html」），
 * 点预览就报"不在工作区"。
 *
 * 三层拦截点（改前）：
 *   ① AI 工具层 tools.ts  buildListDirTool 里 `路径超出会话工作区`（硬限 cwd，唯一一处带校验的只读工具）；
 *      fs_read / fs_grep **本来就没有任何校验**（能读工作区外，正是"能读"的来源）。
 *   ② 后端 RPC server.ts  resolveWorkdirPath()：越界一律 throw 'path outside workdir'
 *      （readForPreview / fs.readFile / fs.statFile / /api/workspace-file 静态代理 / fs.openInBrowser 全走它）。
 *   ③ 前端 ProducedFilesRow.vue：不预检，直接 bridgeRpc → 拿到 'path outside workdir' 就映射成
 *      i18n `produced.outsideWorkdirHint`（老板看到的那句"不在工作区"就是它）。
 *
 * 口径（本文件落地）：
 *   · **只读类**（fs_read / fs_grep / list_dir / 预览 / 静态文件代理 / 下载）→ 允许在「允许根」内任意路径；
 *   · **写入类**（fs_write / fs_edit / fs_delete / fs.rename / 撤销恢复…）→ **仍然只限会话工作区，未放开**；
 *   · 越界报错把「可用根」原样列出来（不再只说"不在工作区"）。
 *
 * 配置：`<DATA_ROOT>/settings.json` 的 `allowedReadRoots`（字符串数组，绝对路径，支持 `~/` 前缀）。
 *   · 不配 / 配成空数组 → 用下面的默认根（用户常用目录 + NiusDream 工程根 + 数据根）；
 *   · 配了 → **替换**默认根（想加不想换就把默认值一起抄进去）；
 *   · 会话工作区**永远**在列表里（不用手写）；
 *   · 改完 settings.json **不用重启**（每次现读，与 fsReadMaxChars 同款口径）；控制台里改走 settings.update
 *     （该键已在白名单里）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_ROOT, PROJECT_ROOT } from './paths.ts'

/** settings.json 里的配置键（settings.update 白名单里同名） */
export const ALLOWED_ROOTS_KEY = 'allowedReadRoots'

/**
 * ★1117h（老板要求）：**读路径不设限**开关。
 * 原话："不管工作区在哪，AI 只要有确定位置，哪个盘的目录都可以列"。
 * = true 时 `isReadablePath()` 对任意**绝对路径**都放行（不再看允许根白名单）；
 * = false/未配 时沿用「允许根」口径（会话工作区 + allowedReadRoots / 默认根）。
 * ⚠️ 只影响**读**（list_dir / fs_read / fs_grep / 预览 / 下载）；**写**仍然只限会话工作区。
 */
export const READ_ANY_ROOT_KEY = 'readAnyRoot'

/* 每次调用都 statSync 一次太勤（list_dir 会批量走），这里按 mtime 缓存：
   settings.json 一变（不管是设置页还是手改）就重读 —— 保留"改完不用重启"的语义。 */
let _anyRootMtime = 0
let _anyRootVal = false
export function readAnyRootEnabled(): boolean {
  try {
    const st = fs.statSync(SETTINGS_FILE)
    if (st.mtimeMs !== _anyRootMtime) {
      _anyRootMtime = st.mtimeMs
      const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      _anyRootVal = obj?.[READ_ANY_ROOT_KEY] === true
    }
    return _anyRootVal
  } catch {
    return false
  }
}

const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json')

/** 路径比较口径：Windows 大小写不敏感 */
function norm(p: string): string {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** 展开 `~/` 与 `${HOME}`；非绝对路径一律丢弃（相对路径没有"根"的语义） */
function expand(p: string): string {
  let s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') s = os.homedir()
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2))
  s = s.replace(/\$\{HOME\}/gi, os.homedir())
  return path.isAbsolute(s) ? path.normalize(s) : ''
}

/** 默认允许根：用户常用目录 + NiusDream 工程根（self-modify / 查日志 / 交付到仓库都在这）+ NiusDream 数据根 */
export function defaultReadRoots(): string[] {
  const home = os.homedir()
  return [
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    PROJECT_ROOT,
    DATA_ROOT,
  ]
}

/** settings.json 里配的允许根（没配/配空 → []，由调用方回落默认） */
export function configuredReadRoots(): string[] {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
    const obj = JSON.parse(raw)
    const arr = obj?.[ALLOWED_ROOTS_KEY]
    if (!Array.isArray(arr)) return []
    return arr.map((x: any) => expand(String(x))).filter(Boolean)
  } catch { /* 设置读不到/坏了 → 用默认根 */ }
  return []
}

/** 生效的允许根列表（会话工作区永远第一个） */
export function allowedReadRoots(workDir?: string): string[] {
  const configured = configuredReadRoots()
  const base = configured.length ? configured : defaultReadRoots()
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [String(workDir || '').trim(), ...base]) {
    const abs = expand(raw)
    if (!abs) continue
    const key = norm(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** abs 是否在 root 之内（相等也算） */
export function isUnder(root: string, abs: string): boolean {
  const r = norm(root)
  const a = norm(abs)
  const withSep = r.endsWith(path.sep) ? r : r + path.sep
  return a === r || a.startsWith(withSep)
}

/** 只读/预览是否允许访问该绝对路径 */
export function isReadablePath(abs: string, workDir?: string, extraRoots: string[] = []): boolean {
  /* ★1117h：开了「读路径不设限」⇒ 任意**绝对路径**都放行（相对路径已在 expand() 里被丢，到这里的都是绝对）。
     写工具不走这个函数（它们用工作区判据），所以写边界不受影响。 */
  if (readAnyRootEnabled()) return path.isAbsolute(abs)
  const roots = [...allowedReadRoots(workDir), ...extraRoots.map(expand).filter(Boolean)]
  return roots.some((r) => isUnder(r, abs))
}

/** 越界报错文案（明确告知可用根 —— 老板/模型都能看懂下一步该往哪放） */
export function readRootsDenyMessage(input: string, workDir?: string): string {
  const roots = allowedReadRoots(workDir)
  return `路径不在允许根内：${input}｜可用根：${roots.join('、')}`
    + `（只读/预览已放开到允许根；写入仍限会话工作区${workDir ? `：${workDir}` : ''}）`
}

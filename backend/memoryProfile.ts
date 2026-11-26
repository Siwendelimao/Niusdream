/**
 * memoryProfile.ts —— 用户画像 / 项目记忆（两个 Markdown 文件）
 *
 * 为什么单独成文件，不放 SQLite 记忆库：
 *   画像要"每轮注入、长期不变、不被批量清理误伤"。Hermes（NousResearch/hermes-agent，官方文档实测）就是
 *   两份文件 + 硬字符上限 + 会话启动冻结快照 —— 它的 USER.md 1375 字符 / MEMORY.md 2200 字符。
 *   我们照这套，只加两件它没有的：① ## 分组（老板要的"喜欢/讨厌/说话风格"）② 与记忆库条目的关联（后续阶段）。
 *
 * 三条硬规矩（抄自 Hermes，别改）：
 *   ① **硬上限，超了就报错，绝不自动压缩** —— 逼 AI 自己合并取舍，这是"不变成垃圾堆"的唯一保障；
 *   ② 内容少而稳 ⇒ 是完美的缓存前缀（写完一直命中，几乎不花钱），所以敢每轮注入；
 *   ③ 写入即时落盘（会话内读的是启动时快照，下一轮生效）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'

export type ProfileKind = 'user' | 'agent'

/** user = USER.md（用户画像）、agent = MEMORY.md（项目/环境记忆） */
const LIMITS: Record<ProfileKind, number> = { user: 1400, agent: 2200 }
const FILES: Record<ProfileKind, string> = { user: 'USER.md', agent: 'MEMORY.md' }
const TITLES: Record<ProfileKind, string> = { user: '用户画像', agent: '项目记忆' }
/** 默认分组（文件不存在时按这个建，AI 也可以自己加新分组） */
const DEFAULT_SECTIONS: Record<ProfileKind, string[]> = {
  user: ['说话风格', '喜欢', '讨厌', '协作', '背景'],
  agent: ['环境', '铁律'],
}

export function profileDir(): string { return path.join(DATA_ROOT, 'memories') }
export function profilePath(kind: ProfileKind): string { return path.join(profileDir(), FILES[kind]) }
export function profileLimit(kind: ProfileKind): number { return LIMITS[kind] }
export function profileTitle(kind: ProfileKind): string { return TITLES[kind] }

export interface ProfileDoc {
  kind: ProfileKind
  file: string
  content: string
  chars: number
  limit: number
  /** 是否已到上限（≥95%）——供注入侧提示"该合并了" */
  nearFull: boolean
}

function ensureDir(): void {
  try { fs.mkdirSync(profileDir(), { recursive: true }) } catch { /* ignore */ }
}

function seed(kind: ProfileKind): string {
  const head = `# ${TITLES[kind]}\n`
  const body = DEFAULT_SECTIONS[kind].map(s => `## ${s}\n`).join('\n')
  return head + '\n' + body
}

export function readProfile(kind: ProfileKind): ProfileDoc {
  const p = profilePath(kind)
  let content = ''
  try { content = fs.readFileSync(p, 'utf8') } catch { content = '' }
  if (!content.trim()) content = seed(kind)   // 首次读取给骨架（不落盘，等真有内容再写）
  const chars = content.length
  return { kind, file: FILES[kind], content, chars, limit: LIMITS[kind], nearFull: chars >= LIMITS[kind] * 0.95 }
}

export interface WriteResult { ok: boolean; error?: string; chars?: number; limit?: number }

/** 整体覆盖写。**超限直接报错**（学 Hermes：不自动压缩，逼调用方自己合并）。 */
export function writeProfile(kind: ProfileKind, content: string): WriteResult {
  const body = String(content ?? '')
  const chars = body.length
  const limit = LIMITS[kind]
  if (chars > limit) {
    return {
      ok: false,
      chars, limit,
      error: `超过上限（${chars}/${limit} 字符）。记忆**不会自动压缩**：请先合并或删掉旧条目腾地方，再写这一条。`
        + `\n（当前内容可用 profile_read 查看；删/合并用 profile_patch 或 profile_remove。）`,
    }
  }
  ensureDir()
  try { fs.writeFileSync(profilePath(kind), body, 'utf8') } catch (e: any) {
    return { ok: false, error: '写盘失败：' + String(e?.message || e) }
  }
  return { ok: true, chars, limit }
}

/** 解析成 [{heading, items}]：只认 `## xxx` 与紧跟的 `- item` */
export function parseSections(content: string): Array<{ heading: string; items: string[] }> {
  const out: Array<{ heading: string; items: string[] }> = []
  for (const line of String(content || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { out.push({ heading: h[1].trim(), items: [] }); continue }
    const it = line.match(/^[-*]\s+(.+?)\s*$/)
    if (it && out.length) out[out.length - 1].items.push(it[1].trim())
  }
  return out
}

/** 序列化回 Markdown（保持分组顺序） */
export function serializeSections(kind: ProfileKind, sections: Array<{ heading: string; items: string[] }>): string {
  const parts: string[] = [`# ${TITLES[kind]}`, '']
  for (const s of sections) {
    parts.push(`## ${s.heading}`)
    for (const it of s.items) parts.push(`- ${it}`)
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export interface EntryResult extends WriteResult { section?: string; action?: string }

/** 往某个分组追加一条（分组不存在则新建）。超限返回 ok:false + 提示合并。 */
export function addEntry(kind: ProfileKind, section: string, text: string): EntryResult {
  const sec = String(section || '').trim() || DEFAULT_SECTIONS[kind][0]
  const item = String(text || '').trim()
  if (!item) return { ok: false, error: '内容不能为空' }
  const doc = readProfile(kind)
  const sections = parseSections(doc.content)
  if (!sections.some(s => s.heading === sec)) sections.push({ heading: sec, items: [] })
  const target = sections.find(s => s.heading === sec)!
  /* 同一分组里已有等价的一条 ⇒ 不重复写。
     ★1126 实测踩到：模型会自己补个句号（"先结论后证据" vs "先结论后证据。"），
     精确比较判不出重复 ⇒ 画像里堆同义条目。这里比较时抹掉末尾标点与空白。 */
  const norm = (x: string) => String(x).replace(/[\s。．.；;，,、！!？?]+$/g, '')
  if (target.items.some(it => norm(it) === norm(item))) {
    return { ok: true, action: 'noop-duplicate', section: sec, chars: doc.chars, limit: doc.limit }
  }
  target.items.push(item)
  const next = serializeSections(kind, sections)
  const r = writeProfile(kind, next)
  return { ...r, section: sec, action: 'added' }
}

/** 按"包含匹配"替换条目文字（old 命中就整条换成 text）。 */
export function patchEntry(kind: ProfileKind, oldText: string, newText: string): EntryResult {
  const oldS = String(oldText || '').trim()
  const newS = String(newText || '').trim()
  if (!oldS || !newS) return { ok: false, error: 'oldText 与 newText 都不能为空' }
  const doc = readProfile(kind)
  const sections = parseSections(doc.content)
  let hit = 0
  for (const s of sections) {
    s.items = s.items.map(it => {
      if (it.includes(oldS)) { hit++; return newS }
      return it
    })
  }
  if (!hit) return { ok: false, error: `没有找到包含「${oldS}」的条目` }
  const r = writeProfile(kind, serializeSections(kind, sections))
  return { ...r, action: `patched:${hit}` }
}

/** 按"包含匹配"删除条目。 */
export function removeEntry(kind: ProfileKind, matchText: string): EntryResult {
  const m = String(matchText || '').trim()
  if (!m) return { ok: false, error: 'matchText 不能为空' }
  const doc = readProfile(kind)
  const sections = parseSections(doc.content)
  let hit = 0
  for (const s of sections) {
    const kept = s.items.filter(it => { const keep = !it.includes(m); if (!keep) hit++; return keep })
    s.items = kept
  }
  if (!hit) return { ok: false, error: `没有找到包含「${m}」的条目` }
  const r = writeProfile(kind, serializeSections(kind, sections))
  return { ...r, action: `removed:${hit}` }
}

/** ★1126 关联：从画像/项目记忆文本里抽出 `→ mem_xxx` 形式的引用。
 *  为什么这么做（老板要的"用户喜欢做开发 → 关联禁止兜底"）：
 *  画像条目旁边挂上铁律的 id，注入时 Server 侧把它展开成摘要 —— 于是 AI 看到的不只是
 *  "他技术底子硬"，而是"他技术底子硬，对应铁律：禁止兜底"。指出了关联，不只是并列。
 *  语法故意宽松：`→ mem_xxx` / `-> mem_xxx` / `=> mem_xxx` 都认。 */
export function parseProfileLinks(text: string): Array<{ memId: string; raw: string }> {
  const out: Array<{ memId: string; raw: string }> = []
  const re = /(?:→|->|=>)\s*(mem_[0-9a-fA-F]{6,64})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text || '')))) out.push({ memId: m[1], raw: m[0] })
  return out
}

/** 按条展开（对话流「记忆命中」要把画像条目也列出来，老板要能看到） */
export function profileEntries(kind: ProfileKind): Array<{ id: string; section: string; summary: string }> {
  const doc = readProfile(kind)
  const out: Array<{ id: string; section: string; summary: string }> = []
  for (const s of parseSections(doc.content)) {
    s.items.forEach((it, i) => out.push({ id: `${kind}-${i}-${s.heading}`, section: s.heading, summary: `[${s.heading}] ${it}` }))
  }
  return out
}

/** 注入块：分组渲染（空文件返回空串 ⇒ 调用方不注入空块） */
export function buildProfileBlock(kind: ProfileKind): { block: string; chars: number; sections: number; entries: number } {
  const doc = readProfile(kind)
  const sections = parseSections(doc.content).filter(s => s.items.length)
  if (!sections.length) return { block: '', chars: 0, sections: 0, entries: 0 }
  const head = kind === 'user'
    ? '[用户画像] 长期有效（每轮自动注入；用户明确改口时用 memory 工具更新）'
    : '[项目记忆] 长期有效的环境与铁律（不要每轮重复陈述，照着做即可）'
  const lines: string[] = [head]
  let entries = 0
  for (const s of sections) {
    lines.push(`· ${s.heading}：` + s.items.join('；'))
    entries += s.items.length
  }
  const block = lines.join('\n')
  return { block, chars: block.length, sections: sections.length, entries }
}

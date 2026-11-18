/**
 * 强化记忆 / 强化知识 —— 「钉住」登记表（★A 阶段：记忆强化，老板 1104 拍板「不设上限」）
 *
 * 为什么在 Node 侧另存一份，而不给记忆库加 schema（方案乙，零侵入）：
 *   记忆库（memory_system.db）与知识库（knowledge.db）都是 **Python 内核**（memory-kernel /
 *   memory_bridge.py）的 SQLite 库，节点/条目的字段由内核定义。往节点上写自定义字段
 *   （pinned / pinned_at）要么改内核 schema（任务明令不改 py），要么依赖内核「未知字段透传」
 *   这种没有任何保证的行为 —— 内核升级 / 回滚 / 换库随时静默丢字段。
 *   而「钉住」本质是**注入策略**（这轮要不要强制塞进消息头），不是记忆内容本身 ⇒
 *   存成后端自己的两份小 JSON 最安全：
 *     · 内核照旧读写，完全不知道有这张表（零侵入，不动 py、不动 db）；
 *     · 本表丢了/删了 = 「全部取消钉住」，记忆本体一字不损（可回退，无数据风险）；
 *     · 注入只读本表 ⇒ **记忆桥挂掉/超时也照样注入**（快照存在本地）。
 *
 * 数据完全独立（需求「数据独立、逻辑共用」）：
 *     data/pinned-memory.json     只装记忆 id（mem_* 来源）
 *     data/pinned-knowledge.json  只装知识 id（knowledge.db 来源）
 *   两份文件、同一套逻辑（本模块按 kind 参数化）⇒ 逻辑与展示共用，数据互不混。
 *
 * 文件结构（读到坏文件一律当空表，不抛错、不覆盖原文件内容以外的任何东西）：
 *   { "version": 1, "items": [ { id, summary, type, pinnedAt, title?, content?, projectId? } ] }
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'

export type PinnedKind = 'memory' | 'knowledge'

export interface PinnedItem {
  /** 源库里的完整 id（mem_xxx / kb_xxx）；注入块里只印后 6 位 */
  id: string
  /** 注入用的一行文本（记忆=summary/content；知识=title/content），pin 时抄快照 */
  summary: string
  /** 记忆：preference/decision/lesson/pattern/fact/profile；知识：doc/manual/note/reference */
  type: string
  /** 钉住时间戳（ms）—— 注入按它**升序**排（先钉的在前，顺序稳定） */
  pinnedAt: number
  title?: string
  content?: string
  projectId?: string
}

const FILES: Record<PinnedKind, string> = {
  memory: 'pinned-memory.json',
  knowledge: 'pinned-knowledge.json',
}

/** 每个 kind 的内存镜像：{ items, mtimeMs }；mtime 变了才重读盘（手改文件也能生效） */
const _cache: Record<string, { items: PinnedItem[]; mtimeMs: number } | undefined> = {}

export function pinnedFileOf(kind: PinnedKind): string {
  return path.join(DATA_ROOT, FILES[kind])
}

function sanitize(x: any): PinnedItem | null {
  if (!x || typeof x !== 'object') return null
  const id = String(x.id || '').trim()
  if (!id) return null
  return {
    id,
    summary: String(x.summary || x.title || x.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    type: String(x.type || ''),
    pinnedAt: Number(x.pinnedAt) || Date.now(),
    ...(x.title ? { title: String(x.title) } : {}),
    ...(x.content ? { content: String(x.content) } : {}),
    ...(x.projectId ? { projectId: String(x.projectId) } : {}),
  }
}

/** 读盘（带 mtime 缓存）。文件不存在 / JSON 坏 / 不是本模块写的 → 空表，绝不抛错 */
function load(kind: PinnedKind): PinnedItem[] {
  const file = pinnedFileOf(kind)
  let mtimeMs = 0
  try { mtimeMs = fs.statSync(file).mtimeMs } catch { mtimeMs = 0 }
  const c = _cache[kind]
  if (c && c.mtimeMs === mtimeMs) return c.items
  let items: PinnedItem[] = []
  if (mtimeMs) {
    try {
      const raw: any = JSON.parse(fs.readFileSync(file, 'utf8'))
      const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
      items = arr.map(sanitize).filter(Boolean) as PinnedItem[]
    } catch { items = [] }
  }
  _cache[kind] = { items, mtimeMs }
  return items
}

/** 原子写（tmp + rename）：半截文件不会被读到，写失败也不破坏旧表 */
function save(kind: PinnedKind, items: PinnedItem[]): void {
  const file = pinnedFileOf(kind)
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  let mtimeMs = 0
  try { mtimeMs = fs.statSync(file).mtimeMs } catch { mtimeMs = Date.now() }
  _cache[kind] = { items, mtimeMs }
}

/** 已钉列表（注入按 pinnedAt 升序：先钉的先出现，界面顺序不抖） */
export function listPinned(kind: PinnedKind): PinnedItem[] {
  return load(kind).slice().sort((a, b) => (a.pinnedAt - b.pinnedAt) || (a.id < b.id ? -1 : 1))
}

/** 已钉 id 集合（给 L0 去重用） */
export function pinnedIdSet(kind: PinnedKind): Set<string> {
  return new Set(load(kind).map((x) => x.id))
}

/** 钉住（幂等 upsert：重复钉只刷新快照与时间） */
export function pinPinned(kind: PinnedKind, item: PinnedItem): PinnedItem {
  const clean = sanitize({ ...item, pinnedAt: item.pinnedAt || Date.now() }) as PinnedItem
  const items = load(kind).filter((x) => x.id !== clean.id)
  items.push(clean)
  save(kind, items)
  return clean
}

/** 取消钉住。返回是否真的删掉了（不存在 = false，不报错） */
export function unpinPinned(kind: PinnedKind, id: string): boolean {
  const want = String(id || '').trim()
  if (!want) return false
  const items = load(kind)
  const next = items.filter((x) => x.id !== want)
  if (next.length === items.length) return false
  save(kind, next)
  return true
}

/** 数量（给日志/面板用） */
export function pinnedCount(kind: PinnedKind): number {
  return load(kind).length
}

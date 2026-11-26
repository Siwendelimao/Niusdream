/* mediaGallery.ts —— 生成图片的画廊索引（★1126）
 *
 * 为什么需要单独一份索引：图片本身落在 `会话工作区/screenshots/shot-*.png`，
 * 文件名只有时间戳和随机串 —— **纯扫目录看不出哪张是哪张**（不知道 prompt、不知道用的什么模型、多大尺寸）。
 * 而 prompt 一旦错过落盘那一刻就再也补不回来了，所以必须在 persistShot 时同步记一条。
 *
 * 存放：`<数据根>/media-gallery.json`（全局一份，按 sessionId 过滤）。
 * 为什么全局而不是放各会话工作区：画廊面板要能跨会话回看，且用户删了会话后图还在时索引也还在。
 *
 * ⚠️ 存量图（索引上线前生成的）不会出现在画廊里 —— 它们从来没记过 prompt，
 *    编一个"猜出来的"描述比不显示更糟，所以如实不列。
 */
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, persistJson } from './jsonStore.ts'

export interface GalleryEntry {
  /** 相对会话工作区的路径，如 `screenshots/shot-1750000000000-ab12.png` */
  shotRef: string
  sessionId: string
  prompt: string
  model: string
  /** 如 1024x1536；空串 = 用供应商默认 */
  size: string
  ts: number
  /** ★1126：来源分类 —— 'image' = AI 生成（有 prompt）；'screenshot' = 截图/转发的图（没有 prompt）；
   *  'video' = 生成的视频（mp4，走后台任务产出） */
  kind: 'image' | 'screenshot' | 'video'
  /** ★1126：删除时间戳 = 在回收站里。有值表示"已删除但还能恢复"；彻底删除会把整条从索引移除 */
  deletedAt?: number
}

const FILE = path.join(DATA_ROOT, 'media-gallery.json')
/** 上限：超出丢最旧的（一张图一条，2000 条足够回看几个月；再多索引文件也会变大拖慢读） */
const MAX_ENTRIES = 2000

function readAll(): GalleryEntry[] {
  const r = loadJsonOrBackup<GalleryEntry[]>(FILE, () => [])
  const arr = Array.isArray(r.data) ? r.data : []
  return arr.filter(e => e && typeof e.shotRef === 'string' && typeof e.ts === 'number')
}

/** 记一条（生成成功且落盘后调用）。写失败不抛：图已经生成好了，索引丢一条不该让整次生成失败。 */
export function addGalleryEntry(e: GalleryEntry): void {
  try {
    const all = readAll()
    all.push(e)
    const trimmed = all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all
    /* isEmpty 恒 false：索引列表为空也是有效状态（清空后不该被"空就跳过写"挡住） */
    persistJson(FILE, trimmed, { isEmpty: () => false })
  } catch (err) {
    console.warn('[mediaGallery] 索引写入失败（图已落盘，不影响使用）：', String((err as any)?.message || err))
  }
}

/** 列表：按时间倒序。`sessionId` 只看一个会话；`sessionIds` 看一组（"当前工作区"= 同一 workDir 的所有会话）；都不传 = 全部。 */
export function listGallery(opts: { sessionId?: string; sessionIds?: Set<string>; kind?: 'image' | 'screenshot' | 'video'; limit?: number; trash?: boolean } = {}): GalleryEntry[] {
  const { sessionId, sessionIds, kind, limit = 200, trash = false } = opts
  let list = readAll()
  if (sessionId) list = list.filter(e => e.sessionId === sessionId)
  else if (sessionIds) list = list.filter(e => sessionIds.has(e.sessionId))
  if (kind) list = list.filter(e => (e.kind || 'image') === kind)
  /* ★1126：正常栏排除回收站里的；回收站栏只看已删除的 */
  list = list.filter(e => (trash ? !!e.deletedAt : !e.deletedAt))
  list.sort((a, b) => b.ts - a.ts)
  return list.slice(0, Math.max(1, Math.min(1000, limit)))
}

/** 统计（画廊面板 tab 上的数量） */
export function galleryCount(sessionId?: string, kind?: 'image' | 'screenshot' | 'video', trash = false, sessionIds?: Set<string>): number {
  const all = readAll()
  return all.filter(e =>
    (sessionId ? e.sessionId === sessionId : sessionIds ? sessionIds.has(e.sessionId) : true)
    && (!kind || (e.kind || 'image') === kind)
    && (trash ? !!e.deletedAt : !e.deletedAt)).length
}

/** 标记为已删除（进回收站；**不动文件**，文件由调用方移到 .trash 目录） */
export function markDeleted(sessionId: string, shotRef: string, at: number): boolean {
  const all = readAll()
  let hit = false
  for (const e of all) {
    if (e.sessionId === sessionId && e.shotRef === shotRef) { e.deletedAt = at; hit = true }
  }
  if (!hit) return false
  persistJson(FILE, all, { isEmpty: () => false })
  return true
}

/** 从回收站恢复（清 deletedAt；文件由调用方移回原位置） */
export function restoreEntry(sessionId: string, shotRef: string): boolean {
  const all = readAll()
  let hit = false
  for (const e of all) {
    if (e.sessionId === sessionId && e.shotRef === shotRef) { delete e.deletedAt; e.ts = Date.now(); hit = true }
  }
  if (!hit) return false
  persistJson(FILE, all, { isEmpty: () => false })
  return true
}

/** 彻底删一条索引（文件已由调用方删掉） */
export function removeGalleryEntry(sessionId: string, shotRef: string): boolean {
  const all = readAll()
  const next = all.filter(e => !(e.sessionId === sessionId && e.shotRef === shotRef))
  if (next.length === all.length) return false
  persistJson(FILE, next, { isEmpty: () => false })
  return true
}

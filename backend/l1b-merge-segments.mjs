/**
 * L1b 回滚配套：把多段会话合并回 L1a 能读的单段格式。
 *
 * 为什么需要：L1a 代码只认 `<id>/0001.jsonl`。一旦产生 `0002.jsonl`，直接回滚到 L1a
 * 会**读不到第二段**（静默丢消息）。所以回滚代码前必须先跑本脚本，或确认 disk 上没有多段会话。
 *
 * 用法（**先停后端**，默认 dry-run，只有显式 --apply 才写盘）：
 *   node _l1b_merge_segments.mjs --data-root D:/nis0924/backend/data
 *   node _l1b_merge_segments.mjs --data-root D:/nis0924/backend/data --apply
 *
 * 动作（不物理删任何文件，多余段 rename 进 <id>/_merged_segments/，可人工找回）：
 *   ① 跨段回放所有 op，得到最终存活消息（P/D 语义已生效）
 *   ② 把 0001.jsonl 重写成 header + 全量 a 行（L1a 单段格式）
 *   ③ meta.json 去掉 segments 字段（L1a 判定为单段）
 *   ④ 0002+ 段文件搬进 <id>/_merged_segments/
 *   ⑤ 重新回放 0001.jsonl 校验条数一致，不一致就报错退出
 *
 * 零依赖，只读/写 `sessions/<id>/` 下的文件，不碰团队/成员/老 .json/前端。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const APPLY = argv.includes('--apply')
const DATA_ROOT = getArg('--data-root') || path.join(import.meta.dirname, 'data')
const SESS = path.join(DATA_ROOT, 'sessions')
if (!fs.existsSync(SESS)) throw new Error(`会话目录不存在：${SESS}`)

const idOf = (m, i) => (m && typeof m.id === 'string' && m.id) ? m.id : `\u0000anon${i}`
function applyOp(op, acc) {
  if (!op || typeof op !== 'object') return
  if (op.t === 'a') { acc.messages.push(op.m); acc.ids.push(idOf(op.m, acc.messages.length - 1)); return }
  if (op.t === 'r') {
    const i = acc.ids.indexOf(String(op.id))
    if (i < 0) { acc.messages.push(op.m); acc.ids.push(String(op.id || idOf(op.m, acc.messages.length - 1))) }
    else acc.messages[i] = op.m
    return
  }
  if (op.t === 'i') {
    const mid = String(op.id || idOf(op.m, acc.messages.length))
    if (op.af == null) { acc.messages.unshift(op.m); acc.ids.unshift(mid); return }
    const at = acc.ids.indexOf(String(op.af))
    if (at < 0) { acc.messages.push(op.m); acc.ids.push(mid); return }
    acc.messages.splice(at + 1, 0, op.m); acc.ids.splice(at + 1, 0, mid)
    return
  }
  if (op.t === 'd') {
    const i = acc.ids.indexOf(String(op.id))
    if (i >= 0) { acc.messages.splice(i, 1); acc.ids.splice(i, 1) }
  }
}
/** 读一个 jsonl 段：只取完整行（末行无 \n 视为撕裂尾丢弃），坏行记 ERROR 后跳过。 */
function readSegment(file, acc) {
  const buf = fs.readFileSync(file)
  let off = 0, lines = 0, bad = 0
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off)
    if (nl === -1) break
    let line = buf.toString('utf8', off, nl)
    off = nl + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    lines++
    try { applyOp(JSON.parse(line), acc) } catch (e) { bad++; console.error(`  [ERROR] ${file} 第 ${lines} 行损坏，跳过：${String(e.message || e)}`) }
  }
  return { lines, bad }
}
/** Windows 上 rename 覆盖已存在文件会被杀软/索引器短暂占位（EPERM/EACCES/EBUSY）。
 *  与 sessionStore.renameRetrySync 同口径：暂时性错误退避重试，重试耗尽仍抛错（绝不静默当作成功）。 */
function renameRetry(from, to, tries = 10) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      const c = String(e?.code || '')
      if ((c === 'EPERM' || c === 'EACCES' || c === 'EBUSY') && i + 1 < tries) {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + i * 20) } catch {}
        continue
      }
      throw e
    }
  }
}
function replayOne(file) {
  const acc = { messages: [], ids: [] }
  readSegment(file, acc)
  return acc.messages
}

let scanned = 0, multi = 0, merged = 0, failed = 0
const report = []
for (const name of fs.readdirSync(SESS)) {
  const dir = path.join(SESS, name)
  if (!fs.statSync(dir).isDirectory() || name.startsWith('_')) continue
  scanned++
  const metaPath = path.join(dir, 'meta.json')
  if (!fs.existsSync(metaPath)) continue
  let meta
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) } catch (e) {
    console.error(`[ERROR] ${name} meta 不可解析，跳过：${String(e.message || e)}`); failed++; continue
  }
  const segs = Array.isArray(meta.segments)
    ? meta.segments.map((x) => String(x?.f || '')).filter((f) => /^\d{4}\.jsonl$/.test(f))
    : (fs.existsSync(path.join(dir, '0001.jsonl')) ? ['0001.jsonl'] : [])
  if (segs.length <= 1) continue
  multi++

  const acc = { messages: [], ids: [] }
  let bad = 0
  for (const f of segs) {
    const p = path.join(dir, f)
    if (!fs.existsSync(p)) { console.error(`[ERROR] ${name} 段文件缺失：${f}`); failed++; bad++; continue }
    bad += readSegment(p, acc).bad
  }
  const before = acc.messages.length
  const first = path.join(dir, '0001.jsonl')
  const parts = [JSON.stringify({ v: 1, t: 'h', id: name, at: Date.now() }) + '\n']
  for (const m of acc.messages) parts.push('{"t":"a","m":' + JSON.stringify(m) + '}\n')
  const data = parts.join('')

  if (!APPLY) {
    report.push(`[dry-run] ${name}: ${segs.length} 段 → 单段，${before} 条消息，将搬走 ${segs.slice(1).join(',')}`)
    continue
  }
  try {
    const tmpData = path.join(dir, `0001.jsonl.merge.${process.pid}.tmp`)
    fs.writeFileSync(tmpData, data, 'utf-8')
    renameRetry(tmpData, first)
    const trash = path.join(dir, '_merged_segments')
    fs.mkdirSync(trash, { recursive: true })
    for (const f of segs.slice(1)) renameRetry(path.join(dir, f), path.join(trash, f))
    delete meta.segments
    const tmpMeta = path.join(dir, `meta.json.merge.${process.pid}.tmp`)
    fs.writeFileSync(tmpMeta, JSON.stringify(meta), 'utf-8')
    renameRetry(tmpMeta, metaPath)
    const after = replayOne(first).length
    if (after !== before) throw new Error(`合并后条数 ${after} != 合并前 ${before}`)
    if (bad) throw new Error(`有 ${bad} 行损坏，已跳过（数据可能不完整）`)
    merged++
    report.push(`[merged] ${name}: ${segs.length} 段 → 单段，${before} 条消息，坏行 ${bad}，多余段已移入 _merged_segments/`)
  } catch (e) {
    failed++
    // 只清理本脚本自己刚写的 .merge.*.tmp，不碰任何用户数据
    for (const t of fs.readdirSync(dir).filter((x) => x.includes('.merge.') && x.endsWith('.tmp'))) {
      try { fs.rmSync(path.join(dir, t), { force: true }) } catch {}
    }
    report.push(`[FAILED] ${name}: ${String(e.message || e)}`)
    console.error(`[ERROR] ${name} 合并失败：${String(e.message || e)}`)
  }
}
console.log('=== L1b 多段回滚合并 ===')
console.log(`data-root = ${DATA_ROOT}`)
console.log(`模式 = ${APPLY ? 'APPLY（实际写盘）' : 'dry-run（只读，加 --apply 才写）'}`)
console.log(`扫描会话目录 = ${scanned}，多段会话 = ${multi}，已合并 = ${merged}，失败 = ${failed}`)
for (const r of report) console.log('  ' + r)
if (!APPLY && multi) console.log('→ 确认无误后加 --apply 再跑一次；回滚代码前必须完成合并。')
if (failed) process.exitCode = 1

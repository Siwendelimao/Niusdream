/**
 * 1032（P39 · Step3 前置）：把 `session.turnMetas` 里的 timing/usage **迁进消息本身**（turnTiming/usage），
 * 迁完之后"按 ts 查表"这条兼容路径就可以删掉 —— 统计行的轮归属只由消息自己决定，不再靠时间戳对齐。
 *
 * 口径：只处理**没有 turnTiming 的 assistant 消息**；按 `timestamp` 精确配对（turnMetas.ts 就是当初
 * 取的那条消息的 timestamp）。实测 5051 条里只有 90 条能配上 —— 其余本来就没拿到统计（沉默丢失），
 * 这次不编造、不按顺序猜，配不上就留空。
 *
 * 用法：node backend/migrate-turnmeta.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = 'D:/nis0924/backend/data/sessions'
const dry = process.argv.includes('--dry')

let ses = 0, hit = 0, miss = 0, saved = 0
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue
  const p = path.join(DIR, f)
  let j
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
  const metas = Array.isArray(j.turnMetas) ? j.turnMetas : []
  if (!metas.length) continue
  const byTs = new Map()
  for (const t of metas) byTs.set(Number(t.ts), t)
  const msgs = Array.isArray(j.messages) ? j.messages : []
  let touched = 0
  for (const m of msgs) {
    if (String(m?.role) !== 'assistant') continue
    if (m.turnTiming) continue
    const hit2 = byTs.get(Number(m.timestamp))
    if (!hit2) { miss++; continue }
    if (hit2.timing) { m.turnTiming = hit2.timing; touched++; hit++ }
    if (hit2.usage) { m.usage = hit2.usage }
  }
  if (touched) {
    ses++
    if (!dry) fs.writeFileSync(p, JSON.stringify(j), 'utf8')
    saved++
  }
}
console.log((dry ? '[dry] ' : '') + '迁入 turnTiming：' + hit + ' 条消息 / ' + ses + ' 个会话' + (dry ? '' : '（已落盘）'))
console.log('配不上 turnMetas 的 assistant 消息（本来就没统计）：' + miss + ' 条')

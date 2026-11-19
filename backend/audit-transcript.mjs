/**
 * 1032（P38 事后审计）：Step2 那次"抹掉 transcript"到底伤到了什么？
 * 逐会话比对三件事：
 *   1) 现在有没有 transcript / 备份里有没有（没有 = 无从恢复）
 *   2) 恢复出来的 transcript 是否**落后于 messages**（备份早于最后一次对话 ⇒ 少最后一轮）
 *   3) messages 里的工具块够不够（够 = 可以直接重建，不怕丢）
 *
 * 用法：node backend/audit-transcript.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const LIVE = 'D:/nis0924/backend/data/sessions'
const BAK = 'D:/_nis_backups/pre-step2-20261101/sessions'

const blocks = (m) => (Array.isArray(m?.content) ? m.content : [])
const tsOf = (arr) => {
  let mx = 0
  for (const m of arr || []) mx = Math.max(mx, Number(m?.timestamp) || 0)
  return mx
}
const toolUseInMsgs = (msgs) => (msgs || []).reduce((n, m) => n + blocks(m).filter((c) => String(c?.type) === 'tool_use').length, 0)
const toolCallInTr = (tr) => (tr || []).reduce((n, m) => n + blocks(m).filter((c) => String(c?.type) === 'toolCall').length, 0)

let live = 0, hasTr = 0, noTrNoBak = 0, noTrEmptyBak = 0
const stale = []   // transcript 落后于 messages
const restorable = [] // 没 transcript 但能重建

for (const f of fs.readdirSync(LIVE)) {
  if (!f.endsWith('.json')) continue
  live++
  let cur
  try { cur = JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8')) } catch { continue }
  const msgs = Array.isArray(cur.messages) ? cur.messages : []
  const tr = Array.isArray(cur.transcript) ? cur.transcript : []
  if (tr.length) {
    hasTr++
    const gap = tsOf(msgs) - tsOf(tr)
    /* 5 秒容差：同一次落盘的微小时差不算落后 */
    if (gap > 5000) {
      stale.push({
        id: f.slice(0, 8),
        gapMin: Math.round(gap / 60000),
        trN: tr.length,
        msgN: msgs.length,
        complete: toolUseInMsgs(msgs) >= toolCallInTr(tr),
      })
    }
    continue
  }
  const bp = path.join(BAK, f)
  const bak = fs.existsSync(bp) ? JSON.parse(fs.readFileSync(bp, 'utf8')) : null
  if (!bak) { noTrNoBak++; continue }
  const bakTr = Array.isArray(bak.transcript) ? bak.transcript : []
  if (!bakTr.length) { noTrEmptyBak++; continue }
  restorable.push({ id: f.slice(0, 8), msgN: msgs.length, bakTrN: bakTr.length })
}

console.log('=== 会话文件 ' + live + ' 个 ===')
console.log('有 transcript：' + hasTr)
console.log('没 transcript 且备份里也没有：' + noTrNoBak + '（这些从没存过，不丢）')
console.log('没 transcript 但备份里本来是空的：' + noTrEmptyBak + '（不丢）')
console.log('没 transcript 但备份里有、却没恢复上：' + restorable.length + (restorable.length ? ' ← 要补' : '（无）'))

console.log('\n=== transcript 落后于 messages 的会话（恢复的是备份那一刻的快照）===')
if (!stale.length) console.log('无')
for (const x of stale.sort((a, b) => b.gapMin - a.gapMin).slice(0, 15)) {
  console.log('  ' + x.id + '  落后约 ' + x.gapMin + ' 分钟  transcript ' + x.trN + ' 条 / messages ' + x.msgN + ' 条  可安全重建=' + (x.complete ? '是' : '否'))
}
console.log('共 ' + stale.length + ' 个落后，其中可安全重建 ' + stale.filter((x) => x.complete).length + ' 个')

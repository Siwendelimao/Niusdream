/**
 * 1032（P38）**数据修复**：把 Step2 误删掉的 legacy transcript 从备份恢复到现有会话文件。
 *
 * 事故：把 transcript 从落盘白名单里删掉之后，后端重启触发全量重写，**老会话的 transcript 也被抹掉**
 *      （608 个文件全部 `'transcript' in j === false`）。老会话的 messages 里有 18/42 没存工具块
 *      ⇒ 重建出来的上下文会缺工具调用，属真实降级。
 *
 * 修复口径：**只补 transcript 字段**，其余字段以现有文件为准（现有文件是更新的）。
 * 来源：D:/_nis_backups/pre-step2-20261101/sessions/<id>.json
 *
 * 用法：node backend/_restore_transcript.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'

const LIVE = 'D:/nis0924/backend/data/sessions'
const BAK = 'D:/_nis_backups/pre-step2-20261101/sessions'
const dry = process.argv.includes('--dry')

let restored = 0, skippedHas = 0, missingBak = 0, emptyBak = 0, failed = 0
for (const f of fs.readdirSync(LIVE)) {
  if (!f.endsWith('.json')) continue
  const live = path.join(LIVE, f)
  let cur
  try { cur = JSON.parse(fs.readFileSync(live, 'utf8')) } catch { failed++; continue }
  if ('transcript' in cur && Array.isArray(cur.transcript) && cur.transcript.length) { skippedHas++; continue }
  const bp = path.join(BAK, f)
  if (!fs.existsSync(bp)) { missingBak++; continue }
  let bak
  try { bak = JSON.parse(fs.readFileSync(bp, 'utf8')) } catch { failed++; continue }
  const tr = Array.isArray(bak.transcript) ? bak.transcript : []
  if (!tr.length) { emptyBak++; continue }
  cur.transcript = tr
  if (!dry) fs.writeFileSync(live, JSON.stringify(cur), 'utf8')
  restored++
}
console.log((dry ? '[dry] ' : '') + '恢复 transcript：' + restored + ' 个')
console.log('已有 transcript 跳过：' + skippedHas + '；备份里没有：' + missingBak + '；备份里本来就空：' + emptyBak + '；解析失败：' + failed)

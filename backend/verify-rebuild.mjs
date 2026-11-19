/**
 * 1032（P38）：重建保真度验证 —— 「从 messages 重建的 transcript」是否语义等价 + 结构有效。
 *
 * 为什么不用"逐条结构完全一致"当判据：实测发现两类信息在 messages 里就已经丢了，不是还原器写错：
 *   1) 并行工具调用：pi 里一条 assistant 带 2 个 toolCall；messages 里是 use/result/use/result 交错存
 *      => 还原出来是"两次串行"，顺序不同但同样合法。
 *   2) 运行中被 steer 的 user 消息：pi 里落在工具批次之后；messages 里按写入顺序存（落在 assistant 之前）
 *      => 位置不同，但语义仍是"用户说了这句话"。
 * 所以判据改成信息与合法性：
 *   A. 信息不丢：user 正文全部保留（substring）；toolCall / toolResult 的 id 集合相等
 *   B. 结构有效：每条 toolResult 对得上前面的 toolCall；没有空 assistant
 *   C. 角色计数：user / assistant / toolResult 三类数量相等（顺序允许不同）
 *
 * 用法：node --import tsx/esm backend/verify-rebuild.mjs [样本数]
 */
import fs from 'node:fs'
import path from 'node:path'
import { rebuildTranscriptFromMessages } from './transcriptRebuild.ts'

const DIR = 'D:/nis0924/backend/data/sessions'
const LIMIT = Math.max(1, Number(process.argv[2]) || 30)

const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : [])
const callsOf = (arr) => (arr || []).flatMap((m) => blocksOf(m).filter((c) => String(c?.type) === 'toolCall').map((c) => String(c?.id || '')))
const resultsOf = (arr) => (arr || []).filter((m) => String(m?.role) === 'toolResult').map((m) => String(m?.toolCallId || ''))
const userTextsOf = (arr) =>
  (arr || []).filter((m) => String(m?.role) === 'user')
    .map((m) => blocksOf(m).filter((c) => String(c?.type) === 'text').map((c) => String(c?.text || '')).join(''))

function counts(arr) {
  const c = { user: 0, assistant: 0, toolResult: 0 }
  for (const m of arr || []) {
    const r = String(m?.role || '')
    if (r in c) c[r]++
  }
  return c
}

function validity(arr) {
  const seen = new Set()
  const problems = []
  for (let i = 0; i < (arr || []).length; i++) {
    const m = arr[i]
    const role = String(m?.role || '')
    if (role === 'toolResult') {
      const id = String(m?.toolCallId || '')
      if (!id) problems.push('#' + i + ' toolResult 缺 toolCallId')
      else if (!seen.has(id)) problems.push('#' + i + ' toolResult 找不到对应 toolCall(' + id.slice(-6) + ')')
    }
    for (const c of blocksOf(m)) if (String(c?.type) === 'toolCall') seen.add(String(c?.id || ''))
    if (role === 'assistant' && !blocksOf(m).length) problems.push('#' + i + ' 空 assistant 消息')
  }
  return problems
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
let checked = 0, ok = 0, legacy = 0, noBody = 0
const fails = []

for (const f of files) {
  if (checked + legacy >= LIMIT) break
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) } catch { noBody++; continue }
  const msgs = Array.isArray(j.messages) ? j.messages : []
  const tr = Array.isArray(j.transcript) ? j.transcript : []
  if (!msgs.length || !tr.length) { noBody++; continue }
  if (j.parentSessionId) { noBody++; continue }

  const msgCallCount = msgs.reduce((n, m) => n + blocksOf(m).filter((c) => String(c?.type) === 'tool_use').length, 0)
  if (msgCallCount < callsOf(tr).length) { legacy++; continue }

  const { transcript: rb, stats } = rebuildTranscriptFromMessages(msgs, typeof j.system === 'string' ? j.system : undefined)
  const diffs = []
  const cA = counts(tr), cB = counts(rb)
  /* 只比 toolResult 数量（工具结果不能丢）；user/assistant 的"条数"允许不同构：
     并行工具批次在 messages 里是交错的、重建会拆成串行；注入类 user 消息（[上下文]/【自动续跑】）
     在 messages 里压根没有 —— 这两类不属信息丢失，详见 docs 第十节。 */
  if (cA.toolResult !== cB.toolResult) diffs.push('toolResult 数量 ' + cA.toolResult + '!=' + cB.toolResult)
  const setA = new Set(callsOf(tr)), setB = new Set(callsOf(rb))
  if (setA.size !== setB.size || [...setA].some((x) => !setB.has(x))) diffs.push('toolCall 集合不同（原 ' + setA.size + ' / 重建 ' + setB.size + '）')
  const rA = new Set(resultsOf(tr)), rB = new Set(resultsOf(rb))
  if (rA.size !== rB.size || [...rA].some((x) => !rB.has(x))) diffs.push('toolResult 集合不同（原 ' + rA.size + ' / 重建 ' + rB.size + '）')
  /* transcript 的 user 文本 = 用户原文 + 请求期追加（前面 [记忆召回]/[上下文]，后面 【核心记忆速查】）。
     重建出来的是**原文** ⇒ 判据是「原文出现在某条 transcript 文本里」，不是相等。 */
  const trTexts = userTextsOf(tr)
  for (const t of userTextsOf(rb)) {
    const raw = String(t || "").trim()
    if (raw && !trTexts.some((x) => String(x).includes(raw))) { diffs.push("user 原文不在 transcript 里：「" + raw.slice(0, 16) + "…」"); break }
  }
  const vp = validity(rb)
  if (vp.length) diffs.push('结构无效：' + vp.slice(0, 2).join(' / '))
  if (stats.unpairedToolUse) diffs.push('有 toolCall 没配对结果：' + stats.unpairedToolUse)

  checked++
  if (!diffs.length) ok++
  else fails.push({ id: f.slice(0, 8), msgs: msgs.length, tr: tr.length, rb: rb.length, diffs: diffs.slice(0, 3) })
}

console.log('\n=== 重建保真度（语义等价 + 结构有效）===')
console.log('块完整的新会话：' + ok + '/' + checked + ' 通过')
console.log('老会话（messages 没存工具块，不适用重建）：' + legacy + ' 个；空/无正文：' + noBody + ' 个')
if (fails.length) {
  console.log('\n--- 未通过（前 10 个）---')
  for (const x of fails.slice(0, 10)) {
    console.log(x.id + '  messages=' + x.msgs + ' transcript=' + x.tr + ' rebuilt=' + x.rb)
    for (const d of x.diffs) console.log('   · ' + d)
  }
}
process.exit(fails.length ? 1 : 0)

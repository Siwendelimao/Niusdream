/**
 * L4 · 孤儿 tool_use 修复（纯函数，零依赖，便于单测）。
 *
 * 背景（施工单 §0）：历史数据里有「有调用无结果」的中间态（进程被杀的瞬间）。
 * 这种消息序列发给网关会被 400 拒（`server.ts` 删轮断言那段注释已写明同款硬约束）。
 * pi 库只处理"响应被截断"的 toolCall（`failToolCallsFromTruncatedMessage`），**不处理历史孤儿**。
 *
 * 本模块只做一件事：把缺结果的调用补上一条「结果未知」的 result。
 *  · **幂等**：补的内容带 ORPHAN_MARK，重跑不会重复补（已有 result 的 id 不再算缺失）。
 *  · **不原地改入参**：始终返回新数组；没孤儿时原样返回入参。
 *  · **不猜结果**：补的文案明确写"结果未知，不要假设成功或失败"。
 *
 * 三种形态都要认（施工单 §1.1 规则 1）：
 *   · call  ：`content[].type === 'toolCall'`（transcript）/ `'tool_use'`（messages）
 *   · result：`content[].type === 'tool_result'` 的 `toolUseId|toolCallId`
 *            `role === 'toolResult'` 消息的 `toolCallId|toolUseId`
 */

/** 补的 result 内容里带这个标记，用于幂等：已修过的不会重复补 */
export const ORPHAN_MARK = '[nis-orphan-repair]'

/** 补的文案 */
export const ORPHAN_TEXT =
  ORPHAN_MARK + ' 该工具调用未完成：NiusDream 后端在本次调用期间重启，结果未知。不要假设它成功或失败；如需继续请重新执行。'

const CALL_TYPES = new Set(['toolCall', 'tool_use'])
const RESULT_BLOCK_TYPES = new Set(['tool_result'])

function isObj(v) {
  return v !== null && typeof v === 'object'
}

/** 一块文本：兼容 content 是字符串 / 数组（数组里取 text） */
function textOfContent(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join('\n')
}

/** 一条消息是不是"结果消息"（transcript 的 toolResult 或 messages 的 tool_result 块） */
function isResultMessage(m) {
  if (!isObj(m)) return false
  if (m.role === 'toolResult') return true
  return Array.isArray(m.content) && m.content.some((b) => isObj(b) && RESULT_BLOCK_TYPES.has(b.type))
}

/**
 * 检测并修复一串消息里的孤儿工具调用。
 * @returns {{ messages: any[], repaired: Array<{toolCallId: string, toolName: string, afterIndex: number}>, alreadyMarked: number }}
 *  - messages: 修复后的新数组（不原地改入参；无孤儿时**原样返回入参**）
 *  - repaired: 本次补了哪些（afterIndex = 它被插在**原数组**哪个下标的消息之后）
 *  - alreadyMarked: 卡在 ORPHAN_MARK 上的结果条数（说明上次修过，幂等跳过）
 */
export function repairOrphans(messages) {
  const src = Array.isArray(messages) ? messages : []
  const calls = []
  const resultIds = new Set()
  let alreadyMarked = 0
  let sawResultMessageForm = false
  let sawResultBlockForm = false

  for (let i = 0; i < src.length; i++) {
    const m = src[i]
    if (!isObj(m)) continue
    /* ── result 形态 A：`role==='toolResult'` 的整条消息（transcript）── */
    if (m.role === 'toolResult') {
      sawResultMessageForm = true
      const rid = String(m.toolCallId || m.toolUseId || '')
      if (rid) {
        resultIds.add(rid)
        if (textOfContent(m.content).includes(ORPHAN_MARK)) alreadyMarked++
      }
      continue                        // 它的 content 只是文本块，不再往下扫
    }
    /* ── content 不是数组（字符串 / 缺失）⇒ 跳过：不算 call 也不算 result，更不能崩 ── */
    if (!Array.isArray(m.content)) continue
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]
      if (!isObj(b)) continue
      if (CALL_TYPES.has(b.type)) {
        const id = String(b.id || '')
        if (!id) continue             // 没 id 的调用配不上对，补了也白补
        calls.push({ id, name: String(b.name || ''), msgIndex: i })
        continue
      }
      if (RESULT_BLOCK_TYPES.has(b.type)) {
        sawResultBlockForm = true
        const rid = String(b.toolUseId || b.toolCallId || '')
        if (rid) {
          resultIds.add(rid)
          if (textOfContent(b.content).includes(ORPHAN_MARK)) alreadyMarked++
        }
      }
    }
  }

  const missing = calls.filter((c) => !resultIds.has(c.id))
  if (missing.length === 0) return { messages: src, repaired: [], alreadyMarked }

  /* 补哪种形态：按**实际出现过的** result 形态判。
     两种都没出现过（整串一条 result 都没有）时按 call 的块类型判：
     `tool_use`（messages/DSH）⇒ content 里的 tool_result 块；否则（toolCall/transcript）⇒ role:'toolResult' 消息。 */
  let form
  if (sawResultMessageForm && !sawResultBlockForm) form = 'message'
  else if (sawResultBlockForm && !sawResultMessageForm) form = 'block'
  else if (sawResultMessageForm && sawResultBlockForm) form = 'message'   // 两套混着：transcript 是发给 LLM 的那份，优先它
  else form = calls.some((c) => src[c.msgIndex].content.some((b) => isObj(b) && b.type === 'tool_use')) ? 'block' : 'message'

  /* 按 calls 出现顺序分组到"所属消息之后" */
  const byMsg = new Map()
  for (const c of missing) {
    if (!byMsg.has(c.msgIndex)) byMsg.set(c.msgIndex, [])
    byMsg.get(c.msgIndex).push(c)
  }
  /* 插入位置 = 该消息之后**连续 result 消息组的末尾**：
     已有结果保持原顺序在前，新增的按 call 顺序追加在后（不把既有 result 挤到后面）。 */
  const insertAfter = new Map()
  for (const msgIndex of byMsg.keys()) {
    let end = msgIndex
    while (end + 1 < src.length && isResultMessage(src[end + 1])) end++
    insertAfter.set(end, msgIndex)
  }

  const out = []
  const repaired = []
  const fallbackTs = Date.now()

  /* ── 取值规则（★L4-fix：补出来的 result 必须与真实数据**同形**，否则前端会把它当"成功"渲染） ──
     · timestamp：① 被补的那条 assistant 消息的 timestamp
                  ② 插入位置往前最近一条有 timestamp 的消息
                  ③ 都没有才用 Date.now()（**绝不填 0** —— 0 会把它排到时间轴最前面）
     · id       ：`m:<role>:<timestamp>:<下标>`，与 server.ts `pageHistory` 的惰性回填同一条规则；
                  下标用**修复后数组里的实际位置**（实测真实数据里 `m:toolResult:ts:21` 的 21
                  就是该消息在 transcript 里的下标，017237ab 已核对）。
     · turnId   ：往前找最近一条 `role==='user'` 消息，优先取它**已有的** `id`；
                  它还没有 id 就按同一条规则派生 `m:user:<ts>:<它的原始下标>`
                  （实测 017237ab：`turnId=m:user:1788855078949:19`，该 user 消息下标正是 19 ⇒ 派生与真实一致）；
                  连 timestamp 都没有 ⇒ `undefined`（**不编**，如实表示"没有轮次归属"）。 */
  const posNum = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const tsAt = (msgIndex, insertPos) => {
    const own = posNum(src[msgIndex]?.timestamp)
    if (own) return own
    for (let k = insertPos; k >= 0; k--) {
      const t = posNum(src[k]?.timestamp)
      if (t) return t
    }
    return fallbackTs
  }
  const turnIdAt = (from) => {
    for (let k = from; k >= 0; k--) {
      const m = src[k]
      if (!isObj(m) || m.role !== 'user') continue
      if (typeof m.id === 'string' && m.id) return m.id
      const t = posNum(m.timestamp)
      return t ? `m:user:${t}:${k}` : undefined
    }
    return undefined
  }

  for (let i = 0; i < src.length; i++) {
    out.push(src[i])
    if (!insertAfter.has(i)) continue
    for (const c of byMsg.get(insertAfter.get(i))) {
      /* transcript 形态：一条 `role:'toolResult'` 的**新消息**（与真实数据 9 字段同形）。
         messages(DSH) 形态：施工单规定的块对象本身就是一个 `tool_result` 块，而规则 6 要求
         "只插入新消息、不改已存在消息" ⇒ 这里把它包成**一条新消息**（role 与被补的那条同为 assistant）。
         不直接塞进原 assistant 的 content 里，就是为守住规则 6。 */
      if (form === 'message') {
        const ts = tsAt(c.msgIndex, i)
        out.push({
          role: 'toolResult',
          toolCallId: c.id,
          /* toolName 取不到 ⇒ undefined（JSON 里不出现这个键），不写空串冒充 */
          toolName: c.name || undefined,
          content: [{ type: 'text', text: ORPHAN_TEXT }],
          details: {},
          /* ★ 关键：补的是"结果未知"。缺 isError ⇒ falsy ⇒ 前端画成成功卡片 = 造假 */
          isError: true,
          timestamp: ts,
          /* 下标用"这条消息在修复后数组里的实际位置"= 即将 push 的 out.length */
          id: `m:toolResult:${ts}:${out.length}`,
          turnId: turnIdAt(c.msgIndex),
        })
      } else {
        out.push({
          role: 'assistant',
          content: [{ type: 'tool_result', toolUseId: c.id, content: ORPHAN_TEXT, isError: true }],
        })
      }
      repaired.push({ toolCallId: c.id, toolName: c.name, afterIndex: c.msgIndex })
    }
  }
  return { messages: out, repaired, alreadyMarked }
}

/** 只统计孤儿数（不修复）—— 全库扫描用 */
export function countOrphans(messages) {
  return repairOrphans(messages).repaired.length
}

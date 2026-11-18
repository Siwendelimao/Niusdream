/**
 * ★1032（P38 Step2 准备）：从 `session.messages`（DSH 视图）**重建 pi 的 transcript**。
 *
 * 背景：我们现在同时落盘两份同一段对话 —— `messages`（DSH 形状，前端契约）与 `transcript`
 * （pi 形状，模型上下文的种子）。DSH 只有一份 canonical log + 投影，ZCode 只有 message+part，
 * 都没有"第二份持久副本"。这份重建器是"删掉 transcript 落盘"的前置条件：
 * 加载时若文件里没有 transcript，就用它从 messages 还原出模型上下文。
 *
 * ⚠️ 形状以**落盘的实际数据**为准（真实样例，不是推测）：
 *   messages 的块用 `type`（落盘形态）：text / reasoning / tool_use / tool_result / image / steer…
 *   实时帧的块用 `kind`（投影形态）—— 两者是同一事实的两个视图，这里只吃 **messages 的 `type`**。
 *
 * 映射：
 *   text        → {type:'text'}
 *   reasoning   → {type:'thinking'}                 （pi 侧叫 thinking，见真实 transcript）
 *   tool_use    → {type:'toolCall', id, name, arguments=input}
 *   tool_result → 一条独立的 {role:'toolResult', toolCallId: toolUseId}
 *   image       → {type:'image', data, mimeType}
 *   steer（user 消息里的 _inject）→ 原样当 user 消息
 *   其余（subagent/notice/aside/retry/compact…）→ 不进模型上下文，计数留痕
 */

export interface RebuildStats {
  skippedTypes: Record<string, number>
  toolUseWithoutId: number
  /** tool_use 没有配对的 tool_result（模型上下文里会缺结果，属缺陷，调用方要看见） */
  unpairedToolUse: number
}

function textOfToolResult(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw)
      const arr = Array.isArray(j?.content) ? j.content : null
      if (arr) return arr.map((c: any) => String(c?.text ?? '')).join('')
      if (typeof j?.text === 'string') return j.text
    } catch {
      /* 不是 JSON：原样返回（工具结果是纯文本的情况很常见） */
    }
    return raw
  }
  if (Array.isArray(raw)) return raw.map((c: any) => String(c?.text ?? '')).join('')
  return String(raw ?? '')
}

export function rebuildTranscriptFromMessages(messages: any[], sysText?: string): { transcript: any[]; stats: RebuildStats } {
  const out: any[] = []
  const seenCalls = new Set<string>()   // 跨消息去重：老数据里同一 callId 可能重复落过块
  const seenResults = new Set<string>()
  const stats: RebuildStats = { skippedTypes: {}, toolUseWithoutId: 0, unpairedToolUse: 0 }

  if (sysText && String(sysText).trim() && messages?.[0]?.role !== 'system') {
    out.push({ role: 'system', content: String(sysText) })
  }

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '')

    if (role === 'system') {
      out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : String(m.content ?? '') })
      continue
    }

    if (role === 'user') {
      const blocks = Array.isArray(m.content) ? (m.content as any[]) : []
      const content: any[] = []
      for (const b of blocks) {
        const ty = String(b?.type || '')
        if (ty === 'text') {
          const t = String(b?.text ?? '')
          if (t) content.push({ type: 'text', text: t })
        } else if (ty === 'image' && typeof b?.data === 'string') {
          content.push({ type: 'image', data: b.data, mimeType: b.mimeType || 'image/png' })
        }
      }
      if (!content.length) continue
      out.push({
        role: 'user',
        content,
        ...(m.timestamp ? { timestamp: Number(m.timestamp) } : {}),
        ...(m.id ? { id: String(m.id) } : {}),
        ...(m.clientMessageId ? { clientMessageId: String(m.clientMessageId) } : {}),
        ...(m._inject ? { _inject: m._inject } : {}),
      })
      continue
    }

    if (role !== 'assistant') continue

    const blocks = Array.isArray(m.content) ? (m.content as any[]) : []
    /* 这条 DSH 消息会产出几条 pi 消息（1 条就沿用同一个 id；拆多条才加 #k）。
       为什么要沿用：读路径（history/实时帧）用的是 pi 消息，而 turnTiming/usage 写在 DSH 消息上，
       两边**按 id join** —— id 不一致统计就整条丢失（实测：重启后统计行空掉）。 */
    const _outStart = out.length
    let cur: any[] = []
    let openCalls = 0
    let segNo = 0
    const pendingResults: Array<{ callId: string; text: string }> = []
    /* 本轮 assistant 里 toolCall 的出现顺序：出结果时**按它排**。
       实测（0fb99fad）：messages 里 tool_result 的交错顺序可能是反的，而 pi 要求"结果顺序跟随调用顺序"。 */
    const callOrder: string[] = []
    const flushResults = () => {
      const ordered = pendingResults.slice().sort((a, b) => callOrder.indexOf(a.callId) - callOrder.indexOf(b.callId))
      for (const r of ordered) out.push({ role: 'toolResult', toolCallId: r.callId, content: [{ type: 'text', text: r.text }] })
      pendingResults.length = 0
      callOrder.length = 0
    }
    const flushAssistant = () => {
      if (!cur.length) return
      /* 确定性 id：同一条 messages 可能被拆成多条 pi 消息（工具批次），用 源id#段号 保证**每次重建都一样**，
         也让下游块有 msgId 可用（缺 id 会触发 toBlocksOf 的留痕告警）。 */
      const _sid = String(m.id || '')
      if (_sid) segNo++
      out.push({ role: 'assistant', content: cur, ...(_sid ? { id: _sid + '#' + segNo } : {}), ...(m.timestamp ? { timestamp: Number(m.timestamp) } : {}) })
      cur = []
    }

    for (const b of blocks) {
      const ty = String(b?.type || '')
      if (ty === 'text') {
        if (pendingResults.length) { flushAssistant(); flushResults() }
        const t = String(b?.text ?? '')
        if (t) cur.push({ type: 'text', text: t })
      } else if (ty === 'reasoning') {
        if (pendingResults.length) { flushAssistant(); flushResults() }
        const t = String(b?.text ?? '')
        if (t) cur.push({ type: 'thinking', text: t })
      } else if (ty === 'tool_use') {
        /* 上一批已经有结果了 ⇒ 这是**新的一批**（pi: assistant(call1) → result1 → assistant(call2)） */
        if (pendingResults.length) { flushAssistant(); flushResults() }
        const cid = String(b?.id || '')
        if (!cid) { stats.toolUseWithoutId++; continue }
        if (seenCalls.has(cid)) continue          // 同一 callId 只认一次（老数据可能重复落过块）
        seenCalls.add(cid)
        cur.push({
          type: 'toolCall',
          id: cid,
          name: String(b?.name || ''),
          arguments: (b?.input && typeof b.input === 'object') ? b.input : {},
        })
        openCalls++
        callOrder.push(cid)
      } else if (ty === 'tool_result') {
        /* ⚠️ **不能立刻 flush**：pi 的语义是"一条 assistant 带 N 个 toolCall，然后 N 条 toolResult"，
           而 messages 里是 tool_use/tool_result **交错**存的。立刻 flush 会把一批并行调用拆成 N 条 assistant
           （实测：真实 transcript 一条带 2 个 call，重建却变成 2 条各 1 个）。
           所以这里只登记结果，等"工具批次结束"（下一个非 tool 块或消息结束）再封口+出结果。 */
        const cid = String(b?.toolUseId || b?.id || '')
        if (cid && !seenResults.has(cid)) {
          seenResults.add(cid)
          pendingResults.push({ callId: cid, text: textOfToolResult(b?.content) })
          openCalls = Math.max(0, openCalls - 1)
        }
      } else if (ty === 'image' && typeof b?.data === 'string') {
        cur.push({ type: 'image', data: b.data, mimeType: b.mimeType || 'image/png' })
      } else if (ty) {
        stats.skippedTypes[ty] = (stats.skippedTypes[ty] || 0) + 1
      }
    }
    flushAssistant()
    flushResults()
    /* 只有**拆出多条 assistant** 时才加 #k；toolResult 不算（它有自己的 toolCallId 身份）。 */
    {
      const _asst = out.slice(_outStart).filter((x: any) => String(x.role) === 'assistant')
      if (m.id && _asst.length === 1) {
      /* 1:1 ⇒ 把源消息上的统计/收尾形态带过去（读路径只认消息自带，不查表、不按 ts 猜）。 */
      const src: any = m as any
      if (src.turnTiming) _asst[0].turnTiming = src.turnTiming
      if (src.usage) _asst[0].usage = src.usage
      if (src.stopReason) _asst[0].stopReason = src.stopReason
    }
    if (m.id && _asst.length > 1) {
        _asst.forEach((x: any, k: number) => { x.id = String(m.id) + '#' + (k + 1) })
      }
    }
    if (openCalls > 0) stats.unpairedToolUse += openCalls
  }

  return { transcript: out, stats }
}

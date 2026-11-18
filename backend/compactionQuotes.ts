/**
 * compactionQuotes —— 压缩时**保住用户原话**（纯函数，无 IO / 无外部依赖 / 可直接单测）
 *
 * 为什么需要它（实测，会话 b7387643）：
 *   上下文压缩把早期轮次折成摘要，而摘要是**模型自由归纳**的产物 —— 实测那份 5551 字摘要只写了
 *   任务主线（产品改名），老板同一批提报的「进度条要真实 / 版本号 / 8% 卡住 / 窗口名 / 未读不显示」
 *   一条都没进去，而那些轮次已经折叠没了 ⇒ AI 只能照摘要走 ⇒ 表现为"完全忘了我开头说的问题"。
 *
 * 口径（老实说清楚边界）：
 *   · **用户说的话是需求源，不是过程**，不能交给归纳。所以这里把用户原话**逐条原文**保留，
 *     由后端（唯一权威）拼成清单，附在摘要后面一起发给模型。
 *   · 只保留**用户消息**；注入类（后台任务完成 / 自动续跑 / 成员回归…）是系统在说话，不算诉求，
 *     由调用方用 `isInjectedUserMsg` 过滤后传进来（不在这里写第二套判据 —— 判据只能有一个）。
 *   · **优先保最早**：越早提的要求越容易被折叠吞掉（后续轮次还在保留区里，丢不掉），
 *     所以预算不够时**从最早的开始装**，装不下的更早条目不会出现（并留一行说明）。
 *
 * 为什么不把这些塞进 `contextSummary` 本体：摘要带"必须比材料短 60%"的收缩校验（见
 * summarizeOlderMessages），掺进清单会污染那次校验的语义；而且下次增量压缩会把它当旧摘要再归纳一遍。
 * 清单是**发送时附加**的独立块，摘要保持纯摘要。
 */

export interface UserQuoteOpts {
  /** 单条最多保留多少字（原话可能几千字，全留会挤爆预算） */
  maxPerItem?: number
  /** 整个清单最多多少字 */
  maxTotal?: number
}

const DEFAULT_MAX_PER_ITEM = 600
const DEFAULT_MAX_TOTAL = 12000

/** 取用户消息的可见正文：剥掉 `[[图片:N]]` / `[[文件:…]]` 位置标记（它们不是话本身），压掉多余空白 */
export function visibleUserText(msg: any): string {
  const raw = Array.isArray(msg?.content)
    ? msg.content.filter((c: any) => String(c?.type || '') === 'text').map((c: any) => String(c.text || '')).join(' ')
    : String(msg?.content || '')
  return raw
    .replace(/\[\[图片:\d+\]\]/g, '[图]')
    .replace(/\[\[文件:[^\]]+\]\]/g, '[文件]')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去重/比对用的归一化键（只用于"这条是不是已经在清单里"，不改变展示原文） */
function quoteKey(s: string): string {
  return String(s || '').replace(/\s+/g, '').slice(0, 200)
}

/**
 * 合并用户原话清单：`prev`（之前几次压缩已经收进来的）在前，`newMsgs`（本次新折叠的）在后。
 * 返回**纯文本条目数组**（不带序号 —— 序号在渲染时编，避免合并后编号错乱）。
 * 预算不够时：早的优先（见文件头说明），放不下的追加一行省略说明。
 */
export function mergeUserQuotes(prev: string[] | undefined, newMsgs: any[], opts: UserQuoteOpts = {}): string[] {
  const maxPerItem = Math.max(50, Number(opts.maxPerItem) || DEFAULT_MAX_PER_ITEM)
  const maxTotal = Math.max(500, Number(opts.maxTotal) || DEFAULT_MAX_TOTAL)
  const seen = new Set<string>()
  const out: string[] = []
  let used = 0
  let omitted = false
  const push = (text: string): boolean => {
    const t = String(text || '').trim()
    if (!t) return true
    const k = quoteKey(t)
    if (!k || seen.has(k)) return true          // 重复的诉求只留一次
    const clipped = t.length > maxPerItem ? t.slice(0, maxPerItem) + '…' : t
    if (used + clipped.length > maxTotal) { omitted = true; return false }
    seen.add(k)
    out.push(clipped)
    used += clipped.length
    return true
  }
  for (const s of (Array.isArray(prev) ? prev : [])) push(String(s || ''))
  for (const m of (Array.isArray(newMsgs) ? newMsgs : [])) {
    if (!push(visibleUserText(m))) break         // 预算满 → 后面的更晚，直接停
  }
  if (omitted) out.push('（还有用户发言超出清单预算，未能逐条列出——原文见压缩存档）')
  return out
}

/**
 * 渲染成发给模型的那一段。空清单 → 空串（不产出空标题，避免污染前缀缓存）。
 * 措辞刻意强硬：验证过的失败模式就是"摘要只写主线、把小需求整条丢掉"。
 */
export function renderUserQuotesBlock(lines: string[] | undefined): string {
  const arr = (Array.isArray(lines) ? lines : []).filter(s => String(s || '').trim())
  if (!arr.length) return ''
  const body = arr.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `\n\n【用户在已压缩范围内的原话（逐条，这是诉求源，不是过程）】\n${body}\n`
    + `★ 上面每一条都是用户明确要求过的事：接续工作时**必须逐条核对**——做到的写进已完成，没做到的写进待办，不许只盯着任务主线而漏掉其中任何一条。`
}

/**
 * 上游工具调用标记泄漏 —— 检测 / 剔除 / 工具名提取（★1013 实测立项）
 *
 * ── 现象（实测现场：会话 721b8fbe、184063d8、ce08a152）────────────────────────
 * DeepSeek 系的工具调用是**模板化文本**（私有标记，形如 `<｜｜DSML｜｜ invoke name="fs_write">`），
 * 正常由上游（官方 API / 中转）解析成结构化 `tool_calls` 再回给客户端。中转解析失败时，
 * 原始标记会**原样漏进 assistant 正文**：
 *   · 该条助手消息里 0 个结构化工具调用 ⇒ NiusDream 当"本轮终局"收尾：工具不执行、不重试、不续跑；
 *   · 日志还会打成"回复完成"（stopReason=stop 且正文尾部是 `>`，截断体检不命中）；
 *   · 坏标记留在历史里 → 模型下一轮**照抄自己的坏格式**（实测连漏 2~5 轮，不会自愈）。
 * 三次首次泄漏都紧跟"压缩写档后 9~13 秒"＝压缩后第一轮请求（详见 NIS-notes 1013 条）。
 *
 * ── 本模块职责 ─────────────────────────────────────────────────────────────
 * 只做**判断与清洗**，不含任何策略（自愈重试在 server.ts 的 finishTurn 钩子里、出站消毒在
 * messageSanitize.ts）：三个纯函数、零副作用、可单测。
 *
 * ── 标记形态（全库 264 会话扫描取到的真实码位）────────────────────────────────
 *   `<｜｜DSML｜｜`  U+3C U+FF5C U+FF5C …（双全角竖线 —— 模型"改坏"的形态，87 次，主犯）
 *   `｜｜DSML｜｜`   缺左尖括号的变体（52 次）
 *   `|DSML|` / `<|DSML|`  ASCII 竖线变体（5 次）
 *   同族还有 `<|tool_calls|>` / `<|function_calls|>`（别家中转的实现形态，一并兜住）
 *   ⚠️ 判定门槛故意收紧（见 isUpstreamLeakText）：宁可漏判也不能把"讨论这个 bug 的正文"误判成泄漏。
 */

/** 主形态：DSML 标记（全角/半角竖线、单/双、带不带尖括号都收） */
const DSML_MARK = /[<｜|]{1,4}\s*DSML\s*[｜|>]{0,4}/gi
/** 同族：tool_calls / function_calls 标记（带竖线包裹的形态） */
const ALT_MARK = /[<｜|]{1,4}\s*(?:tool[_▁\s]?calls|function[_▁\s]?calls)\s*[｜|>]{0,4}/gi
/** 结构判据：标记后面确实跟着 invoke/parameter —— 真泄漏一定有（纯提到名字的话不会有） */
const STRUCT_RE = /[｜|]{0,2}\s*(?:invoke|parameter|function)\b[^\n]{0,40}?name\s*=/i
/** 闭合行（块的结束）：… calls 收尾 */
const CLOSE_CALLS_RE = /[｜|>]{0,4}\s*(?:calls|function_calls)\s*[｜|>]{0,4}/i
/** 工具名（两套写法都收：`invoke name="x"` / `function name="x"`） */
const TOOL_NAME_RE = /(?:invoke|function)\s+name\s*=\s*["']?([A-Za-z0-9_.:-]+)/g

/** 剔除后留下的占位（给模型看=知道"那一步没执行"；给用户看=不再是乱码） */
export const LEAK_PLACEHOLDER = '（上游未把本次工具调用解析成结构化调用：原始标记已剔除）'

/** 自测开关（默认关）：NIS_LEAK_FAULT=1 时，正文出现 [[NIS-LEAK-FAULT]] 即视为泄漏。
 *  用途=真机端到端验证自愈链路（模型故意漏标记这一失败**无法按需复现**，只能注入）。
 *  只**放宽判定**，不做任何别的事；生产默认关，不影响任何正常文本。 */
const FAULT_INJECT = process.env.NIS_LEAK_FAULT === '1'
const FAULT_MARK = '[[NiusDream-LEAK-FAULT]]'

/** 去掉 ``` 围栏代码块后的副本：用于**判定**（模型在代码块里举例说明本 bug 时不该误判） */
function withoutCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '\n').replace(/`[^`\n]{0,80}`/g, ' ')
}

function countMarks(text: string): number {
  const a = text.match(DSML_MARK)
  const b = text.match(ALT_MARK)
  return (a ? a.length : 0) + (b ? b.length : 0)
}

/**
 * 这段正文是不是"上游漏出来的工具调用标记"？
 * 两种实测形态（都能命中才算数）：
 *   ① 带标记：`<｜｜DSML｜｜ invoke name="fs_write">`（实测主犯，184063d8 #74 有 10 个标记）
 *   ② **无标记**：模型"把标签写丢"后只剩裸标签 —— `<parameter name="command">…</parameter>`
 *      （实测 184063d8 #80/#82，模型自己在 #80 里承认"我在参数标签里手滑多打了一个 string=\"true\"，
 *       导致整块调用没被识别、当成普通文字漏到聊天里"）。
 * 判据（宁漏不误：正文里提一句、或在代码块/行内代码里举例说明本 bug 都不算）：
 *   ① 去掉 ``` 围栏与行内 `代码` 后的副本里，标记 ≥2 个 **且** 带 `invoke/parameter … name=`；
 *   ② 或者：**行首** `<parameter name=…` ≥2 行 **且** 有 `</parameter>` 闭合。
 */
export function isUpstreamLeakText(text: unknown): boolean {
  const s = typeof text === 'string' ? text : ''
  if (!s) return false
  if (FAULT_INJECT && s.includes(FAULT_MARK)) return true
  const scan = withoutCodeFences(s)
  /* 形态① */
  if (countMarks(scan) >= 2) {
    const hasDsl = DSML_MARK.test(scan) || ALT_MARK.test(scan)
    DSML_MARK.lastIndex = 0; ALT_MARK.lastIndex = 0
    if (hasDsl && STRUCT_RE.test(scan)) return true
  }
  /* 形态②：裸标签（无任何 DSML/tool_calls 标记） */
  const opens = scan.match(PARAM_OPEN_LINE)
  if (opens && opens.length >= 2 && /<\/parameter>/i.test(scan)) return true
  return false
}

/** 从泄漏块里提取工具名（仅用于日志/提示，取不到就给空数组） */
export function leakedToolNames(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(TOOL_NAME_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = String(m[1] || '').trim()
    if (n && !out.includes(n)) out.push(n)
    if (out.length >= 8) break
  }
  return out
}

/** 单行判定用的非全局版本（全局正则带 lastIndex，逐行复用会互相干扰） */
const DSML_LINE = /[<｜|]{1,4}\s*DSML\s*[｜|>]{0,4}/i
const ALT_LINE = /[<｜|]{1,4}\s*(?:tool[_▁\s]?calls|function[_▁\s]?calls)\s*[｜|>]{0,4}/i
/** 行首调用标签（形态②的边界：标记被模型"写丢"后只剩裸标签） */
const TAG_LINE = /^\s*<\/?(?:parameter|invoke|arguments|tool_calls|function_calls)\b/i
/** 行首 `<parameter name="…"` 开头 —— 形态②的计数用 */
const PARAM_OPEN_LINE = /^\s*<parameter\b[^\n]{0,60}?\bname\s*=/gim
const isMarkLine = (l: string): boolean => DSML_LINE.test(l) || ALT_LINE.test(l) || (FAULT_INJECT && l.includes(FAULT_MARK))

/** 逐行"是否在 ``` 围栏内"的掩码（用于挑块起点：前面若有围栏示例，别从示例里开始删） */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = []
  let inside = false
  for (const l of lines) {
    mask.push(inside)
    if ((l.match(/```/g) || []).length % 2 === 1) inside = !inside
  }
  return mask
}

/**
 * 把泄漏块从正文里**整块剔除**，换成一句可读占位；周边正文（模型那段话）原样保留。
 * 做法按行：定位块的**起点行**（形态①=带标记的行；一个标记都没有才认裸标签行）→ 向后找 `… calls` 闭合行
 * （形态②没有 calls 行 → 退化为"块内最后一个边界行"）→ 删掉 [首, 尾] 区间并插一句占位。
 * 首行若在标签前还有正文（同一行写"先定位组件：<｜｜DSML…"），保留那段前缀。
 * @returns removed=删掉的行数（0=没命中，调用方可据此跳过）；toolNames=块里出现的工具名
 */
export function stripUpstreamLeak(text: string): { text: string; removed: number; toolNames: string[]; closed: boolean } {
  const s = typeof text === 'string' ? text : ''
  if (!s) return { text: s, removed: 0, toolNames: [], closed: false }
  const lines = s.split('\n')
  const mask = fenceMask(lines)
  /* 起点：优先"带标记的行"（形态①）；一个标记都没有时才认裸标签行（形态②）。
     围栏内的行不参与起点选择（前面若有"举例说明"的代码块，别从那里开删）。
     终点的搜索**不看围栏掩码** —— 泄漏块内部的参数值可能自己带 ```，掩码在那之后就不可信了。 */
  const hasMarker = lines.some(isMarkLine)
  const isStart = (l: string): boolean => hasMarker ? isMarkLine(l) : (isMarkLine(l) || TAG_LINE.test(l))
  const isEnd = (l: string): boolean => hasMarker ? isMarkLine(l) : (isMarkLine(l) || TAG_LINE.test(l))
  let first = -1
  for (let i = 0; i < lines.length; i++) if (!mask[i] && isStart(lines[i])) { first = i; break }
  if (first < 0) return { text: s, removed: 0, toolNames: [], closed: false }
  let last = -1
  /** ★1014g：块**是否闭合** —— 流式闸门据此决定"再等等"（未闭合，继续 hold）还是"就地清洗"（已闭合）。 */
  let closed = false
  const limit = Math.min(lines.length - 1, first + 600)
  for (let i = limit; i >= first; i--) {
    if (isEnd(lines[i]) && CLOSE_CALLS_RE.test(lines[i])) { last = i; closed = true; break }
  }
  if (last < 0) {
    for (let i = limit; i >= first; i--) if (isEnd(lines[i])) { last = i; break }
  }
  if (last < 0) last = first
  const block = lines.slice(first, last + 1).join('\n')
  const head = lines.slice(0, first)
  // 首行标记前的正文前缀（同行混排）保留
  const rawFirst = lines[first]
  const cutAt = rawFirst.search(/[<｜|]{1,4}\s*DSML|<\s*\/?(?:parameter|invoke|arguments|tool_calls|function_calls)\b/i)
  const prefix = cutAt > 0 ? rawFirst.slice(0, cutAt) : ''
  const tail = lines.slice(last + 1)
  const rebuilt: string[] = [...head]
  if (prefix.trim()) rebuilt.push(prefix.replace(/\s+$/, ''))
  rebuilt.push(LEAK_PLACEHOLDER)
  rebuilt.push(...tail)
  return { text: rebuilt.join('\n'), removed: last - first + 1, toolNames: leakedToolNames(block), closed }
}

/* ══ ★1014g：流式泄漏闸门（把乱码拦在"进 turn.text"之前 ⇒ 前端/落库都干净）══════════
 *  背景（老大 1014 报"压缩后回复变乱码"）：上游偶发把工具调用**当纯文本**吐出来 ——
 *  实测泄漏那一刻的助手消息里**一个结构化 tool_use 都没有**，正文里躺着 14~29 处 `<｜｜DSML｜｜ invoke …>`。
 *  旧行为：标记原样流进 turn.text ⇒ 前端当场显示乱码，还落进历史（模型随后照抄自己的坏格式）。
 *
 *  数据（全库 274 会话）：泄漏只出现在 `commandcode.ai + deepseek/deepseek-v4.1-flash` 这个组合
 *  （12 个压缩过的会话里 2 个；同一中转换 xiaomi、其它所有 provider 压缩过 10 次都 0 泄漏）；
 *  且时间上**全部晚于 10-11 的 pi 0.84.2 → 1.1.0 升级**（09-10~10-11 之间一条都没有）。
 *  ⇒ 管不住上游，那就在我们这侧"不给它显示的机会"。
 *
 *  做法：正文里一旦出现**真标记**（正常正文几乎不可能含 `<｜｜DSML｜｜` 这种串）就从那里截住、先攒着；
 *  块闭合就清洗后放行，攒到上限或本轮结束再结算（见 settleHeldLeak）。判据全部复用上面既有函数。 */

/** 第一个标记的起始下标（-1=没有）。用非全局正则，规避 lastIndex 互相干扰。 */
function firstMarkIndex(text: string): number {
  const a = text.search(/[<｜|]{1,4}\s*DSML\s*[｜|>]{0,4}/i)
  const b = text.search(/[<｜|]{1,4}\s*(?:tool[_▁\s]?calls|function[_▁\s]?calls)\s*[｜|>]{0,4}/i)
  if (a < 0) return b
  if (b < 0) return a
  return Math.min(a, b)
}

/** 尾部"可能是标记开头、但被分片切断"的长度（0=没有）。
 *  实测踩到：delta 恰好切成 `<｜｜DS` + `ML｜｜ calls>` 两片时，两半都匹配不到完整标记 ⇒ 都被当正文漏出去。
 *  这里只认"极短的疑似前缀"（≤12 字符、且只由 `< ｜ | D S M L` 和空白组成），正常正文几乎不可能命中。 */
function tailMarkPrefixLen(text: string): number {
  const tail = text.slice(-12)
  for (let i = 0; i < tail.length; i++) {
    const frag = tail.slice(i)
    if (!/^[<｜|][<｜|DSMLdsml\s]{0,11}$/.test(frag)) continue
    return frag.length
  }
  return 0
}

/** 闸门第一步：把"待提交文本"切成「可以立刻提交的正文」+「疑似泄漏、先攒着的一截」。 */
export function leakGateSplit(text: string): { commit: string; hold: string } {
  const m = firstMarkIndex(text)
  if (m >= 0) return { commit: text.slice(0, m), hold: text.slice(m) }
  const p = tailMarkPrefixLen(text)   // ★ 标记被分片切断的情形：尾巴先扣住，等下一片补全再判
  if (p > 0) return { commit: text.slice(0, text.length - p), hold: text.slice(text.length - p) }
  return { commit: text, hold: '' }
}

/** 收尾结算：把流式期间攒着的那截洗干净。
 *  **循环剥离**（一条泄漏里常有好几个 `invoke` 块，只剥第一块会把后面的漏出去 —— 实测真样本就是多块）；
 *  不像泄漏（模型在正文里举例讨论本 bug）→ 原样放行，绝不吞正常文字。
 *  @returns text=可显示的文字（标记已换占位）；leaked=true 表示确实漏了（调用方记证据 + 触发自愈重试） */
export function cleanHeldLeak(held: string): { text: string; leaked: boolean } {
  if (!held) return { text: '', leaked: false }
  if (!isUpstreamLeakText(held)) return { text: held, leaked: false }
  let cur = held
  for (let i = 0; i < 20; i++) {
    const r = stripUpstreamLeak(cur)
    if (!r.removed) break
    cur = r.text
    if (firstMarkIndex(cur) < 0) break
  }
  /* 兜底（实测踩到）：参数里含 ``` 时 `stripUpstreamLeak` 的"代码围栏掩码"会错乱 ⇒ 个别标记行被当成
     "围栏内的示例"跳过、留在正文里。既然这一段已被判定为泄漏，就按行把**标记行及其后的标签行**扫掉。 */
  if (firstMarkIndex(cur) >= 0) {
    const MARK_LINE = /[<｜|]{1,4}\s*(?:DSML|tool[_▁\s]?calls|function[_▁\s]?calls)/i
    const TAG_LINE = /^\s*<\/?(?:parameter|invoke|arguments|tool_calls|function_calls)\b/i
    const kept: string[] = []
    let skipping = false
    for (const l of cur.split('\n')) {
      if (MARK_LINE.test(l)) { skipping = true; continue }
      if (skipping && (TAG_LINE.test(l) || l.trim() === '')) continue
      skipping = false
      kept.push(l)
    }
    cur = kept.join('\n')
  }
  return { text: cur, leaked: true }
}

/**
 * 注入消息的**唯一登记处 + 唯一判据**。
 *
 * 为什么单独成文件：这份判据有两个消费者，而它们**必须完全同口径** ——
 *   ① `server.ts`：轮次投影（`buildTurns` 的 `userTurnNoAt`）/ 删除轮 / 派活 / 上下文清洗
 *      ——决定"哪些 user 消息不算真实轮"；
 *   ② `sessionIndexCore.mjs`：建搜索索引时给每条消息打 `turn_no`。
 * 一旦两边判据不同，搜索结果里的"第 N 轮"就和界面上的"第 N 轮"对不上 ⇒ 点搜索结果跳到**错误的轮**。
 * ★1130 实测踩到过：同一个会话 API turnIndex `20/21/22/23/24` vs 索引 turn_no `25/26/31/38/43`
 * （差值递增 = 注入消息被索引算进了轮号）。
 *
 * 约定：**所有系统注入消息都以【…】开头，新加注入只改这一张表**（INJECT_MARKERS）。
 * 前缀与判定、结构化 kind、界面标签，三者同一行对齐。
 */

/**
 * 拼进「用户消息正文」的所有注入块 —— **唯一清单**，`stripInjectedLines` 由它驱动。
 *
 * 为什么要有这张表：注入块是"只给模型看的上下文"，落盘必须只剩用户原话（否则气泡里露出
 * 系统提示词/记忆/档案卡）。但拼入点在 `server.ts` 里有十几处，剥离规则原来是**手写的一长串
 * replace**，两边各自维护 ⇒ 必然漂移（实测漏过：`[系统提示：场景 = QQ单聊…]` 整段画成用户气泡，
 * 会话 8daa099c；`【核心记忆速查】` 露过一次；前端还漏了 5 个前缀）。
 *
 * 约定：**新增任何注入块 ⇒ 必须在这里加一行**（rule 是"从行首开始要吃掉的部分"）。
 * `assertInjectedPrefixes`（server.ts 用）会在开发期把"拼了却没登记"的块喊出来。
 */
const TEXT_INJECT_RULES = [
  /* 单行块：整行都是注入（含说明文字），连同换行一起吃掉 */
  /^\[模式:[^\]]+\][^\n]*\n?/,
  /^\[记忆召回\][^\n]*\n?/,
  /^\[技能指令\][^\n]*\n?/,
  /^\[项目档案卡\][^\n]*\n?/,
  /^\[上下文\][^\n]*\n?/,
  /* 多行列表块：标题行 + 紧随其后的「- xxx」条目 */
  /^\[常驻记忆\][^\n]*\n?(?:- [^\n]*\n?)*/,
  /^\[强化记忆\][^\n]*\n?(?:- [^\n]*\n?)*/,
  /^\[强化知识\][^\n]*\n?(?:- [^\n]*\n?)*/,
  /* ★1126：画像 / 项目记忆 / 项目知识 —— 本轮新加的三块（漏登记 ⇒ 实测整段露在用户气泡里）。
     · 画像与项目记忆的条目用「· 」开头；项目知识用「- 」，另有「引用规则：/可搜范围：」两行 */
  /^\[用户画像\][^\n]*\n?(?:· [^\n]*\n?)*/,
  /^\[项目记忆\][^\n]*\n?(?:· [^\n]*\n?)*/,
  /^\[项目知识\][^\n]*\n?(?:(?:- |引用规则：|可搜范围：|要原文用)[^\n]*\n?)*/,
  /* ★g4：逐行剥（不做贪婪多行：回声里下一行可能正是用户正文） */
  /^\[目标锚点\][^\n]*\n?(?:(?:进度：|验收：|⚠️ 这是硬约束)[^\n]*\n?)*/,
  /^\[验收结果\][^\n]*\n?(?:(?:末尾输出：|⚠️ 验收未通过)[^\n]*\n?)*/,
  /* ★1124y【实测：IM 通道消息整段画成用户气泡】：`buildImContext` 会拼一段以 `[系统提示：`
     开头、以 `]` 结束的**多行块**（场景/成员/工作区/回复要求），随正文一起落盘。
     到 `]` 为止整体吃掉（块内不会出现用户正文；正文在 `]\n\n` 之后）。 */
  /^\[系统提示：[\s\S]*?\]\n*/,
  /* ★1124y：定时任务把「[定时任务「名字」· 每天 09:00] 」拼在 prompt 前面（server.ts 的 setTaskRunner） */
  /^\[定时任务「[^」]*」[^\]]*\]\s*/,
  /* ★1124y：技能标记 `[技能:a,b] 用户正文` —— **只吃方括号本身**（后面的正文是用户原话，同一行！） */
  /^\[技能:[^\]]*\]\s?/,
]

/** 剥掉**行首**的注入行（只剥已知前缀，不贪婪 —— 下一行可能正是用户正文） */
export function stripInjectedLines(text) {
  if (!text) return text
  let t = String(text)
  for (let i = 0; i < 12; i++) {   // 块变多了（记忆三块 + 锚点 + 验收 + 系统提示…）→ 上限给够
    let n = t
    for (const re of TEXT_INJECT_RULES) n = n.replace(re, '')
    if (n === t) break
    t = n
  }
  /* 剥完块之后，行首若只剩空行 —— 那是被剥掉的块留下的间隔，不是用户正文 */
  t = t.replace(/^\n+/, '')
  /* ★1015【#6 实测：发消息气泡里露出整段「【核心记忆速查】」—— 它由 `coreDigestLine()` 拼在**尾部**，
     多行块、全角括号，上面的行首剥离对它无效 ⇒ 按"标记 → 到末尾"整体裁掉（后面不会再有用户正文）。 */
  t = t.replace(/\n*【核心记忆速查[^】]*】[\s\S]*$/, '')
  return t.trimEnd()
}

/** 开发期自检：这段文本开头是不是"没登记过的注入块"（【…】/[…] 开头但不是用户会打的字）。
 *  只喊不改数据 —— 新增注入忘了登记时，日志里能立刻看到是哪个前缀漏了。
 *  用途见 server.ts 落盘处（只在 NIS_INJECT_ASSERT=1 时调）。 */
export function unregisteredInjectPrefix(text) {
  const t = String(text || '').trimStart()
  const m = /^(【[^】]{1,24}】|\[[^\]]{1,24}\])/.exec(t)
  if (!m) return null
  const head = m[1]
  /* 登记过的（= stripInjectedLines 能吃掉）⇒ 返回 null */
  if (stripInjectedLines(t) !== t.trimEnd()) return null
  /* 消息类注入有自己的一套 INJECT_MARKERS（走 _inject 身份，不是正文剥离） */
  if (INJECT_MARKERS.some((x) => t.startsWith(x.prefix))) return null
  return head
}

/** ★1032-TM（P87，**第 1 步地基**）：注入消息的**唯一登记处** —— 前缀（=判定用）、结构化 kind、
 *  界面标签三者同一行对齐。原来只有一串前缀，界面标签由前端拿正则去聊正文里猜
 *  （`StreamTurn.noticeTitle`：`turnIndex===0` + `^【([^】]{1,12})】`）⇒ 同一件事两处判，
 *  正文格式一变就静默失配（"该弱的没弱、该有的没有"）。现在标签由后端给，前端不再解析正文。 */
export const INJECT_MARKERS = [
  /* ★1109（实测：对话流里还挂着一条「自动续跑」分隔）：
     label 给空串 ⇒ 前端按既有规则「没标签且没头像 ⇒ 不画段首」整条消失。
     ⚠️ 只清「自动续跑」这一类；后台任务通知/回访的标签有信息量，照旧。 */
  { prefix: '【自动续跑', kind: 'bg_resume', label: '' },
  /* ★1126：label 置空 —— 前缀是**身份判据**（`isInjectedUserMsg` 靠它认出"这不是用户说的"），
     不能为了去掉段首横线就把前缀删了（1124v 那么干过，结果通知被画成用户气泡）。
     横线由 label 控制：空标签 + 无头像 ⇒ 前端不画段首，与 1124v 想要的效果一致。 */
  { prefix: '【后台任务通知', kind: 'bg_notice', label: '' },
  { prefix: '【后台任务回访', kind: 'bg_revisit', label: '后台任务回访' },
  { prefix: '【分身回归', kind: 'clone_return', label: '分身回归' },
  { prefix: '【分身进度', kind: 'clone_progress', label: '分身进度' },
  { prefix: '【团队回归', kind: 'team_return', label: '团队回归' },
  { prefix: '【成员中断', kind: 'member_abort', label: '成员中断' },
  /* ★1124y：群聊插嘴（AI 主动在群里搭话）—— 它驱动一轮，但**不是用户发的**：
     落盘正文只留"群里 X 说了什么"，完整指令走 modelContext；这里登记成注入段，
     前端按通知显示（实测 357 条插嘴指令被画成用户气泡）。 */
  { prefix: '【群聊插嘴', kind: 'group_interject', label: '群聊插嘴' },
  { prefix: '【目标模式', kind: 'goal', label: '目标模式' },
  { prefix: '【团队结算异常', kind: 'team_settle_error', label: '团队结算异常' },
]

export const INJECTED_USER_PREFIXES = INJECT_MARKERS.map((x) => x.prefix)

/** 这条消息是不是"系统注入的 user 消息"（= 不是用户说的话，不算真实轮）。 */
export function isInjectedUserMsg(m) {
  if (m?.role !== 'user') return false
  /* ★1025：**结构化优先** —— 消息带 `_inject` 就一定是注入，不再看正文写了什么
     （正文承载身份是 1025 之前的老毛病）。前缀匹配只服务"1025 之前落盘的老数据"。 */
  if (m?._inject) return true
  const raw = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('') : ''
  /* ★1004：判定前先剥行首注入行（[记忆召回] 等拼在最前面会挡住前缀匹配） */
  return INJECTED_USER_PREFIXES.some((pfx) => stripInjectedLines(raw).startsWith(pfx))
}

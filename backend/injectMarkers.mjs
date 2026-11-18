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

/** 剥掉**行首**的注入行（只剥已知前缀，不贪婪 —— 下一行可能正是用户正文） */
export function stripInjectedLines(text) {
  if (!text) return text
  let t = String(text)
  for (let i = 0; i < 8; i++) {   // ★A：块变多了（强化记忆/强化知识各一块）→ 8 轮足够剥完
    const n = t.replace(/^\[模式:[^\]]+\][^\n]*\n?/, '').replace(/^\[记忆召回\][^\n]*\n?/, '').replace(/^\[技能指令\][^\n]*\n?/, '').replace(/^\[项目档案卡\][^\n]*\n?/, '').replace(/^\[常驻记忆\][^\n]*\n?(?:- [^\n]*\n?)*/, '').replace(/^\[强化记忆\][^\n]*\n?(?:- [^\n]*\n?)*/, '').replace(/^\[强化知识\][^\n]*\n?(?:- [^\n]*\n?)*/, '').replace(/^\[上下文\][^\n]*\n?/, '')
      /* ★g4：新加的两块注入 —— 按**已知前缀逐行**剥（不做贪婪多行：回声里下一行可能正是用户正文） */
      .replace(/^\[目标锚点\][^\n]*\n?(?:(?:进度：|验收：|⚠️ 这是硬约束)[^\n]*\n?)*/, '')
      .replace(/^\[验收结果\][^\n]*\n?(?:(?:末尾输出：|⚠️ 验收未通过)[^\n]*\n?)*/, '')
    if (n === t) break
    t = n
  }
  /* ★1015【#6 实测：发消息气泡里露出整段「【核心记忆速查】」—— 它由 `coreDigestLine()` 拼在**尾部**，
     多行块、全角括号，上面的行首剥离对它无效 ⇒ 按"标记 → 到末尾"整体裁掉（后面不会再有用户正文）。 */
  t = t.replace(/\n*【核心记忆速查[^】]*】[\s\S]*$/, '')
  return t.trimEnd()
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
  { prefix: '【后台任务通知', kind: 'bg_notice', label: '后台任务通知' },
  { prefix: '【后台任务回访', kind: 'bg_revisit', label: '后台任务回访' },
  { prefix: '【分身回归', kind: 'clone_return', label: '分身回归' },
  { prefix: '【分身进度', kind: 'clone_progress', label: '分身进度' },
  { prefix: '【团队回归', kind: 'team_return', label: '团队回归' },
  { prefix: '【成员中断', kind: 'member_abort', label: '成员中断' },
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

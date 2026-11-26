import { createHash } from 'node:crypto'

/** ★1124（老板拍板）：需求单的**可执行判据**。
 *  设计原则：用户不写命令、不填表 —— 判据由主 agent 从用户原话里推，写进需求单；
 *  交付后由后端（`teamV2Verifier`）自动跑，硬结果说话。没有判据 ⇒ 不自动过（如实记 needs-human）。
 *
 *  两种判据（可同时给）：
 *   · `files`   ：交付后这些文件必须存在于 attempt 工作区；可带 `contains` 做内容片段校验
 *   · `command` ：在 attempt 工作区执行的检查命令，**退出码 0 = 通过**
 *  刻意不支持"正则/脚本"这类自由发挥的东西：判据必须人能读懂、机器能复现。 */
export type TeamV2Verify = {
  files?: Array<{ path: string; contains?: string }>
  command?: string
  timeoutMs?: number
}

const VERIFY_REL = /^(?!\/)(?!.*\.\.)[^\u0000]{1,300}$/

/** 规范化 + 校验判据；返回 null = 这张单没有可执行判据（不是错误）。 */
export function normalizeTeamV2Verify(input: unknown): TeamV2Verify | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object') throw new Error('V2 verify must be an object')
  const raw = input as { files?: unknown; command?: unknown; timeoutMs?: unknown }
  const out: TeamV2Verify = {}
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.length > 20) throw new Error('V2 verify.files must be an array of 1–20 entries')
    out.files = raw.files.map((entry: any) => {
      const p = typeof entry?.path === 'string' ? entry.path.trim().replace(/\\/g, '/') : ''
      if (!p || !VERIFY_REL.test(p)) throw new Error('V2 verify.files[].path must be a relative path inside the attempt workspace')
      const contains = entry?.contains === undefined ? undefined : String(entry.contains)
      if (contains !== undefined && (!contains.trim() || contains.length > 500)) throw new Error('V2 verify.files[].contains must be 1–500 chars')
      return contains === undefined ? { path: p } : { path: p, contains }
    })
  }
  if (raw.command !== undefined) {
    const cmd = String(raw.command).trim()
    if (!cmd || cmd.length > 2000) throw new Error('V2 verify.command must be 1–2000 chars')
    out.command = cmd
  }
  if (raw.timeoutMs !== undefined) {
    const ms = Number(raw.timeoutMs)
    if (!Number.isInteger(ms) || ms < 1000 || ms > 600000) throw new Error('V2 verify.timeoutMs must be 1000–600000')
    out.timeoutMs = ms
  }
  if (!out.files?.length && !out.command) throw new Error('V2 verify needs at least one of files / command')
  return out
}

/** A source is evidence, not the identity of a work item. Different work items may cite the same text. */
export function resolveTeamV2Intake(
  sources: ReadonlyArray<{ id: string; text: string }>,
  tasks: ReadonlyArray<{ quote: string; title: string; acceptance: string; memberId: string; verify?: unknown }>,
  memberIds: ReadonlySet<string>,
) {
  /* ★1124（老板拍板）：一次派工的上限跟着**该对话团队的成员数**走（工具 schema 里已按成员数限死）；
     这里只留一个结构性防滥用上限 —— 未来团队扩到 100+ 人也不用改这行。 */
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 100) throw new Error('V2 requires 1–100 tasks')
  return tasks.map(task => {
    if (!task || typeof task.quote !== 'string' || !task.quote.trim() || task.quote.length > 2000) throw new Error('V2 requires a verbatim quote')
    /* ★1124b（老板：「该引用问题而不是去做吧这种废话」）：这里只拦**确定性的坏值** ——
       剥掉 [[图片:N]] / [[文件:…]] 占位与空白后什么都不剩，说明这段引文里没有任何可读的原文内容
       （典型：整条消息只有一张图，AI 把占位符当原话抄了）。
       不按字数门槛判"像不像废话"：「复制按钮失效」6 个字是合格原话，「让你的成员」5 个字是废话 ——
       字数分不开这两者。那属于语义判断，只由出单方按字段说明负责，后端不猜。 */
    if (!task.quote.replace(/\[\[(?:图片|文件):[^\]]*\]\]/g, '').replace(/\s+/g, '')) {
      throw new Error('V2 quote has no readable text once image/file markers are stripped; quote the user sentence that describes the requirement itself')
    }
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 240) throw new Error('V2 requires a task title')
    if (!memberIds.has(task.memberId)) throw new Error('V2 assignee is not in the team')
    const matches = sources.filter(source => source.text.includes(task.quote))
    if (matches.length !== 1) throw new Error('V2 quote must identify exactly one user message; choose a longer verbatim quote if ambiguous')
    const title = task.title.trim()
    const partKey = 'task:' + createHash('sha256').update(title).digest('hex')
    const verify = normalizeTeamV2Verify(task.verify)
    return { ...task, title, messageId: matches[0].id, partKey, ...(verify ? { verify } : {}) }
  })
}

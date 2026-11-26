/**
 * 团队 V2 · 执行身份作用域（第十三轮）
 *
 * 为什么需要它：工具进程的 pid 原来靠「成员会话 → 父会话 → 当前 running attempt」反推
 * （`runningMembers().find(memberId)`）。那是**猜**：并发/身份切换时会把 pid 记给错单，
 * 而且出错时只能吞掉。这里改成：**调度器接纳的那一单的身份，由开工边沿按会话绑定**，
 * 工具启动层原样带进进程 origin，落库时直接用这个身份，不再反推。
 *
 * 边界（必须写清，不许含糊）：
 *   · 本模块只承载"这一轮执行属于哪个 attempt"这个**事实**，不做任何推断与兜底；
 *     身份的唯一权威仍是账本（`teamV2Ledger`），这里存的是同一份事实的短途载体。
 *   · 同一成员会话同时只允许一单在跑（`ledger.start` 的 `working` 排他 + 执行器要求会话空闲），
 *     所以"会话 → attempt"是一对一的，不是"从多个 running 里挑一个"。
 *   · 绑定在 `agent_start` 写、在**这一轮结束**时按 attemptId 校验解绑：
 *     迟到的解绑不会把新一单的绑定删掉（否则旧单会把新单的 pid 抢走记到自己名下）。
 */

/** 一次团队执行的确切身份。`hostSessionId` 是持有该账本的父团队会话（找 host 用，不靠成员猜）。 */
export type TeamAttemptIdentity = { hostSessionId: string; requestId: number; attemptId: number }

const bound = new Map<string, TeamAttemptIdentity>()

function valid(id: TeamAttemptIdentity): boolean {
  return Number.isSafeInteger(id?.requestId) && id.requestId > 0 &&
    Number.isSafeInteger(id?.attemptId) && id.attemptId > 0 &&
    typeof id?.hostSessionId === 'string' && id.hostSessionId.length > 0
}

/** 开工边沿：把这一单的身份绑到该成员会话上。身份残缺**直接报错**（不接受"半个身份"）。 */
export function bindTeamAttempt(sessionId: string, id: TeamAttemptIdentity): void {
  if (!sessionId) throw new Error('Team attempt scope needs a member session')
  if (!valid(id)) throw new Error('Team attempt identity must carry hostSessionId/requestId/attemptId')
  bound.set(sessionId, { hostSessionId: id.hostSessionId, requestId: id.requestId, attemptId: id.attemptId })
}

/** 收尾：只解自己那一条（attemptId 不符 = 已换单，绑定属于新单，不动）。 */
export function unbindTeamAttempt(sessionId: string, attemptId: number): boolean {
  const cur = bound.get(sessionId)
  if (!cur || cur.attemptId !== attemptId) return false
  bound.delete(sessionId)
  return true
}

/** 工具启动层读身份。没有绑定 = 这一轮不是团队执行 ⇒ 返回 undefined（普通会话零影响）。 */
export function teamAttemptOf(sessionId: string | undefined): TeamAttemptIdentity | undefined {
  const sid = String(sessionId || '')
  return sid ? bound.get(sid) : undefined
}

/** 只读取证用（夹具/诊断）：当前全部绑定快照。 */
export function teamAttemptScopeSnapshot(): Array<{ sessionId: string } & TeamAttemptIdentity> {
  return [...bound.entries()].map(([sessionId, id]) => ({ sessionId, ...id }))
}

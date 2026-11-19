/**
 * ★m6-member-model：**成员会话"这一轮用哪个模型"的唯一决策**（老板第 6 项）。
 *
 * 为什么独立成模块（不是又一层抽象）：这个决策要能被**隔离实测**（合成模型 / 假供应商），
 * 而 `server.ts` 一被 import 就会起 HTTP 服务 ⇒ 决策逻辑留在那儿等于永远无法单测。
 * 这里只放判定本身：**依赖全部注入**（会话表、团队配置、两个解析器、落盘），
 * 生产注入真函数（server.ts 的 `MEMBER_TURN_MODEL_DEPS`），测试注入合成值 —— 同一份实现，两个注入。
 *
 * 口径（唯一）：
 *  · 触发点 = "这一轮真正取得执行权"那一刻（`runPromptCore` 队列/忙闸门之后），一轮只算一次；
 *  · `independent`：走唯一解析器；**解析不了 ⇒ 抛错（明确报不可用）**，不静默跑共享/旧覆盖；
 *  · 跟随会话：**团队里确有该成员且配置就是 shared** 时，取父会话**实际解析结果**
 *    （不是进程全局、不是本段残留覆盖）；
 *  · **配置缺失（父会话没了 / 团队没了 / 成员被删）⇒ 明确抛错**，不许降级成"跟随会话"
 *    —— 那等于拿另一个事实顶替"这个成员该用什么"（二审②）；
 *  · 强度同理（卡片里模型与强度是同一件事）；
 *  · **不碰全局模型**（成员不是用户在选全局）；
 *  · 分身（cloneN）**不归这里管**（一次性实例，另一套语义）⇒ 返回 null 维持现状。
 */

export interface MemberTurnLlm {
  model: string
  providerId: string
  /** 空 = 不固定（跟随会话时父会话也没固定 ⇒ 交给请求期全局档位，与主会话同语义） */
  effort?: string
}

export interface MemberTurnLlmDeps {
  /** 成员会话判定（生产 = memberStore.isMemberSession，全仓既有口径） */
  isMemberSession: (s: any) => boolean
  getSession: (id: string) => any
  readTeam: (id: string) => any
  /** 独立模型解析（生产 = server.ts 的 resolveTeamMemberModel：只认"已配 key+base 的供应商里的模型"） */
  resolveMemberModel: (member: any) => { providerId: string; model: string } | null
  /** 会话实际模型解析（生产 = server.ts 的 resolveSessionLlm：llmOverride > session.model+providerId） */
  resolveSessionLlm: (sessionId: string) => any
  memberName: (team: any, memberId: string) => string
}

/** 决策本体：返回 null = 不归它管（非成员会话 / 分身）。抛错 = 这一轮明确不可用。 */
export function resolveMemberTurnModel(s: any, deps: MemberTurnLlmDeps): MemberTurnLlm | null {
  if (!deps.isMemberSession(s)) return null
  const memberId = String(s.memberId || '')
  /* 分身（cloneN）不是团队成员：一次性实例，"预设/模型跟随父会话"是另一套语义
     （见 server.ts ensureMemberSession 的 P20 注释）⇒ 显式不接管，避免"成员口径"顺手改到分身。 */
  if (/^clone\d+$/i.test(memberId)) return null

  const parentId = String(s.parentSessionId || '')
  const parent: any = deps.getSession(parentId)
  const teamDef: any = parent?.teamId ? deps.readTeam(String(parent.teamId)) : null
  const member: any = (teamDef?.members || []).find((x: any) => String(x?.id || '') === memberId) || null

  if (member && String(member.modelMode || '') === 'independent') {
    const configured = String(member.modelId || '').trim()
    if (!configured) {
      throw new Error(`成员「${deps.memberName(teamDef, memberId)}」设为「独立模型」但没选模型`
        + ` —— 这一轮没有发送，请到成员卡片选一个模型或切回「跟随会话」`)
    }
    const ov = deps.resolveMemberModel(member)
    if (!ov) {
      throw new Error(`成员「${deps.memberName(teamDef, memberId)}」配置的模型「${configured}」不可用`
        + `（模型不存在，或供应商未配 Key/接口地址）—— 这一轮没有发送，请到成员卡片换成可用模型或切回「跟随会话」`)
    }
    const effort = String(member.effort || '').trim()
    return { model: String(ov.model), providerId: String(ov.providerId), ...(effort ? { effort } : {}) }
  }

  /* ── 配置缺失 = 事实缺失，**明确报**，不许降级成"跟随会话"（二审②） ──
     原实现把"成员已不在团队里"当成跟随父会话：那是拿一个**不同的事实**（父会话模型）去顶替
     "这个成员该用什么"——配置丢了/被删了就是不知道，不是"配置成了跟随"。 */
  if (!parent) {
    throw new Error(`成员会话的父会话（${parentId.slice(0, 8)}）已不存在，无法确定这一轮的模型 —— 这一轮没有发送`)
  }
  if (!teamDef) {
    throw new Error(`成员会话的父会话没有可用的团队（teamId=${String((parent as any)?.teamId || '空')}：团队被删或会话已解绑），`
      + `无法确定成员「${memberId}」这一轮用哪个模型 —— 这一轮没有发送`)
  }
  if (!member) {
    throw new Error(`成员「${memberId}」已不在团队「${String(teamDef.name || teamDef.id || '')}」里（成员被删或改过 id），`
      + `无法确定这一轮用哪个模型 —— 这一轮没有发送，请到团队/成员卡片重新配置`)
  }

  /* 走到这里 = 团队里确有该成员且不是独立模型 ⇒ 「跟随会话」是**配置本身**，用父会话实际解析结果。 */
  const pl: any = deps.resolveSessionLlm(parentId)
  if (pl && pl.needsBackgroundSetup === true) {
    throw new Error(`成员会话要跟随父会话，但父会话的模型没配好（${String(pl.reason || '后台模型未配置')}）—— 这一轮没有发送`)
  }
  if (!pl || !String(pl.model || '').trim() || !String(pl.providerId || '').trim()) {
    throw new Error('成员会话要跟随父会话，但父会话没有可用的模型（这一轮没有发送，请先在会话里选一个模型）')
  }
  const effort = String(parent?.effort || '').trim()
  return { model: String(pl.model), providerId: String(pl.providerId), ...(effort ? { effort } : {}) }
}

/** 决策 + 落到本轮会话上（写 `model/modelProviderId/effort`，清残留 `llmOverride/llmOverrideBy`）。
 *  ⚠️ 只接受**已经解析好的**决策（`resolveMemberTurnModel` 的结果）：
 *  调用方必须先解析、用同一个结果过完发送前的门禁（上下文/附件/窗口），**再**调本函数落库 ——
 *  否则会出现"按一个模型判是否发送、按另一个模型真正发送"（打回点 1）。
 *  落盘失败由调用方注入的 persist 自己处理，不在这里吞别的错。 */
export function applyResolvedMemberTurnModel(
  s: any,
  r: MemberTurnLlm,
  persist?: () => void,
): MemberTurnLlm {
  s.model = r.model
  s.modelProviderId = r.providerId
  if (r.effort) s.effort = r.effort
  else delete s.effort
  /* 残留覆盖必须清：`resolveSessionLlm` 的第一优先级就是 llmOverride，
     留着 = 本轮决策被上一轮身份的事实静默盖掉（独立→跟随 的残留病根）。 */
  delete s.llmOverride
  delete s.llmOverrideBy
  if (persist) persist()
  return r
}

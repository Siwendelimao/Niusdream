/* ============================================================================
 * runVerdict.ts —— **一趟执行（团队 run / 分身 run）终态判决的唯一口径**
 *
 * 为什么要单独一个文件（f1b / a2x 报的 P0）：
 *   同一个 run 原来有两套判据 ——
 *     · teamRuntime.runStepTask 收尾：只看 `runRec.llmFailed` 就写 status:'done'
 *     · cloneRuntime.runCloneOnce：只看 `String(step.result).trim()` 非空就 ok:true
 *   ⇒ 用户看到气泡「完成」，主 agent 那批却收到「失败」（或反过来），两边谁都不算错，
 *     因为判的是两件不同的事。现在收敛成一条：**「没报错」且「有产出」才叫成功**。
 *
 * ★gx2（a2x 的 P1「编造产出算成功」）：判据只看「一段文字」的时候，"我完成了、产物见
 *   xxx.md"这种话和真产出长得一模一样。这里再加一层**证据分级 + 产物声明核验**：
 *     · evidence='artifacts'：汇报带了真实产物申报（bb_write 的 artifacts）——最硬的证据；
 *     · evidence='text'     ：只有文字产出（纯调研/纯分析本来就没文件，**照样算成功**）；
 *     · evidence='none'     ：什么都没有 ⇒ 不算成功（原 no_output）。
 *   另：`checkArtifactClaims`（分身路径开启）会扫汇报里"已写入/已生成 xxx.md"这类**既成事实**
 *   的文件产出声明 —— 申报的 artifacts 里没有、磁盘上也不可能有时，判 `claim_unverified`
 *   （分身是只读容器：工具白名单不含 fs_write/fs_edit/run_command，说出这种话一定是编的）。
 *   注意两个刻意的设计：
 *     ① **不一刀切要求必须有文件**（否则所有纯调研分身全挂）；
 *     ② 只认"已…"这类**完成态**动词，且排除"建议/可以/应该/下一步…"这类**建议态**语境，
 *        因为分身读代码时天然会说"建议改 cloneRuntime.ts:241"，那不是产出声明。
 *
 * 纯函数、零依赖（不 import 任何运行时模块）：团队路径与分身路径都 import 它，
 * 测试也能直接 import 真代码，不用在测试里抄一份逻辑。
 * ========================================================================== */

/** 成员汇报里的「遇阻/无法完成」类措辞 —— 命中即不算成功（0927 netfix clone-block-0927 的原判据）。 */
export const RUN_BLOCK_RE = /无法解决|无法继续|无法完成|缺少?(权限|信息|凭据)|方向不明|已中止|被中止|挂死|多次失败/

/** 产出证据等级。'text' 是正常任务（调研/分析），不是缺陷。 */
export type RunEvidence = 'artifacts' | 'text' | 'none'

/** ★by1（乙案）新增 'partial'：**没有显式终态声明**（bb_write 的 finish:true）却又不是自然结束
 *  （被中断/被看门狗掐断）⇒ 只有半截产出，不能当完成。它是"半途汇报被当完工"的结构性出口。 */
export type RunOutcomeReason = 'ok' | 'aborted' | 'llm_failed' | 'no_output' | 'blocked' | 'claim_unverified' | 'partial'

export interface RunVerdictInput {
  /** 非空 = LLM 层重试耗尽/报错（`runRec.llmFailed.reason`，形如 `[NIS-ERR]429...`） */
  llmFailed?: any
  /** run 记录当前终态（'done' / 'error' / 'interrupted' / …）。'error' 视为执行路径已判失败。 */
  runStatus?: string
  /** 产出正文：团队路径传 `finalTextOut`（正文，为空时已用 bb_write 汇报摘要兜底）；分身路径传 `step.result`（空则退到 run 正文） */
  output?: any
  /** 用户明确中止（cloneRuntime 的 abortedSince）—— 中止不算失败，交给失败链单独处理（不许重派） */
  aborted?: boolean
  /** 汇报里申报的真实产物（bb_write 的 `artifacts`；字符串 / 字符串数组 / 对象数组均可） */
  artifacts?: any
  /** 派活原文（可选，目前只用于留痕；不参与判决，避免"任务没写清就判失败"） */
  task?: string
  /** 是否核验"声称产出文件"（分身路径 = true，因为分身只读、不可能产出文件）。团队默认不开。 */
  checkArtifactClaims?: boolean
  /** ★by1（乙案）：这趟 run 有没有**显式终态声明**（成员调过 `bb_write(finish:true)`）。
   *  · true      ⇒ 按原有判据走（artifacts/text/none）；
   *  · false     ⇒ 没声明过收尾：**自然结束**（run 走到 done、正文非空）照样算完成（模型只是忘了传 finish），
   *                但**被中断/掐断**（runStatus=interrupted/timeout）判 'partial'（半截产出 ≠ 交付）；
   *  · undefined ⇒ 老黑板数据（改造前没有这个字段）⇒ 一律按"自然结束"处理，语义与改造前完全一致（零迁移）。
   *  终点信号与完成判据自此分离：finish 决定"这趟是不是走到头了"，本字段只用来判"有没有走到头"。 */
  finalized?: boolean
}

export interface RunVerdict {
  ok: boolean
  reason: RunOutcomeReason
  /** 给用户/主 agent 看的说明（ok=true 时为空串） */
  detail: string
  /** ★gx2：产出证据等级（有产物 / 只有文字 / 无产出）—— 让"无产出的成功"可被识别 */
  evidence: RunEvidence
  /** ★gx2：申报的真实产物（去重后的路径列表） */
  artifacts: string[]
  /** ★gx2：汇报里"声称写/生成了某个文件"的路径（只在 checkArtifactClaims 时有值） */
  claims: string[]
  /** ★gx2：true = 有文件产出声明但拿不出产物（= 编造风险，已经不让它算成功） */
  claimUnverified: boolean
}

/** 有没有产出（去空白后非空）。 */
export function hasRunOutput(v: any): boolean {
  return String(v ?? '').trim().length > 0
}

/* ────────────────────────── 产物申报 / 声明核验 ────────────────────────── */

const FILE_EXT = 'md|markdown|txt|ts|tsx|js|jsx|vue|json|py|sh|cjs|mjs|css|scss|html|ya?ml|sql|log|csv|toml|ini'
const FILE_TOKEN = `[A-Za-z0-9_./\\\\-]+\\.(?:${FILE_EXT})`
/** 只认**完成态**动词（"已写入/已生成…"）。"建议/可以…修改 xxx.ts"这种建议态不算产出声明。 */
const PERFECTIVE = '已写入|写入了|已创建|创建了|已保存|保存到|已生成|生成了|已修改|已新建|新建了|已落地|已落盘|已导出|已输出|已补充|已更新'

/** "已写入 xxx.md" / "产物：xxx.md" 两类声明。g 标志，用前必须重置 lastIndex（每次新建更稳）。 */
export const ARTIFACT_CLAIM_RES: RegExp[] = [
  new RegExp(`(?:${PERFECTIVE})[^\\n。；]{0,24}?(${FILE_TOKEN})`, 'gi'),
  new RegExp(`(?:产物|产出物|交付物|产出文件|输出文件|生成物)[：:\\s]*[^\\n。；]{0,40}?(${FILE_TOKEN})`, 'gi'),
]

/** 命中位置前面若出现这些词，说明是"建议/计划"而不是"已经做了" —— 丢弃。 */
const SUGGEST_BEFORE = /(建议|可以|应该|需要|请|是否|待|将要|下一步|如需|若要|计划|拟|尚未|还没)[^。\n]{0,10}$/

function normPath(p: any): string {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^"|"$/g, '').toLowerCase()
}

/** 把 bb_write 的 artifacts 参数归一成路径字符串数组（兼容字符串/数组/对象）。 */
export function normalizeArtifacts(v: any): string[] {
  const raw: any[] = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[;,\n]/) : (v ? [v] : []))
  const out: string[] = []
  const seen = new Set<string>()
  for (const it of raw) {
    const s = typeof it === 'string'
      ? it
      : String((it && (it.path || it.file || it.name || it.url || it.title)) || '')
    const n = normPath(s)
    if (!n) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(String(s).trim())
  }
  return out
}

/** 声明里提到的文件，是否被申报的 artifacts 覆盖（按全路径 / basename 双向匹配）。 */
export function isClaimVerified(claim: string, artifacts: string[]): boolean {
  const c = normPath(claim)
  if (!c) return true
  const base = c.split('/').pop() || c
  return artifacts.some((a) => {
    const na = normPath(a)
    if (!na) return false
    const ab = na.split('/').pop() || na
    return na === c || ab === base || na.endsWith('/' + c) || c.endsWith('/' + na)
  })
}

/** 从汇报正文里抽出"声称已经产出文件"的路径（建议态语境自动排除）。 */
export function extractArtifactClaims(text: any): string[] {
  const src = String(text ?? '')
  if (!src.trim()) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const re of ARTIFACT_CLAIM_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const path = String(m[1] || '')
      if (!path) continue
      const before = src.slice(Math.max(0, m.index - 16), m.index)
      if (SUGGEST_BEFORE.test(before)) continue
      const n = normPath(path)
      if (seen.has(n)) continue
      seen.add(n)
      out.push(path)
    }
  }
  return out
}

/* ───────────────────────────── 唯一判决函数 ───────────────────────────── */

/** ★唯一判决：`ok = !中止 && !LLM报错 && run终态非error && (没被中断 || 已声明 finish:true) && 有产出 && 产出里没写"遇阻" && （开了核验时）没编造文件产出`。
 *  ★by1（乙案）：最后加的 `finalized` 维度 —— 见 RunVerdictInput.finalized 的三态说明。 */
export function judgeRunOutcome(input?: RunVerdictInput | null): RunVerdict {
  const out = String(input?.output ?? '').trim()
  const runStatus = String(input?.runStatus ?? '')
  const llmFail = String(input?.llmFailed ?? '').trim()
  const artifacts = normalizeArtifacts(input?.artifacts)
  const evidence: RunEvidence = artifacts.length ? 'artifacts' : (out ? 'text' : 'none')
  const base = { evidence, artifacts, claims: [] as string[], claimUnverified: false }
  if (input?.aborted) return { ok: false, reason: 'aborted', detail: '用户中止：这趟不算失败，交给失败链按中止处理（不重派）', ...base }
  if (llmFail) return { ok: false, reason: 'llm_failed', detail: llmFail, ...base }
  if (runStatus === 'error') return { ok: false, reason: 'llm_failed', detail: '这趟 run 的终态是 error（执行路径已判定失败）', ...base }
  /* ★by1（乙案）：**没声明收尾 + 不是自然结束** ⇒ partial。
     判据只看两个事实：run 的终态（谁掐的）与 finalized（成员有没有自己说做完），不猜文本。
     （自然结束 = runStatus 'done'/空，落不到这里；用户中止已在上面的 aborted 分支返回。） */
  if (input?.finalized === false && (runStatus === 'interrupted' || runStatus === 'timeout')) {
    return {
      ok: false,
      reason: 'partial',
      detail: `这趟在执行途中被中断（run 终态 ${runStatus}），成员也**没有**用 bb_write(finish:true) 声明做完` +
        `——只有半截产出（${out.length} 字），不能当完成。重派时把上次跑到的位置写进任务单，别让它重头再来。`,
      ...base,
    }
  }
  if (!out) return { ok: false, reason: 'no_output', detail: '本趟没有任何产出（既没发正文、也没 bb_write 汇报）——不能当完成', ...base }
  if (RUN_BLOCK_RE.test(out.slice(0, 400))) return { ok: false, reason: 'blocked', detail: `成员汇报里写明遇阻：${out.slice(0, 120)}`, ...base }
  /* ★gx2：编造识别 —— 只对"声称已产出文件"这种硬话做核验（整篇扫，不只看前 400 字）。 */
  if (input?.checkArtifactClaims) {
    const claims = extractArtifactClaims(out)
    const unverified = claims.filter((c) => !isClaimVerified(c, artifacts))
    if (unverified.length) {
      return {
        ok: false,
        reason: 'claim_unverified',
        detail: `汇报里声称已经产出文件（${unverified.slice(0, 3).join('、')}${unverified.length > 3 ? ' 等' : ''}），` +
          `但 artifacts 里一个都没有 —— 这个容器改不了文件（工具白名单不含 fs_write/fs_edit/run_command），` +
          `「已写入/已生成」无法被验证，不能当完成。要么别声称产出文件，要么把真实产物写进 bb_write 的 artifacts。`,
        evidence, artifacts, claims, claimUnverified: true,
      }
    }
    return { ok: true, reason: 'ok', detail: '', evidence, artifacts, claims, claimUnverified: false }
  }
  return { ok: true, reason: 'ok', detail: '', ...base }
}

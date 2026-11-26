/* LLM 调用失败的**唯一判定源**（纯函数，无 IO / 无外部依赖 / 可直接单测）。
 *
 * 为什么要有这个文件：以前是两套独立逻辑 ——
 *   `classifyLlmFailure()`  判"要不要重试"（一份 fatal 名单 + 一份网络名单）
 *   `terminalErrorHintBase()` 判"用户看到什么话"（12 条各自的独立正则）
 * 两套各改各的，必然出现"文案说限流、行为按未知档"这种自相矛盾。
 * 现在**一次分类同时给出**：
 *   · kind     —— 这是哪一类错（决定文案）
 *   · verdict  —— 要不要重试（fatal / retry / retry-unknown）
 *   · retryCap —— 最多几轮
 * 文案与行为都由同一份结果派生，不可能再说一套做一套。
 *
 * ★1124c 顺带修两条规则（老板实测）：
 *  ① `upstream attempt timed out` 没有状态码、却含 `upstream` 字样 → 被 5xx 分支抢走，
 *     用户看到"供应商网关故障(5xx)，去看状态页"，其实只是请求超时。现在 timeout 独立成类，排在 5xx 之前。
 *  ② 400 原来一律 fatal。老板实测"偶发 400，重新发就正常" ⇒ 400/422 先查确定性名单
 *     （上下文超限 / max_tokens / 内容安全…命中照旧立即停），**认不出的**给 2 轮短重试
 *     （5s+10s≈15s），既不白等 4 分钟，也不把偶发抖动当死刑。
 */

/** 退避阶梯（毫秒）——全项目唯一一份；server.ts 也 import 这里，避免两份常量漂移。 */
export const RETRY_LADDER_MS = [5000, 10000, 30000, 60000, 120000]
/** 认不出的错误：可重试但封顶 4 次（5/10/30/60s≈105s，够等一次抖动恢复）。 */
export const UNKNOWN_RETRY_CAP = 4
/** 认不出的 400/422：只给 2 轮（5s+10s≈15s）——偶发抖动够试出来，又不至于像超限那样白等。 */
export const BAD_REQUEST_RETRY_CAP = 2

export type FailKind =
  | 'abort'             // 主动中止（用户点停止 / 审批连续超时停轮）
  | 'quota'             // 402 额度/余额不足
  | 'plan'              // 403 套餐不含该模型 / 没权限
  | 'auth'              // 401 鉴权失败
  | 'model-missing'     // 404 模型不存在/已下架
  | 'content-filter'    // 供应商内容安全拦截
  | 'ctx-overflow'      // 上下文/输入超限
  | 'max-tokens'        // max_tokens 越界
  | 'bad-params'        // 其他参数非法（400/422）
  | 'rate-limit'        // 429 限流
  | 'upstream-5xx'      // 5xx 网关/服务端故障
  | 'upstream-timeout'  // 上游超时（多为无状态码）
  | 'network'           // 网络层中断（连接被掐/解析失败）
  | 'unknown'           // 两个名单都没命中

export type FailVerdict = 'fatal' | 'retry' | 'retry-unknown'

export interface FailureClass {
  kind: FailKind
  verdict: FailVerdict
  /** 最多重试几轮（fatal=0）。调用方直接用，不再自己算。 */
  retryCap: number
}

/** 收尾状态（决定文案怎么说这次失败）：
 *  · fatal       —— 确定性错误，本来就不重试；
 *  · exhausted   —— 真的按阶梯重试过 N 轮仍失败（N 由调用方给，不写死）；
 *  · interrupted —— 这一轮已经往界面输出过内容，为避免文本重复从设计上就不重试。 */
export type ErrMode = 'fatal' | 'exhausted' | 'interrupted'
export type ErrHint = { short: string; full: string }

const FATAL = (kind: FailKind): FailureClass => ({ kind, verdict: 'fatal', retryCap: 0 })
const RETRY = (kind: FailKind): FailureClass => ({ kind, verdict: 'retry', retryCap: RETRY_LADDER_MS.length })
const RETRY_UNKNOWN = (kind: FailKind, cap: number): FailureClass => ({ kind, verdict: 'retry-unknown', retryCap: cap })

/** 从错误文本里取 HTTP 状态码 —— 判定用，只认明确形态，避免把 token 数（1048576 之类）当码。 */
export function httpCodeOf(msg: string): number {
  const raw = String(msg || '')
  const head = /^\s*(\d{3})\s*:/.exec(raw)              // '429: {...}'
  if (head) return Number(head[1])
  const j = /"(?:code|status|status_code)"\s*:\s*"?(\d{3})"?/i.exec(raw)   // {"code":429}
  if (j) return Number(j[1])
  const sc = /\b(?:status(?:\s*code)?|http)\s*[:=]?\s*(\d{3})\b/i.exec(raw) // status 429
  if (sc) return Number(sc[1])
  return 0
}

/** 从错误原文里抠**真实 HTTP 状态码**（给用户看的前缀用）。
 *  绝不按裸数字判 —— 错误正文里全是 token 数（1048576 / 393216…）。
 *  这里认五种**带上下文**的写法：① `401: {...}` ② `{"status":401}` ③ `status 401`
 *  ④ `HTTP/1.1 401` ⑤ `401 Unauthorized`。解析不出就返回 0，绝不编一个码。 */
export function extractHttpCode(msg: string): number {
  const raw = String(msg || '')
  const pats = [
    /^\s*(\d{3})\s*:/,
    /"?(?:status|status_?code|error_?code|code)"?\s*[:=]\s*"?(4\d\d|5\d\d)"?/i,
    /\b(?:status|status_?code|error_?code)\b\s*[:=]?\s*"?\b(4\d\d|5\d\d)\b/i,
    /\bHTTP[\s/]?(4\d\d|5\d\d)\b/i,
    /\b(4\d\d|5\d\d)\b\s*[:\-]?\s*(Unauthorized|Forbidden|Not Found|Bad Request|Payment Required|Too Many Requests|Request Timeout|Internal Server Error|Bad Gateway|Service Unavailable)\b/i,
  ]
  for (const p of pats) {
    const m = p.exec(raw)
    if (m) { const c = Number(m[1]); if (c >= 400 && c < 600) return c }
  }
  return 0
}

/** 主动中止不是网络故障（0904/0926/1004 连续三次实测的坑：`Request was aborted` 被当成网络层中断）。 */
const ABORT_RE = /\brequest\s+(?:was\s+|is\s+)?abort(?:ed)?\b|^\[aborted\]|aborted by user|err_canceled|cancell?ed by user/i

/* 确定性错误（命中即停，重试无用）—— **顺序即优先级**，前面的命中就不看后面
   （如 403 token plan 不会被"模型不存在"抢走；`invalid model` 归模型类而不是参数类）。 */
const FATAL_PATTERNS: Array<[FailKind, RegExp]> = [
  ['quota', /insufficient\s+(credits?|quota|balance)|quota\s+exceeded|exceeded your (current )?quota|payment required|欠费|余额不足|额度不足|积分不足/],
  ['plan', /token plan|permission_denied|permission denied|not available in the current|upgrade your (plan|subscription)|no access to (this )?model|does not have (access|permission)/],
  ['auth', /unauthorized|invalid api key|incorrect api key|invalid_api_key|authentication/],
  ['model-missing', /model.{0,40}(not found|does not exist|no such|unknown|invalid|is not supported|deprecated|has been deprecated)|model_not_found|no such model|unknown model|unsupported_model|invalid model|modeldeprecated/],
  ['content-filter', /content[_ -]?(filter|policy|management)|responsibleai|sensitive|violation|inappropriate|flagged|prohibited|违规|敏感|拦截/],
  ['ctx-overflow', /maximum context length|context[_ -]?length|context_length_exceeded|prompt is too long|too many tokens|reduce the length of the messages|input is too long|longer than maximum/],
  ['max-tokens', /max[_ ]?tokens|valid range|completion.{0,30}(too long|exceed)|output.{0,30}(too long|exceed|limit)/],
  ['bad-params', /invalid_request|invalid request|invalid parameter|bad request|malformed|missing.{0,20}(parameter|field)/],
]

/* 可重试（瞬时）——**upstream-timeout 必须在 upstream-5xx 之前**：
   `upstream attempt timed out` 含 "upstream" 但它是超时，不是 5xx。 */
const RETRY_PATTERNS: Array<[FailKind, RegExp]> = [
  ['upstream-timeout', /upstream[^.]{0,48}(?:timed?[ _-]?out|timeout)|timed?[ _-]?out[^.]{0,32}upstream|gateway[ _-]?time-?out|request time-?out|\b504\b/],
  ['rate-limit', /rate.?limit|too many requests|\btpm\b|\brpm\b|inference exceeds|try again (in|later)|concurrent/],
  ['upstream-5xx', /bad gateway|service unavailable|internal server error|overloaded|gateway.{0,20}(error|timeout)|\bupstream\b/],
]

/* 网络层错误的**具体形态**（开放集合，只能枚举常见写法）。 */
const NETWORK_TEXT = [
  'terminated', 'econnreset', 'econnrefused', 'etimedout', 'socket hang up', 'fetch failed',
  'connection reset', 'connection closed', 'network error', 'stream ended', 'premature close',
  'connection error', 'connection refused', 'connection timeout', 'connection aborted', 'econnaborted',
  'other side closed', 'undici', 'upstream connect error', 'network is unreachable',
]

/**
 * 一次分类：同时回答"这是哪类错"和"要不要重试、几轮"。
 * 判决顺序：主动中止 → 有状态码（按码）→ 确定性名单 → 瞬时名单 → 网络形态 → 未知档。
 */
export function classifyFailure(msg: string): FailureClass {
  const raw = String(msg || '')
  if (ABORT_RE.test(raw)) return FATAL('abort')
  const s = raw.toLowerCase()
  const code = httpCodeOf(raw)
  if (code) {
    if (code === 429) return RETRY('rate-limit')
    if (code === 408) return RETRY('upstream-timeout')
    if (code === 425 || code === 499) return RETRY('network')
    if (code >= 500) return RETRY('upstream-5xx')
    if (code === 401) return FATAL('auth')
    if (code === 402) return FATAL('quota')
    if (code === 403) return FATAL('plan')
    if (code === 404) return FATAL('model-missing')
    /* ★1124c（实测 09:39 那次）：410 Gone = 目标资源**永久**不可用 —— 老板那个
       `410 ModelDeprecated: longcat-2.5-free has been deprecated` 被当成"未知档"重试了 4 轮、
       白等 3 分半，供应商都明说"改用 longcat-2.5 吧"。语义与 404 同类：重试无意义。 */
    if (code === 410) return FATAL('model-missing')
    if (code === 413) return FATAL('ctx-overflow')
    /* 其余 4xx（400/422 等）：先看文本里有没有确定性证据 —— 上下文超限/max_tokens/内容安全
       这些**必须**照旧立即停（参数一字不变，重试纯粹白等）。 */
    for (const [kind, re] of FATAL_PATTERNS) {
      if (kind === 'bad-params') continue
      if (re.test(s)) return FATAL(kind)
    }
    /* ★1124c：认不出的 400/422 = 网关抽风（老板实测"重发就正常"）⇒ 2 轮短重试。
       参数真非法的情况照样命中上面的确定性名单，不会被这里放进来。 */
    if (code === 400 || code === 422) return RETRY_UNKNOWN('bad-params', BAD_REQUEST_RETRY_CAP)
    return FATAL('bad-params')
  }
  for (const [kind, re] of FATAL_PATTERNS) if (re.test(s)) return FATAL(kind)
  for (const [kind, re] of RETRY_PATTERNS) if (re.test(s)) return RETRY(kind)
  if (NETWORK_TEXT.some(k => s.includes(k))) return RETRY('network')
  return RETRY_UNKNOWN('unknown', UNKNOWN_RETRY_CAP)
}

/** 重试阶梯累计时长（分钟）——文案里的"约几分钟"跟着**真实轮数**走，不再写死。 */
export function retryLadderMinutes(retries: number): number {
  const n = Math.max(1, Math.min(retries, RETRY_LADDER_MS.length))
  return Math.round(RETRY_LADDER_MS.slice(0, n).reduce((a, b) => a + b, 0) / 60000)
}

/** 收尾短语：只说实际发生了什么。 */
export function errStopPhrase(mode: ErrMode, retries: number): string {
  if (mode === 'interrupted') return '本轮已经开始输出内容，为避免文本重复**没有自动重试**，点重试可继续'
  if (mode === 'exhausted') return `自动重试 ${Math.max(1, retries)} 轮（约 ${retryLadderMinutes(retries)} 分钟）后仍未恢复`
  return '已直接停止'
}

/**
 * 用户看到的话（short ≤60 字 + full 带怎么办）。
 * 分类**只取自 classifyFailure**，文案按 kind 出 —— 这就是"归一到一处"的落点。
 * `mode` 只影响结尾口径（真重试过 / 没重试 / 已输出未重试）。
 */
export function failureHint(msg: string, mode: ErrMode = 'fatal', retries = 0): ErrHint {
  const raw = String(msg || '')
  const { kind } = classifyFailure(raw)
  const stop = errStopPhrase(mode, retries)
  switch (kind) {
    case 'abort':
      return {
        short: '本轮已停止（你点了停止，或审批连续超时自动停轮）：不是网络问题。',
        full: '本轮已停止：**请求被主动中止**（你点了停止、或同一操作审批连续 2 次等不到授权自动停轮）——不是网络故障，无需检查网络。要继续的话重新发送指令即可（若是审批超时：先在卡片上点「允许一次」再发）。',
      }
    case 'quota':
      return {
        short: '该模型/上游额度不足（与上下文长度无关）——换个模型、换 key 或充值。',
        full: '这一步没跑起来：**该供应商的这条模型/上游额度不足**（insufficient credits / quota exceeded）——'
          + '与上下文长度、输出上限都无关，重试也不会好。'
          + '有的供应商是**按模型/上游线分池**算额度，同一个 key 换个模型可能就能跑。'
          + '所以：① 先换**同供应商的另一个模型**试试（成本最低）；② 不行就去充值/续费、查套餐状态；③ 或换 API key / 换供应商。',
      }
    case 'plan':
      return {
        short: '这个模型不在你当前套餐里（或没权限）——换模型或升级套餐。',
        full: '这一步没跑起来：**当前套餐/计划不包含这个模型**'
          + '（`model is not available in the current token plan`，403 permission_denied）——确定性错误，重试无用。'
          + '① 在「设置→供应商→模型 ✎」换一个套餐内的模型；② 或去供应商后台升级/续费套餐；③ 或换供应商。',
      }
    case 'auth':
      return {
        short: '供应商鉴权失败：去「设置→供应商」检查 API key。',
        full: '这一步没跑起来：**供应商鉴权失败**（key 无效 / 过期 / 权限不足）。去「设置→供应商」检查该供应商的 API key，'
          + '或确认这个 key 有没有开对应模型的权限。',
      }
    case 'model-missing':
      return {
        short: '模型 ID 不存在或已下架：去「设置→供应商→模型」核对模型名。',
        full: '这一步没跑起来：**模型不存在 / 已下架**（model not found）——重试无用。'
          + '① 核对模型 ID 拼写（含 `供应商/模型` 前缀）；② 去该供应商模型列表看它是否已下架/改名；③ 换一个可用模型。',
      }
    case 'content-filter':
      return {
        short: '这条内容被供应商安全策略拦下：改一下措辞再发，或换模型。',
        full: '这一步没跑起来：**触发了供应商的内容安全策略**（content_filter / policy violation）——'
          + '与技术配置无关，原样重发也不会过。① 改写措辞（尤其去掉攻击/越权/敏感表述）再试；② 或换安全策略更宽松的模型/供应商。',
      }
    case 'ctx-overflow':
      return {
        short: '输入/上下文超限：压缩或删减历史，或换更大窗口的模型。',
        full: '这一步没跑起来：**输入超过了模型的上下文/输入上限**（确定性错误，重试无用；自动纠偏会先试一次）。'
          + '① 压缩或删减本会话历史（或开新会话）；② 在「设置→供应商→模型 ✎」调小输出上限给输入腾空间；③ 换窗口更大的模型。',
      }
    case 'max-tokens':
      return {
        short: '输出上限参数越界：去「设置→供应商→模型 ✎」调小输出上限。',
        full: '这一步没跑起来：**max_tokens/输出上限超出了该模型的合法范围**（确定性错误；自动纠偏会先钳一次再试）。'
          + '① 在「设置→供应商→模型 ✎」把输出上限调进供应商报的合法范围；② 或换输出上限更高的模型/线路。',
      }
    case 'bad-params':
      return {
        short: '请求参数被供应商拒了：看原始报错，多为模型配置或会话数据问题。',
        full: `这一步没跑起来：**请求参数非法**（invalid_request / bad request）——${stop}。`
          + '常见触发：输出上限/上下文等模型配置、会话里有不被支持的内容格式、供应商改了接口口径。'
          + '① 看下面的原始报错定位；② 换个模型试（最快分辨是不是配置问题）；③ 或把这条会话的可疑内容删掉重发。',
      }
    case 'rate-limit':
      return {
        short: '供应商限流了：等一会儿再发、降并发，或找供应商提额。',
        full: `这一步没跑起来：**触发供应商限流**（429 / tpm / rpm limit）——${stop}。`
          + '① 等几十秒到几分钟再发；② 减少并发（别的会话/工人同时在跑也算）；③ 找供应商提额或换线路。',
      }
    case 'upstream-5xx':
      return {
        short: '供应商网关抖动：稍后重发，或换供应商/线路。',
        full: `这一步没跑起来：**供应商服务端/网关故障**（5xx）——${stop}。`
          + '① 稍后重发；② 看该供应商状态页是不是在宕机；③ 换供应商/线路再试。',
      }
    case 'upstream-timeout':
      /* ★1124c：超时**不是**网关宕机 —— 旧版把它算进 5xx，害用户跑去查供应商状态页。 */
      return {
        short: '上游响应超时（不是宕机）：稍后重发，或换更快的线路/模型。',
        full: `这一步没跑起来：**上游响应超时**（upstream timeout——请求发出去了，但迟迟没有响应）——${stop}。`
          + '① 这条消息重发通常就好；② 上下文很大时首 token 会慢，可先压缩历史再发；③ 换供应商/线路或换更快的模型。',
      }
    case 'network':
      return {
        short: '无状态码 · 网络中断（连接未建立）：检查网络/代理后重新发送。',
        full: `这一步没跑起来：**网络层中断，本次没有 HTTP 状态码**（连接被掐/超时/域名解析失败——请求没到达服务端，所以没有 40几/5xx 可显示）——${stop}。`
          + '① 检查本机网络/代理/VPN；② 确认供应商域名可达；③ 重发这条消息即可。',
      }
    default:
      return {
        short: '请求没跑完：看原始报错详情，或换模型/稍后再试。',
        full: `这一步没跑起来：**请求未完成**（${stop}），且错误文本不属于已知类型。`
          + '① 看下面的原始报错定位；② 换个模型试（最快分辨是配置问题还是线路问题）；③ 或稍后再发。',
      }
  }
}

/** 给用户看的短句（含真实状态码前缀）。解析不出码就原样返回，绝不编一个码出来。 */
export function hintWithCode(msg: string, mode: ErrMode = 'fatal', retries = 0): ErrHint {
  const h = failureHint(msg, mode, retries)
  const code = extractHttpCode(msg)
  if (!(code > 0)) return h
  return { short: `${code} · ${h.short}`, full: `${code} · ${h.full}` }
}

/** ★ 0930（实测反馈「不知道为啥不重试」）：把"**这一轮为什么不重试**"讲清楚。
 *  以前只丢一句"确定性错误，重试无用"，用户仍分不清是自己 key 的问题还是模型的问题；
 *  这里点名命中的是哪一类（鉴权/额度/上下文超限/输出上限/模型不存在/参数非法）。
 *  ★1124c：从 server.ts 原样搬来（行为零变化），与分类同处一个文件，改词表时不会漏。 */
export function fatalReasonPhrase(msg: string): string {
  const raw = String(msg || '')
  const s = raw.toLowerCase()
  const head = /^\s*(\d{3})\s*:/.exec(raw)
  const code = head ? Number(head[1]) : 0
  const groups: [string, string[]][] = [
    ['鉴权/权限', ['unauthorized', 'invalid api key', 'incorrect api key', 'invalid_api_key', 'authentication', 'permission denied', 'permission_denied']],
    ['额度/套餐', ['insufficient', 'token plan', 'not available in the current', 'quota']],
    ['上下文超限', ['maximum context length', 'context_length_exceeded', 'context length exceeded', 'too many tokens', 'prompt is too long', 'string too long', 'too long']],
    ['输出上限越界', ['invalid max_tokens', 'range of max_tokens', 'max_tokens must', 'max_tokens is too large']],
    ['模型不存在', ['does not exist', 'no such model', 'model not found', 'unknown model']],
    ['参数/接口不支持', ['invalid_request_error', 'invalid request', 'invalid parameter', 'unsupported', 'not supported']],
  ]
  const hit = groups.find(([, kws]) => kws.some(k => s.includes(k)))
  const why = hit ? `命中「${hit[0]}」类错误`
    : (code >= 400 && code < 500 ? `供应商返回 ${code}（4xx 确定性拒绝）` : '未识别的错误（两个名单都未命中）')
  /* ★cx1：以前兜底写「命中确定性错误」是**谎报**（它根本没认出是哪类，排查方向被带偏）。
     认得出的才说「原样重发结果一样」；认不出的老实说判据不足，并提示可能只是网络抖动。 */
  const known = !!hit || (code >= 400 && code < 500)
  return known
    ? `未重试：${why} —— 同一份请求原样重发结果一样，得先改配置 / 等额度恢复`
    : `未重试：${why} —— 判据不足，保守按确定性错误停了（疑似网络抖动请手动重跑一次）`
}

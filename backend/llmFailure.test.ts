import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFailure, failureHint, hintWithCode, extractHttpCode, retryLadderMinutes } from './llmFailure.ts'

/* 分类是"要不要重试"与"用户看到什么话"的唯一源：这份测试同时锁两件事 ——
   ① 各类错误的 verdict/retryCap（行为）
   ② 文案不再写死轮数（★1124c 老板实测的"没重试却报重试 5 轮"） */

test('主动中止优先于一切：绝不当网络故障、绝不进重试', () => {
  for (const msg of ['Request was aborted', '[aborted]', 'cancelled by user', 'ECONNRESET aborted by user']) {
    const c = classifyFailure(msg)
    assert.equal(c.kind, 'abort', msg)
    assert.equal(c.verdict, 'fatal', msg)
    assert.equal(c.retryCap, 0, msg)
    assert.match(failureHint(msg).full, /主动中止/)
  }
})

test('已知瞬时错误：满额 5 轮', () => {
  const cases: Array<[string, string]> = [
    ['429: {"message":"rate limit"}', 'rate-limit'],
    ['502 Bad Gateway', 'upstream-5xx'],
    ['status 503 service unavailable', 'upstream-5xx'],
    ['504', 'upstream-timeout'],
    ['ECONNRESET', 'network'],
    ['socket hang up', 'network'],
  ]
  for (const [msg, kind] of cases) {
    const c = classifyFailure(msg)
    assert.equal(c.kind, kind, msg)
    assert.equal(c.verdict, 'retry', msg)
    assert.equal(c.retryCap, 5, msg)
  }
})

test('★1124c：upstream timeout 不再冒充 5xx（老板截图实测 upstream attempt timed out）', () => {
  const c = classifyFailure('upstream attempt timed out')
  assert.equal(c.kind, 'upstream-timeout')
  assert.equal(c.verdict, 'retry')
  const hint = failureHint('upstream attempt timed out', 'exhausted', 5)
  assert.match(hint.full, /超时/)
  assert.doesNotMatch(hint.short, /5xx/)          // 旧文案会说"供应商服务端/网关故障(5xx)"
  assert.doesNotMatch(hint.full, /状态页/)         // 也不该再让人去查供应商是否宕机
})

test('确定性错误一律不重试', () => {
  const cases: Array<[string, string]> = [
    ['401: {"error":"invalid api key"}', 'auth'],
    ['402: insufficient credits', 'quota'],
    ['403: model is not available in the current token plan', 'plan'],
    ['404: model not found', 'model-missing'],
    ['maximum context length is 1048576 tokens', 'ctx-overflow'],
    ['400: invalid max_tokens, valid range is [1, 8192]', 'max-tokens'],
    ['400: content_filter triggered', 'content-filter'],
  ]
  for (const [msg, kind] of cases) {
    const c = classifyFailure(msg)
    assert.equal(c.kind, kind, msg)
    assert.equal(c.verdict, 'fatal', msg)
    assert.equal(c.retryCap, 0, msg)
  }
})

test('★1124c：认不出的 400/422 给 2 轮短重试（偶发 400 重发就好），确定性 400 照样立即停', () => {
  const flaky = classifyFailure('400: upstream glitch, please retry')
  assert.equal(flaky.verdict, 'retry-unknown')
  assert.equal(flaky.retryCap, 2, '400 只给 2 轮（5s+10s），不白等 4 分钟')
  assert.equal(classifyFailure('422: something odd happened').retryCap, 2)
  /* 同一批 400 里的确定性错误必须仍然立即停（否则上下文超限会白等） */
  assert.equal(classifyFailure('400: maximum context length is 1048576').verdict, 'fatal')
  assert.equal(classifyFailure('400: content_filter').verdict, 'fatal')
})

test('★1124c：410 模型已废弃 = 永久不可用，立即停（实测白等 3 分半）', () => {
  const msg = 'opencode-go API error (410): {"type":"ModelDeprecated","message":"Model longcat-2.5-free has been deprecated. Use longcat-2.5 instead."}'
  const c = classifyFailure(msg)
  assert.equal(c.kind, 'model-missing')
  assert.equal(c.verdict, 'fatal')
  assert.equal(c.retryCap, 0, '410 重试一万次也不会变成可用')
  /* 无状态码时靠关键词也要认出来 */
  assert.equal(classifyFailure('Model longcat-2.5-free has been deprecated').verdict, 'fatal')
  assert.equal(classifyFailure('{"type":"ModelDeprecated"}').kind, 'model-missing')
})

test('两个名单都没命中的兜底：可试但封顶 4 轮', () => {
  const c = classifyFailure('something entirely unexpected happened')
  assert.equal(c.kind, 'unknown')
  assert.equal(c.verdict, 'retry-unknown')
  assert.equal(c.retryCap, 4)
})

test('文案按实际重试轮数说，不再写死 5 轮（老板实测的谎报）', () => {
  const three = failureHint('502 Bad Gateway', 'exhausted', 3)
  assert.match(three.full, /自动重试 3 轮/)
  assert.doesNotMatch(three.full, /自动重试 5 轮/)
  assert.match(three.full, /约 1 分钟/, '5+10+30=45s≈1 分钟，按阶梯表算')
  /* 一轮都没重试（已开始输出内容）时说清"没重试"，不再冒充重试耗尽 */
  const none = failureHint('502 Bad Gateway', 'interrupted', 0)
  assert.match(none.full, /没有自动重试/)
  assert.doesNotMatch(none.full, /仍未恢复/)
  /* 确定性错误：文案里不该出现任何"重试 N 轮 / 仍未恢复"（本来就没重试） */
  const fatalHint = failureHint('401: invalid api key')
  assert.doesNotMatch(fatalHint.full, /自动重试/)
  assert.doesNotMatch(fatalHint.full, /仍未恢复/)
})

test('阶梯时长与真实轮数一致', () => {
  assert.equal(retryLadderMinutes(1), 0)    // 5s
  assert.equal(retryLadderMinutes(2), 0)    // 15s
  assert.equal(retryLadderMinutes(3), 1)    // 45s
  assert.equal(retryLadderMinutes(4), 2)    // 105s
  assert.equal(retryLadderMinutes(5), 4)    // 225s
})

test('状态码前缀只认带上下文的写法，绝不把 token 数当码', () => {
  assert.equal(extractHttpCode('This model\'s maximum context length is 1048576 tokens.'), 0)
  assert.equal(extractHttpCode('429: {"message":"slow down"}'), 429)
  assert.equal(extractHttpCode('HTTP/1.1 502 Bad Gateway'), 502)
  assert.equal(extractHttpCode('{"error":{"code":"500"}}'), 500)
  const h = hintWithCode('429: {"message":"slow down"}')
  assert.match(h.short, /^429 · /)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectCoordinationUsage, projectTeamV2Usage, projectVerificationUsage, type VerificationRecord } from './teamV2Usage.ts'
import type { MemberUsageSegmentRow } from './memberUsageAggregate.ts'

const row: MemberUsageSegmentRow = {
  parentSessionId: 'p', memberId: 'm1', sessionId: 'seg', seq: 1, archived: true,
  hasLedger: true, hasAssistant: true, uncached: 200, cacheRead: 100, cacheWrite: 700, output: 20, turns: 1, llmMs: 40,
}

const review = (over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  requestId: 1, providerId: 'p1', model: 'm-a',
  status: 'opinion', usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 0 },
  ...over,
})

test('parent and member ledgers are distinct; member input includes all three buckets', () => {
  const totals = projectTeamV2Usage({ uncached: 5, cacheRead: 10, cacheWrite: 5, output: 2 }, [
    row,
    row,
    { ...row, sessionId: 'dm', seq: 2, archived: false, uncached: 20, cacheRead: 80, cacheWrite: 0 },
    { ...row, sessionId: 'clone', memberId: 'clone1' },
    { ...row, sessionId: 'other', parentSessionId: 'p2' },
  ], 'p')
  assert.deepEqual(totals.main, { status: 'recorded', input: 20, output: 2, cacheRead: 10, cacheWrite: 5, hitRate: 50 })
  assert.deepEqual(totals.members, { status: 'complete', missingSegments: 0, known: { input: 1100, output: 40, cacheRead: 180, cacheWrite: 700, hitRate: 16 } })
  /* ★1124：协调从常量改成**按轮归因的真实数值**；"计入主会话"这句话挪到 inclusionNote。 */
  assert.equal(totals.inclusionNote, 'included-in-main')
  assert.equal(totals.coordination.status, 'no-records')
})

test('missing, partial, and no records are not a synthetic zero', () => {
  const missing = { ...row, sessionId: 'missing', hasLedger: false }
  const totals = projectTeamV2Usage({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, [missing, row], 'p')
  assert.deepEqual(totals.main, { status: 'unavailable' })
  assert.equal(totals.members.status, 'partial')
  assert.equal(totals.members.missingSegments, 1)
  assert.equal(totals.members.known?.input, 1000)
  assert.deepEqual(projectTeamV2Usage(undefined, [missing], 'p').members, { status: 'partial', known: null, missingSegments: 1 })
  assert.deepEqual(projectTeamV2Usage(undefined, [], 'p').members, { status: 'no-records', known: null, missingSegments: 0 })
})

test('every real C call counts once — stale opinions and failures keep their tokens', () => {
  const usage = projectVerificationUsage([
    review(),                                                                                        // 正常意见
    review({ status: 'stale', usage: { input: 50, output: 8, cacheRead: 0, cacheWrite: 0 } }),        // 意见过期
    review({ status: 'invalid-output', usage: { input: 30, output: 5, cacheRead: 10, cacheWrite: 0 } }), // 输出非法
    review({ status: 'model-error', usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),  // 模型报错但有用量
  ])
  assert.equal(usage.status, 'recorded')
  assert.equal(usage.calls, 4)
  assert.equal(usage.withUsage, 4)
  assert.equal(usage.unknownUsage, 0)
  // 四桶互斥相加：input 200 / cacheRead 50 / cacheWrite 0 / output 23；命中率按累计分子分母
  assert.deepEqual(usage.known, { input: 250, cacheRead: 50, cacheWrite: 0, output: 23, hitRate: 20 })
})

test('a call without a usage receipt is incomplete, never a zero', () => {
  const usage = projectVerificationUsage([review(), review({ status: 'model-error', usage: null })])
  assert.equal(usage.status, 'partial')
  assert.equal(usage.calls, 2)
  assert.equal(usage.withUsage, 1)
  assert.equal(usage.unknownUsage, 1)
  assert.deepEqual(usage.known, { input: 140, cacheRead: 40, cacheWrite: 0, output: 10, hitRate: 29 })
  const none = projectVerificationUsage([review({ usage: null })])
  assert.equal(none.status, 'partial')
  assert.equal(none.known, null, '一个回执都没有时不能报 0 用量')
  // 调用前就阻断的（证据不可信/预算不足）根本不写账本 ⇒ 不在记录里，也就不会出现在这里
  assert.deepEqual(projectVerificationUsage([]), {
    status: 'no-records', calls: 0, withUsage: 0, unknownUsage: 0, known: null, models: [], byRequest: {},
  })
})

test('C usage is attributed per work item and keeps the model that actually ran', () => {
  const usage = projectVerificationUsage([
    review({ requestId: 1, providerId: 'p1', model: 'old-model' }),
    review({ requestId: 2, providerId: 'p2', model: 'new-model', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    review({ requestId: 1, providerId: 'p2', model: 'new-model', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }),
  ])
  assert.deepEqual(Object.keys(usage.byRequest).sort(), ['1', '2'])
  assert.deepEqual(usage.byRequest[1], { calls: 2, withUsage: 2, unknownUsage: 0, known: { input: 150, cacheRead: 40, cacheWrite: 0, output: 11, hitRate: 27 } })
  assert.deepEqual(usage.byRequest[2], { calls: 1, withUsage: 1, unknownUsage: 0, known: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, hitRate: 0 } })
  // 换模型后旧执行仍显示旧模型（模型身份来自那次执行，不读当前配置）
  assert.deepEqual(usage.models.map(m => [m.providerId, m.model, m.calls]), [['p1', 'old-model', 1], ['p2', 'new-model', 2]])
  assert.throws(() => projectVerificationUsage([review({ model: '' })]), /model identity/)
  assert.throws(() => projectVerificationUsage([review({ requestId: 0 })]), /owner/)
})

test('cache writes are their own bucket, and the full input includes all three', () => {
  /* pi-ai 的 `input` 是**未命中**输入（openai-completions.js:1164-1188 会扣掉 cacheRead/cacheWrite），
     所以四桶互斥：input 30 / cacheRead 20 / cacheWrite 50 / output 7 ⇒ 完整输入 100。 */
  const usage = projectVerificationUsage([review({ usage: { input: 30, output: 7, cacheRead: 20, cacheWrite: 50 } })])
  assert.deepEqual(usage.known, { input: 100, output: 7, cacheRead: 20, cacheWrite: 50, hitRate: 20 })
  assert.equal(usage.known.hitRate, Math.round(20 / 100 * 100), '命中率分母 = 未命中+缓存读+缓存写')
  // 全是缓存写、未命中为 0 也不能被当成"没有用量"
  const writeOnly = projectVerificationUsage([review({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 40 } })])
  assert.equal(writeOnly.status, 'recorded')
  assert.deepEqual(writeOnly.known, { input: 40, output: 0, cacheRead: 0, cacheWrite: 40, hitRate: 0 })
})

test('team totals keep A, members and C apart — C is added exactly once', () => {
  const parent = { uncached: 5, cacheRead: 10, cacheWrite: 5, output: 2 }
  const without = projectTeamV2Usage(parent, [row], 'p', [])
  const withC = projectTeamV2Usage(parent, [row], 'p', [review(), review({ requestId: 2 })])
  assert.deepEqual(withC.main, without.main, 'C 不能改 A 的累计')
  assert.deepEqual(withC.members, without.members, 'C 不能改成员的累计')
  assert.equal(withC.verification.calls, 2)
  assert.deepEqual(withC.verification.known, { input: 280, cacheRead: 80, cacheWrite: 0, output: 20, hitRate: 29 })
  assert.equal(without.verification.status, 'no-records')
})

test('coordination usage is attributed by turn: a turn that called a team tool counts whole', () => {
  /* ★1124（老板要真实数值）：一轮里只要出现 team_v2_* 工具调用，该轮 assistant 消息的 usage 整轮计入协调；
     同轮混用（既调团队工具又读文件）也整轮算；没调团队工具的那一轮不算。 */
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '派两单' }] },
    {
      role: 'assistant', usage: { input: 1000, output: 100, cacheRead: 400 }, content: [
        { type: 'toolCall', name: 'team_v2_dispatch', arguments: {} },
        { type: 'toolCall', name: 'fs_read', arguments: {} },
      ],
    },
    { role: 'assistant', usage: { input: 500, output: 50, cacheRead: 0 }, content: [{ type: 'text', text: '已派发' }] },
    { role: 'user', content: [{ type: 'text', text: '顺便看下这个文件' }] },
    { role: 'assistant', usage: { input: 800, output: 80, cacheRead: 0 }, content: [{ type: 'toolCall', name: 'fs_read', arguments: {} }] },
  ]
  const c = projectCoordinationUsage(messages)
  assert.equal(c.turns, 1, '只有第一轮是协调轮')
  assert.equal(c.calls, 1)
  assert.equal(c.status, 'recorded')
  assert.deepEqual(c.known, { input: 1500, output: 150, cacheRead: 400, cacheWrite: 0, hitRate: 27 },
    '协调轮的两条 assistant 消息都要计入：input = 未命中(600+500) + 缓存读 400 = 1500')

  const none = projectCoordinationUsage([
    { role: 'user', content: [] },
    { role: 'assistant', usage: { input: 1, output: 1 }, content: [] },
  ])
  assert.equal(none.status, 'no-records', '没有协调轮次就说没有')
  assert.equal(none.known, null)

  const unknown = projectCoordinationUsage([
    { role: 'user', content: [] },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'team_v2_status', arguments: {} }] },
  ])
  assert.equal(unknown.status, 'unavailable', '有协调轮但没 usage 回执 ⇒ 未知，不拿 0 冒充')
  assert.equal(unknown.known, null)
})

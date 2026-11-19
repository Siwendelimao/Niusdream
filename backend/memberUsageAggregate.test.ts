import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregateMemberUsage,
  collectMemberUsageViews,
  mergeViewsIntoMemberTotals,
  applyUsageViewToRecord,
  pickCurrentRow,
  type MemberUsageSegmentRow,
} from './memberUsageAggregate.ts'

/** 造一段（默认：父会话 P1 / 成员 m1 / 账本在 / 未归档）。合成 fixture，不读盘、不连供应商。 */
function seg(over: Partial<MemberUsageSegmentRow> & { sessionId: string }): MemberUsageSegmentRow {
  return {
    parentSessionId: 'P1',
    memberId: 'm1',
    seq: 1,
    archived: false,
    updatedAt: 1,
    hasLedger: true,
    hasAssistant: true,
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    turns: 1,
    llmMs: 0,
    ...over,
  }
}

test('按输入 token 加权：90/100 + 10/900 = 10%（不是各段百分比取平均 45.6%）', () => {
  /* 段1：read 90 / 未命中 10（写 0）；段2：read 10 / 未命中 890（写 0）。
     Σ读=100，Σ未命中=900，Σ写=0 ⇒ 100/(900+100+0) = 10%。
     ⛔ 平均 = (90 + 1.11)/2 ≈ 45.6% —— 差 35pp，正是"段长不等时不能平均"的反例。 */
  const v = aggregateMemberUsage([
    seg({ sessionId: 's1', cacheRead: 90, uncached: 10 }),
    seg({ sessionId: 's2', seq: 2, cacheRead: 10, uncached: 890 }),
  ])
  assert.equal(v.hitDenominator, 1000)      // 900 + 100 + 0（分母 = 完整输入量）
  assert.equal(v.hitRate, 10)
  assert.notEqual(v.hitRate, 46)
  assert.equal(v.cacheReadTokens, 100)
  assert.equal(v.promptTokens, 900)
  assert.equal(v.tokens, 1000)
  assert.equal(v.status, 'complete')
  assert.equal(v.cacheSignal, 'hit')
})

test('缓存写**计入**命中率分母：普通100/读100/写800 ⇒ 10%（旧口径摘掉写会算成 50%）', () => {
  /* 老板确认的公式：ΣcacheRead ÷ (Σuncached + ΣcacheRead + ΣcacheWrite)。
     这是"写缓存非零"时新旧口径**结果不同**的硬证据：正确 100/1000=10%，旧实现 100/200=50%。 */
  const v = aggregateMemberUsage([seg({ sessionId: 'w1', uncached: 100, cacheRead: 100, cacheWrite: 800 })])
  assert.equal(v.hitDenominator, 1000)      // 100 + 100 + 800（写也进分母）
  assert.equal(v.hitRate, 10)
  assert.notEqual(v.hitRate, 50)            // ⛔ 旧口径（排除写）会得到 50%
  assert.equal(v.tokens, 1000)              // 三桶互斥相加 = 完整输入量（output 0）
  assert.equal(v.cacheWriteTokens, 800)
  assert.equal(v.cacheSignal, 'hit')
})

test('只有写、没有读：命中率是真实的 0%（不是 null），且保留 write-only 信号', () => {
  const v = aggregateMemberUsage([seg({ sessionId: 's1', uncached: 0, cacheRead: 0, cacheWrite: 500, output: 200 })])
  assert.equal(v.hitDenominator, 500)       // 分母 = 写（>0）⇒ 可计算
  assert.equal(v.hitRate, 0)                // 0/500 = 0%，不是"未知"
  assert.equal(v.cacheSignal, 'write-only') // 信号保留：有写入、零命中
  assert.equal(v.tokens, 700)               // 0 + 0 + 500 + 200
  assert.equal(v.status, 'complete')
})

test('未命中 + 写（无读）：0%，分母含写；tokens = 完整输入 + 输出', () => {
  const v = aggregateMemberUsage([seg({ sessionId: 's1', uncached: 1000, cacheRead: 0, cacheWrite: 500, output: 200 })])
  assert.equal(v.hitDenominator, 1500)      // 1000 + 0 + 500
  assert.equal(v.hitRate, 0)
  assert.equal(v.tokens, 1700)              // 1000 + 0 + 500 + 200
  assert.equal(v.cacheWriteTokens, 500)
  assert.equal(v.cacheSignal, 'write-only')
  assert.equal(v.status, 'complete')
})

test('全历史 = 当前段 + 归档段（同一父会话、同一成员），当前段只认未归档', () => {
  const v = aggregateMemberUsage([
    seg({ sessionId: 'old', seq: 1, archived: true, uncached: 100, cacheRead: 900, output: 10 }),
    seg({ sessionId: 'cur', seq: 2, uncached: 20, cacheRead: 80, output: 5, updatedAt: 5 }),
  ])
  assert.equal(v.tokens, 1010 + 105)        // 归档段 1010 + 当前段 105
  assert.equal(v.currentSessionId, 'cur')
  assert.equal(v.currentSeq, 2)
  assert.equal(v.currentTokens, 105)
  assert.equal(v.readableSegments, 2)
  assert.equal(v.duplicateActive, 0)
  assert.equal(v.status, 'complete')
})

test('新段一次都没跑（无账本、无 assistant）= 真 0，状态 empty 而不是未知', () => {
  const v = aggregateMemberUsage([seg({ sessionId: 'new', hasLedger: false, hasAssistant: false, turns: 0 })])
  assert.equal(v.tokens, 0)
  assert.equal(v.status, 'empty')
  assert.equal(v.hitRate, null)             // 分母 0 ⇒ 不可计算（显示「—」，不是 0%）
  assert.equal(v.emptySegments, 1)
  assert.equal(v.missingSegments, 0)
  assert.equal(v.cacheSignal, 'none')
})

test('缺账段（有对话但账本没写）⇒ partial + missingSegments=1，且绝不拿 0 补进去', () => {
  const v = aggregateMemberUsage([
    seg({ sessionId: 'ok', uncached: 300, cacheRead: 700 }),
    seg({ sessionId: 'lost', seq: 2, hasLedger: false, hasAssistant: true }),
  ])
  assert.equal(v.tokens, 1000)              // 只加可读段；缺账段一个字节都不加
  assert.equal(v.status, 'partial')
  assert.equal(v.missingSegments, 1)
  assert.equal(v.readableSegments, 1)
  assert.equal(v.currentSessionId, 'lost')  // 当前段仍是那段（只是读数不可信）
  assert.equal(v.currentTokens, null)       // ⇒ 当前段数字为 null（前端显示「—」）
})

test('只有私聊、没有任何 bb.runs 记录的成员：按成员会话就能出键（不靠 runs）', () => {
  /* 这段代表"用户在成员窗口私聊了一轮"：账本有消耗，黑板上没有 run 记录。
     旧实现 memberTotals 的键只来自 runs/retired ⇒ 这种人一行都不出现。 */
  const views = collectMemberUsageViews([seg({ sessionId: 'dm1', memberId: 'm2', uncached: 400, cacheRead: 600, turns: 1 })], 'P1')
  assert.deepEqual([...views.keys()], ['m2'])
  assert.equal(views.get('m2')!.tokens, 1000)
  assert.equal(views.get('m2')!.hitRate, 60)
})

test('同名成员跨父会话不混算（按 parentSessionId 归属）', () => {
  const rows = [
    seg({ parentSessionId: 'P1', memberId: 'm1', sessionId: 'a1', uncached: 100, cacheRead: 900 }),
    seg({ parentSessionId: 'P2', memberId: 'm1', sessionId: 'b1', uncached: 5000, cacheRead: 5000 }),
  ]
  const p1 = collectMemberUsageViews(rows, 'P1')
  const p2 = collectMemberUsageViews(rows, 'P2')
  assert.equal(p1.get('m1')!.tokens, 1000)
  assert.equal(p2.get('m1')!.tokens, 10000)
  assert.equal(p1.get('m1')!.hitRate, 90)
  assert.equal(p2.get('m1')!.hitRate, 50)
})

test('同一段被传两次（读侧重复/并发副本）不双计：按 sessionId 去重', () => {
  const one = seg({ sessionId: 'dup', uncached: 100, cacheRead: 900 })
  const v = aggregateMemberUsage([one, { ...one }])
  assert.equal(v.tokens, 1000)              // 不是 2000
  assert.equal(v.segments, 1)
  assert.equal(v.hitDenominator, 1000)
})

test('同成员出现 2 个未归档段（数据异常）：都计入累计，但 duplicateActive=1 且当前段取 seq 最大', () => {
  const v = aggregateMemberUsage([
    seg({ sessionId: 'a', seq: 1, uncached: 10, cacheRead: 90 }),
    seg({ sessionId: 'b', seq: 3, uncached: 20, cacheRead: 80, updatedAt: 9 }),
  ])
  assert.equal(v.tokens, 200)               // 两段都是真账本 ⇒ 都算（不丢数据）
  assert.equal(v.duplicateActive, 1)        // 但异常必须报出来
  assert.equal(v.currentSessionId, 'b')
})

test('pickCurrentRow 确定性：未归档优先、seq 大者优先、再比 updatedAt', () => {
  const a = { archived: false, seq: 5, updatedAt: 1, sessionId: 'a' }
  const b = { archived: false, seq: 5, updatedAt: 2, sessionId: 'b' }
  const c = { archived: true, seq: 99, updatedAt: 99, sessionId: 'c' }
  assert.equal(pickCurrentRow([a, b, c])!.sessionId, 'b')
  assert.equal(pickCurrentRow([c]), null)
})

test('applyUsageViewToRecord：turns=0 时不覆盖原 runs；命中率/完整度原样写入', () => {
  const rec: Record<string, any> = { runs: 7, tokens: 1, source: 'runs' }
  const v = aggregateMemberUsage([seg({ sessionId: 's1', uncached: 100, cacheRead: 900, turns: 0 })])
  applyUsageViewToRecord(rec, v)
  assert.equal(rec.runs, 7)                 // 账本没记轮数 ⇒ 保留 runs 残值（不拿 0 覆盖）
  assert.equal(rec.tokens, 1000)
  assert.equal(rec.hitRate, 90)
  assert.equal(rec.hitDenominator, 1000)
  assert.equal(rec.usageStatus, 'complete')
  assert.equal(rec.cacheSignal, 'hit')
  assert.equal(rec.source, 'ledger')
  assert.equal(rec.readableSegments, 1)
  assert.equal(rec.missingSegments, 0)
})

test('空输入 ⇒ none（没有任何成员会话，不编 0）', () => {
  const v = aggregateMemberUsage([])
  assert.equal(v.status, 'none')
  assert.equal(v.segments, 0)
  assert.equal(v.hitRate, null)
  assert.equal(v.currentSessionId, '')
})

test('并入 memberTotals：账本里有、runs 口径没有的成员要**补键**（只私聊的人才出现）', () => {
  /* 旧实现只遍历 memberTotals 已有键（= runs/retired 的成员）⇒ 只私聊的 m2 永远不出现。 */
  const totals: Record<string, any> = { m1: { tokens: 999, runs: 1, source: 'runs' } }   // runs 口径残值
  const views = collectMemberUsageViews([
    seg({ sessionId: 'a', memberId: 'm1', uncached: 100, cacheRead: 900 }),
    seg({ sessionId: 'b', memberId: 'm2', uncached: 400, cacheRead: 600, turns: 2 }),
  ], 'P1')
  mergeViewsIntoMemberTotals(totals, views)
  assert.deepEqual(Object.keys(totals).sort(), ['m1', 'm2'])
  assert.equal(totals.m1.tokens, 1000)      // 被账本覆盖（不是 999）
  assert.equal(totals.m1.hitRate, 90)
  assert.equal(totals.m2.tokens, 1000)      // 补出来的键
  assert.equal(totals.m2.usageStatus, 'complete')
})

test('并入 memberTotals：账本里没有的成员保留 runs 残值，但标 runs/none 并清掉命中率', () => {
  const totals: Record<string, any> = {
    m9: { tokens: 500, runs: 3, hitRate: 88, hitDenominator: 100, cacheSignal: 'hit', source: 'ledger' },
  }
  mergeViewsIntoMemberTotals(totals, new Map())   // 视图为空（该成员会话已被删）
  assert.equal(totals.m9.tokens, 500)             // 残值保留（不写 0）
  assert.equal(totals.m9.source, 'runs')
  assert.equal(totals.m9.usageStatus, 'none')
  assert.equal('hitRate' in totals.m9, false)     // 从没人算过的字段必须清掉
  assert.equal('cacheSignal' in totals.m9, false)
})

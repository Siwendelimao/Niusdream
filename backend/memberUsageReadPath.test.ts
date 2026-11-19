import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectMemberUsageViews,
  applyUsageViewToRecord,
  detailTotalsFromView,
  sessionToSegmentRow,
  pickCurrentRow,
  type SessionLike,
} from './memberUsageAggregate.ts'

/** 合成 fixture：父团队会话 P1 下 5 个成员 + P2 下的同名 m1。
 *  ⚠️ 不读盘、不连供应商、不启动服务；`usageTotals` 就是 creditHopSnapshot 写出的形状。 */
const P1 = 'P1'
const FIXTURE: SessionLike[] = [
  /* m1：归档段（seq1）+ 当前段（seq2）。两段都是"派活 + 私聊共用同一个账本"的累计。 */
  { id: 'p1m1s1', parentSessionId: P1, memberId: 'm1', memberSessionSeq: 1, archived: true, updatedAt: 10,
    usageTotals: { uncached: 100, cacheRead: 900, cacheWrite: 0, output: 10, turns: 2 }, messages: [{ role: 'user' }, { role: 'assistant' }] },
  { id: 'p1m1s2', parentSessionId: P1, memberId: 'm1', memberSessionSeq: 2, archived: false, updatedAt: 20,
    usageTotals: { uncached: 20, cacheRead: 80, cacheWrite: 0, output: 5, turns: 1 }, messages: [{ role: 'user' }, { role: 'assistant' }] },
  /* m2：**只有私聊**（黑板上没有任何 run 记录 —— 本 fixture 根本不涉及 runs，照样能出数） */
  { id: 'p1m2s1', parentSessionId: P1, memberId: 'm2', memberSessionSeq: 1, archived: false, updatedAt: 30,
    usageTotals: { uncached: 400, cacheRead: 600, cacheWrite: 0, output: 50, turns: 3 }, messages: [{ role: 'user' }, { role: 'assistant' }] },
  /* m3：有对话但账本没写 ⇒ 不可信（partial） */
  { id: 'p1m3s1', parentSessionId: P1, memberId: 'm3', memberSessionSeq: 1, archived: false, updatedAt: 40,
    usageTotals: null, messages: [{ role: 'user' }, { role: 'assistant' }] },
  /* m4：新开段，一次都没跑 ⇒ 真 0 */
  { id: 'p1m4s1', parentSessionId: P1, memberId: 'm4', memberSessionSeq: 1, archived: false, updatedAt: 50,
    messages: [{ role: 'user' }] },
  /* m5：**重启骨架**（只有索引元数据，正文还没升级）⇒ 必须算"读不到"，不许算真 0 */
  { id: 'p1m5s1', parentSessionId: P1, memberId: 'm5', memberSessionSeq: 1, archived: false, updatedAt: 60, _skeleton: true },
  /* P2 下的同名 m1：跨父绝不混算 */
  { id: 'p2m1s1', parentSessionId: 'P2', memberId: 'm1', memberSessionSeq: 1, archived: false, updatedAt: 70,
    usageTotals: { uncached: 5000, cacheRead: 5000, cacheWrite: 0, output: 0, turns: 1 }, messages: [{ role: 'assistant' }] },
]

/** 模拟 server 的读取层（`readMemberSegmentRows`：按父会话过滤 + 会话对象 → 段行） */
function readRows(parent: string): ReturnType<typeof sessionToSegmentRow>[] {
  return FIXTURE.map((s) => sessionToSegmentRow(s, parent)).filter(Boolean) as ReturnType<typeof sessionToSegmentRow>[]
}

test('出口一致：黑板 RPC 与详情 RPC 的累计/命中率/完整度逐字段相同（同一个聚合）', () => {
  const views = collectMemberUsageViews(readRows(P1) as any, P1)
  const black = new Map<string, Record<string, any>>()
  for (const [mid, v] of views) {
    const rec: Record<string, any> = {}
    applyUsageViewToRecord(rec, v)          // 出口①：blackboard.read / WS 帧用的写入函数
    black.set(mid, rec)
  }
  for (const [mid, v] of views) {
    const detail = detailTotalsFromView(v)  // 出口②：session.memberUsageDetail 的 totals
    assert.ok(detail, `${mid} 应该有待展示的合计`)
    const rec = black.get(mid)!
    assert.equal(rec.tokens, detail!.tokens, `${mid} tokens`)
    assert.equal(rec.hitRate, detail!.hitRate, `${mid} hitRate`)
    assert.equal(rec.hitDenominator, detail!.hitDenominator, `${mid} hitDenominator`)
    assert.equal(rec.usageStatus, detail!.status, `${mid} status`)
    assert.equal(rec.missingSegments, detail!.missingSegments, `${mid} missingSegments`)
    assert.equal(rec.cacheSignal, detail!.cacheSignal, `${mid} cacheSignal`)
  }
})

test('m1：全历史 = 归档段 + 当前段（不是只有当前段）；当前段口径单独不变', () => {
  const views = collectMemberUsageViews(readRows(P1) as any, P1)
  const m1 = views.get('m1')!
  /* 归档段 100+900+10=1010；当前段 20+80+5=105 ⇒ 1115（旧实现只给 105，漏 90.6%） */
  assert.equal(m1.tokens, 1115)
  assert.equal(m1.hitDenominator, 1100)   // (900+80) + (100+20)
  assert.equal(m1.hitRate, 89)            // 980/1100 = 89.09 ⇒ 89（不是把两段百分比平均）
})

test('m2：只有私聊、没有 run 记录的成员照样出键（键来自成员会话，不来自 bb.runs）', () => {
  const views = collectMemberUsageViews(readRows(P1) as any, P1)
  assert.ok(views.has('m2'))
  assert.equal(views.get('m2')!.tokens, 1050)   // 400+600+50
  assert.equal(views.get('m2')!.hitRate, 60)    // 600/1000
})

test('m3 缺账 ⇒ partial（合计是部分和，missingSegments=1），m4 新段 ⇒ empty（真 0）', () => {
  const views = collectMemberUsageViews(readRows(P1) as any, P1)
  assert.equal(views.get('m3')!.status, 'partial')
  assert.equal(views.get('m3')!.tokens, 0)      // 一个字节都不加
  assert.equal(views.get('m3')!.missingSegments, 1)
  assert.equal(views.get('m4')!.status, 'empty')
  assert.equal(views.get('m4')!.tokens, 0)
  assert.equal(views.get('m4')!.missingSegments, 0)
  assert.equal(views.get('m4')!.hitRate, null)
})

test('m5 重启骨架 ⇒ partial（读不到，不是"没跑过"），绝不给出 0', () => {
  const views = collectMemberUsageViews(readRows(P1) as any, P1)
  const m5 = views.get('m5')!
  assert.equal(m5.status, 'partial')
  assert.equal(m5.missingSegments, 1)
  assert.equal(m5.tokens, 0)
  /* 关键：不能因为"没有 assistant 消息"就判成 empty（那会把未知冒充成真 0） */
  assert.notEqual(m5.status, 'empty')
  assert.equal(m5.hitRate, null)
})

test('跨父同名 m1 不混算：P1 只算 1115，P2 只算 10000', () => {
  const p1 = collectMemberUsageViews(readRows(P1) as any, P1)
  const p2 = collectMemberUsageViews(readRows('P2') as any, 'P2')
  assert.equal(p1.get('m1')!.tokens, 1115)
  assert.equal(p2.get('m1')!.tokens, 10000)
  assert.equal(p2.get('m1')!.hitRate, 50)
  assert.deepEqual([...p2.keys()], ['m1'])   // P2 只有 m1 的段
})

test('当前段：归档段再大也不当当前段（团队运行预算口径不变）', () => {
  const rows = readRows(P1) as any[]
  const m1rows = rows.filter((r) => r!.memberId === 'm1')
  const cur = pickCurrentRow(m1rows)!
  assert.equal(cur.sessionId, 'p1m1s2')
  assert.equal(cur.archived, false)
  assert.equal(cur.uncached + cur.cacheRead + cur.cacheWrite + cur.output, 105)
})

test('读取链不丢 cacheWrite：写缓存也计入命中率分母（普通100/读100/写800 ⇒ 10%）', () => {
  /* 这一段走的是和 server 一样的映射（sessionToSegmentRow），证明"公式改在聚合层、数据没在中途丢"。 */
  const rows = [
    { id: 'p9m1s1', parentSessionId: 'P9', memberId: 'm1', memberSessionSeq: 1, archived: false, updatedAt: 1,
      usageTotals: { uncached: 100, cacheRead: 100, cacheWrite: 800, output: 50, turns: 1 }, messages: [{ role: 'assistant' }] },
  ] as SessionLike[]
  const views = collectMemberUsageViews(rows.map((s) => sessionToSegmentRow(s, 'P9')).filter(Boolean) as any[], 'P9')
  const v = views.get('m1')!
  assert.equal(v.cacheWriteTokens, 800)
  assert.equal(v.hitDenominator, 1000)   // 100 + 100 + 800
  assert.equal(v.hitRate, 10)            // 不是旧口径的 50%
  assert.equal(v.tokens, 1050)           // 100 + 100 + 800 + 50
})

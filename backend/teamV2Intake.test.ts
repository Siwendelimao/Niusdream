import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openTeamV2Ledger } from './teamV2Ledger.ts'
import { resolveTeamV2Intake } from './teamV2Intake.ts'

const quote = '找设计奖案例，也找中文赏析。'
const sources = [{ id: 'original', text: quote }, { id: 'authorization', text: '让成员去' }]
const team = new Set(['m1', 'm2'])
const tasks = [
  { quote, title: '找设计奖案例', acceptance: '列出获奖站点', memberId: 'm1' },
  { quote, title: '找中文赏析', acceptance: '列出中文文章', memberId: 'm2' },
]

test('two requests may cite the exact same past user message without aliasing or replay', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const input = resolveTeamV2Intake(sources, tasks, team)
    assert.deepEqual(input.map(r => [r.messageId, r.quote]), [['original', quote], ['original', quote]])
    const created = ledger.receiveAndAssign('authorization', input)
    assert.deepEqual(created.map(r => [r.request.id, r.attempt.memberId, r.created]), [[1, 'm1', true], [2, 'm2', true]])
    assert.deepEqual(ledger.receiveAndAssign('authorization', [...input].reverse()).map(r => [r.request.id, r.created]), [[2, false], [1, false]])
    assert.equal(ledger.page(null, 10, 'original').items.length, 2)
    assert.equal(ledger.page(null, 10, 'authorization').items.length, 0)
    assert.throws(() => ledger.assign(1, 1, 'm2'), /already assigned/)
  } finally { ledger.close() }
})

test('legacy exact intake is retained and ambiguously sourced quotes are rejected', () => {
  const ledger = openTeamV2Ledger(':memory:')
  try {
    const [input] = resolveTeamV2Intake(sources, tasks, team)
    const [old] = ledger.receiveAndAssign('authorization', [{ ...input, partKey: '0:15' }])
    const [again] = ledger.receiveAndAssign('authorization', [input])
    assert.equal(again.request.id, old.request.id)
    assert.equal(again.request.partKey, '0:15')
    assert.equal(again.created, false)
    assert.throws(() => resolveTeamV2Intake([...sources, { id: 'other', text: quote }], tasks, team), /exactly one user message/)
    assert.throws(() => resolveTeamV2Intake(sources, [{ ...tasks[0], quote: '模型改写' }], team), /exactly one user message/)
    /* ★1124b（老板：「该引用问题而不是去做吧这种废话」）：整条消息只有一张图时，AI 可能把 [[图片:0]]
       当原话抄进来 —— 这种引文剥掉占位符后没有可读内容，必须当场拒掉，不能建出一条"原话是图片编号"的工单。 */
    const imageOnly = { id: 'img', text: '[[图片:0]]' }
    assert.throws(() => resolveTeamV2Intake([...sources, imageOnly], [{ ...tasks[0], quote: '[[图片:0]]' }], team), /no readable text/)
    /* 反向护栏：图 + 文字的消息里摘带占位符的那一段是**合法**的（原文确实长这样），别把正常引用一起拦掉。 */
    const withImage = { id: 'img2', text: '排序乱了，左侧导航条[[图片:0]]也跟着乱' }
    const [ok] = resolveTeamV2Intake([...sources, withImage], [{ ...tasks[0], quote: '排序乱了，左侧导航条[[图片:0]]也跟着乱' }], team)
    assert.equal(ok.messageId, 'img2')
  } finally { ledger.close() }
})

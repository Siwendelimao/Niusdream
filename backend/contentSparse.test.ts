/**
 * 1035 阶段 C · contentSparse 单测
 * 跑法： cd backend && node --import tsx/esm --test contentSparse.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applySparse,
  createTurnState,
  diffTurn,
  dropTurnState,
  stableFingerprint,
  trimTurnStates,
  type BlockLike,
} from './contentSparse.ts'

const text = (id: string, t: string): BlockLike => ({ id, kind: 'text', text: t })
const tool = (id: string, status: string, result?: string): BlockLike => ({ id, kind: 'tool', name: 'fs_read', status, result })

/* ═══════════ 1. 首次与零变化 ═══════════ */

test('首次下发 → full，且每块都拿到 rev', () => {
  const st = createTurnState()
  const out = diffTurn(st, [text('a', 'x'), tool('b', 'running')])
  assert.equal(out.changed, true)
  assert.equal((out as any).full, true)
  const blocks = (out as any).blocks as BlockLike[]
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].rev, 1)
  assert.equal(blocks[1].rev, 2)
  assert.equal((out as any).turnRev, 1)
})

test('一模一样的内容再来一次 → changed:false（不发帧，零流量）', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), tool('b', 'running')])
  const again = diffTurn(st, [text('a', 'x'), tool('b', 'running')])
  assert.equal(again.changed, false)
})

test('键顺序不同但内容相同 → 指纹相同，不误判为变化', () => {
  const a: BlockLike = { id: 'a', kind: 'tool', name: 'x', status: 'done' }
  const b: BlockLike = { status: 'done', name: 'x', kind: 'tool', id: 'a' }
  assert.equal(stableFingerprint(a), stableFingerprint(b))
})

test('rev 字段本身不参与指纹（否则每帧都会被判为变化）', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x')])
  const withRev: BlockLike = { id: 'a', kind: 'text', text: 'x', rev: 99 }
  assert.equal(diffTurn(st, [withRev]).changed, false)
})

/* ═══════════ 2. 稀疏：内容变化 ═══════════ */

test('正文变长 → 只发该块，rev 递增', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), text('b', 'y')])
  const out = diffTurn(st, [text('a', 'xy'), text('b', 'y')])
  assert.equal((out as any).full, false)
  const sparse = (out as any).sparse as { i: number; rev: number; block: BlockLike }[]
  assert.equal(sparse.length, 1)
  assert.equal(sparse[0].i, 0)
  assert.equal(sparse[0].block.id, 'a')
  assert.equal(sparse[0].rev, 3) // 前两块占 1、2
  assert.equal((out as any).turnRev, 2)
})

test('工具状态迁移 → 毎次迁移都发一帧（红线 R2：不许合并中间态）', () => {
  const st = createTurnState()
  diffTurn(st, [tool('t1', 'running')])
  const r1 = diffTurn(st, [tool('t1', 'running', '部分输出')])
  const r2 = diffTurn(st, [tool('t1', 'done', '部分输出')])
  assert.equal((r1 as any).full, false)
  assert.equal((r2 as any).full, false)
  assert.equal((r1 as any).sparse.length, 1)
  assert.equal((r2 as any).sparse.length, 1)
  assert.ok((r2 as any).turnRev > (r1 as any).turnRev)
})

test('多块同时变 → 一帧内合并（属同一次迁移之内，允许）', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), text('b', 'y')])
  const out = diffTurn(st, [text('a', 'x1'), text('b', 'y1')])
  assert.equal((out as any).sparse.length, 2)
})

/* ═══════════ 3. 顺序边界（红线 R3） ═══════════ */

test('尾部追加新块 → 仍可稀疏（前缀没动）', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x')])
  const out = diffTurn(st, [text('a', 'x'), tool('t1', 'running')])
  assert.equal((out as any).full, false)
  const sparse = (out as any).sparse as { i: number; block: BlockLike }[]
  assert.equal(sparse.length, 1)
  assert.equal(sparse[0].i, 1)
  assert.equal(sparse[0].block.id, 't1')
})

test('中间插入 → 必须 full（否则前端原地替换会错位）', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), text('b', 'y')])
  const out = diffTurn(st, [text('a', 'x'), text('n', 'new'), text('b', 'y')])
  assert.equal((out as any).full, true)
  assert.equal(((out as any).blocks as BlockLike[]).length, 3)
})

test('删除中间块 → 必须 full', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), text('b', 'y'), text('c', 'z')])
  const out = diffTurn(st, [text('a', 'x'), text('c', 'z')])
  assert.equal((out as any).full, true)
})

test('两块的顺序互换 → 必须 full', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x'), text('b', 'y')])
  const out = diffTurn(st, [text('b', 'y'), text('a', 'x')])
  assert.equal((out as any).full, true)
})

test('前缀被替换（同长度不同 id）→ full', () => {
  const st = createTurnState()
  diffTurn(st, [text('a', 'x')])
  const out = diffTurn(st, [text('z', 'x')])
  assert.equal((out as any).full, true)
})

/* ═══════════ 4. 轮终态强制 full ═══════════ */

test('forceFull（轮终态）→ 全量，且没变的块沿用旧 rev', () => {
  const st = createTurnState()
  const first = diffTurn(st, [text('a', 'x'), text('b', 'y')])
  const revA = ((first as any).blocks as BlockLike[])[0].rev as number
  const out = diffTurn(st, [text('a', 'x'), text('b', 'y')], { forceFull: true })
  assert.equal((out as any).full, true)
  const blocks = (out as any).blocks as BlockLike[]
  assert.equal(blocks[0].rev, revA) // 内容没变 ⇒ rev 不动（前端幂等守卫据此跳过）
})

/* ═══════════ 5. rev 单调性与一致性 ═══════════ */

test('rev 严格单调递增，跨帧不重复', () => {
  const st = createTurnState()
  const revs: number[] = []
  diffTurn(st, [text('a', '1')])
  for (let i = 2; i <= 6; i++) {
    const out = diffTurn(st, [text('a', '1'.repeat(i))])
    for (const s of (out as any).sparse as { rev: number }[]) revs.push(s.rev)
  }
  for (let i = 1; i < revs.length; i++) assert.ok(revs[i] > revs[i - 1], `rev 非单调: ${revs.join(',')}`)
})

test('turnRev 只在真的变化时递增', () => {
  const st = createTurnState()
  const r1 = diffTurn(st, [text('a', 'x')]) as any
  const r2 = diffTurn(st, [text('a', 'x')]) as any
  const r3 = diffTurn(st, [text('a', 'xy')]) as any
  assert.equal(r1.turnRev, 1)
  assert.equal(r2.changed, false)
  assert.equal(r3.turnRev, 2)
})

/* ═══════════ 6. 禁兜底：身份缺失必须炸 ═══════════ */

test('块缺 id → 抛错（不许用序号当身份）', () => {
  const st = createTurnState()
  assert.throws(() => diffTurn(st, [{ kind: 'text', text: 'x' } as unknown as BlockLike]), /缺 id/)
})

test('块 id 重复 → 抛错（轮内重复会让原地替换覆盖错块）', () => {
  const st = createTurnState()
  assert.throws(() => diffTurn(st, [text('dup', 'x'), text('dup', 'y')]), /id 重复/)
})

/* ═══════════ 7. 稀疏合并参考实现 ═══════════ */

test('applySparse：按 id 原地替换，长度与顺序不变', () => {
  const prev = [text('a', 'x'), text('b', 'y'), text('c', 'z')]
  const merged = applySparse(prev, [{ i: 1, rev: 5, block: { id: 'b', kind: 'text', text: 'yy', rev: 5 } }])
  assert.deepEqual(merged.map((b) => b.id), ['a', 'b', 'c'])
  assert.equal(merged[1].text, 'yy')
  assert.equal(merged.length, 3)
})

test('applySparse：尾部追加允许（流式新增块就是这形态）', () => {
  const merged = applySparse([text('a', 'x')], [{ i: 1, rev: 2, block: { id: 'b', kind: 'text', text: 'n', rev: 2 } }])
  assert.deepEqual(merged.map((b) => b.id), ['a', 'b'])
})

test('applySparse：往中间插 → 抛错（必须由 full 完成）', () => {
  assert.throws(
    () => applySparse([text('a', 'x'), text('c', 'z')], [{ i: 1, rev: 2, block: { id: 'new', kind: 'text', text: 'n', rev: 2 } }]),
    /中间插入/,
  )
})

test('前后端闭环：diffTurn 的 sparse 喂给 applySparse 得到与后端一致的全量', () => {
  const st = createTurnState()
  const first = diffTurn(st, [text('a', 'x')]) as any
  let clientBlocks: BlockLike[] = first.blocks as BlockLike[]

  const steps = [
    [text('a', 'xy')],
    [text('a', 'xy'), tool('t1', 'running')],
    [text('a', 'xyz'), tool('t1', 'running', 'out')],
  ]
  for (const next of steps) {
    const out = diffTurn(st, next as BlockLike[], {}) as any
    assert.equal(out.changed, true)
    if (out.full) {
      clientBlocks = out.blocks as BlockLike[]
    } else {
      clientBlocks = applySparse(clientBlocks, out.sparse)
    }
  }
  /* 后端权威 = 最后一次 full 的全量形状（含 rev），客户端合并结果必须逐块一致 */
  const truth = diffTurn(st, steps[2] as BlockLike[], { forceFull: true }) as any
  const truthMap = new Map<string, BlockLike>((truth.blocks as BlockLike[]).map((b) => [b.id, b]))
  for (const b of clientBlocks) {
    const t = truthMap.get(b.id)
    assert.ok(t, `客户端缺块 ${b.id}`)
    assert.equal(b.rev, t.rev, `块 ${b.id} rev 不一致`)
    assert.equal(JSON.stringify(b.text ?? b.result ?? ''), JSON.stringify(t.text ?? t.result ?? ''))
  }
  assert.equal(clientBlocks.length, truthMap.size)
})

/* ═══════════ 8. 状态生命周期（资源上限，不是兜底） ═══════════ */

test('dropTurnState 删得掉、删不存在的返回 false', () => {
  const m = new Map<string, ReturnType<typeof createTurnState>>()
  m.set('t1', createTurnState())
  assert.equal(dropTurnState(m, 't1'), true)
  assert.equal(dropTurnState(m, 't1'), false)
})

test('trimTurnStates 只保留最新的 N 轮', () => {
  const m = new Map<string, ReturnType<typeof createTurnState>>()
  for (const id of ['t1', 't2', 't3', 't4']) m.set(id, createTurnState())
  const removed = trimTurnStates(m, 2, ['t4', 't3', 't2', 't1'])
  assert.deepEqual(removed, ['t1', 't2'])
  assert.deepEqual([...m.keys()], ['t3', 't4'])
})

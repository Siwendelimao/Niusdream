/* 围栏探活判定：'' = 确实退出；null = 查询失败必须继续挡住（独立验收点名的真缺陷） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeFenceProbe, isFenceCleared } from './teamV2FenceProbe.ts'

const same = (a, b) => a === b

test('确实查无进程（空串）才判退出', () => {
  assert.equal(judgeFenceProbe('', 'ft-1', same), 'exited')
  assert.equal(isFenceCleared('exited'), true)
})

test('查询失败（null）绝不放行 —— 未知不等于退出', () => {
  assert.equal(judgeFenceProbe(null, 'ft-1', same), 'unknown')
  assert.equal(isFenceCleared('unknown'), false)
  /* 连"围栏没记指纹"时也一样：查失败就不能说它退了 */
  assert.equal(judgeFenceProbe(null, null, same), 'unknown')
  assert.equal(isFenceCleared('unknown'), false)
})

test('同一 pid + 同指纹 = 还活着；指纹不同 = 原进程已退、pid 被复用', () => {
  assert.equal(judgeFenceProbe('ft-1', 'ft-1', same), 'alive')
  assert.equal(judgeFenceProbe('ft-2', 'ft-1', same), 'exited', 'pid 复用不能当成原进程还在')
})

test('有进程但没记指纹 = 按活着算（不能证明是同一条命）', () => {
  assert.equal(judgeFenceProbe('ft-9', null, same), 'alive')
  assert.equal(isFenceCleared('alive'), false)
})

test('只有 exited 清围栏；alive / unknown 都继续挡', () => {
  assert.deepEqual(['exited', 'alive', 'unknown'].map(isFenceCleared), [true, false, false])
})

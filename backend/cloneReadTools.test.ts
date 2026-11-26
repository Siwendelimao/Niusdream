/**
 * 分身边界单测（★1124）：**分身是只读的，拉不起进程、改不了文件**。
 *
 * 为什么要它：这条边界原来只写在 `cloneRuntime.ts` 的一行白名单里，靠人读代码保证。
 * 将来谁往 `READ_TOOLS` 里加 `run_command` / `fs_write`，没有任何东西会拦住 ⇒ 分身就能
 * 拉起进程、写工作区，而"分身只读"这个前提会被静默破坏（团队 V2 的归属/围栏都按这个前提推理）。
 * 这里把"白名单本身"和"窄化后的 action 拦截"都锁死。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLONE_READ_ACTIONS, CLONE_READ_TOOLS, readTools } from './cloneRuntime.ts'

type AnyTool = { name: string; label?: string; description?: string; parameters?: any; execute?: (id: string, args: any) => Promise<any> }

function tool(name: string, parameters: any = { type: 'object', properties: {} }): AnyTool {
  return { name, label: name, description: name, parameters, execute: async () => ({ ok: true }) }
}

/* 主 agent / 成员可能持有的全部工具名（含未来可能新增的同类）；分身只会拿到其中白名单部分。 */
const CANDIDATES = [
  'fs_read', 'fs_grep', 'list_dir', 'web_search', 'web_fetch', 'github_search', 'use_skill',
  'repo', 'memory', 'knowledge',
  /* 下面这些一旦漏进分身，就等于"分身能拉进程 / 能写盘" */
  'run_command', 'project_run_command', 'bg_start', 'bg_stop', 'fs_write', 'fs_edit', 'shell',
  'clone_spawn', 'tool_write', 'notebook', 'settings_update',
]

test('分身工具集是硬白名单：拉进程 / 写盘类工具一个都不许进去', () => {
  const kept = readTools(CANDIDATES.map(name => tool(name)) as any).map(t => t.name)
  assert.deepEqual(
    [...kept].sort(),
    [...CLONE_READ_TOOLS, ...Object.keys(CLONE_READ_ACTIONS)].sort(),
    '分身拿到的工具必须**恰好**等于白名单（多一个就是越权）：' + JSON.stringify(kept),
  )
  for (const forbidden of ['run_command', 'project_run_command', 'bg_start', 'bg_stop', 'fs_write', 'fs_edit', 'shell', 'tool_write']) {
    assert.ok(!kept.includes(forbidden), '分身不许拿到 ' + forbidden)
  }
})

test('分身只开放只读 action：repo/memory/knowledge 的写操作在执行入口被拒', async () => {
  const narrowed = readTools([tool('repo'), tool('memory'), tool('knowledge')] as any)
  assert.equal(narrowed.length, 3, '这三个工具本身要保留（只是收窄 action）')

  for (const one of narrowed) {
    const allowed = CLONE_READ_ACTIONS[one.name]
    assert.ok(allowed?.length, one.name + ' 必须有 action 白名单')
    const schema = (one as any).parameters
    const narrowedActions = schema?.properties?.action
    assert.ok(narrowedActions, one.name + ' 的参数 schema 必须收窄到只读 action（不能靠提示词约束）')

    /* 白名单内的 action 放行；白名单外必须抛错（不是静默忽略） */
    await one.execute!('call-1', { action: allowed[0] })
    await assert.rejects(
      () => Promise.resolve(one.execute!('call-2', { action: 'write' })),
      /分身只允许/,
      one.name + ' 的写 action 必须被执行入口拒绝',
    )
  }
})

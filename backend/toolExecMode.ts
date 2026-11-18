/**
 * 工具执行模式与并发闸门（★1128，学 DSH / Codex 的做法）
 *
 * 背景：pi 的 agent-loop 默认**整批并行**——只有出现 `executionMode === 'sequential'` 的工具
 * 才转串行（pi-agent-core/dist/agent-loop.js:366-372），否则 `Promise.all` 全放、结果仍按模型
 * 顺序提交（:411-459）。而"会改工作区/系统"的工具并行跑是真实风险：两个 fs_edit 同时写同一
 * 文件、两个 run_command 抢同一目录 —— 出问题时现象是"文件内容莫名少一半"，极难归因。
 *
 * 两层防护（各管一件事，不重叠）：
 *   ① 分级（applyExecutionModes）：副作用工具标 sequential → pi 自己把它们串起来，形成栅栏；
 *   ② 闸门（createToolGate）：只读工具仍并行，但**同时最多 N 个**（pi 自己没有有界池）。
 *
 * ⚠️ 名单只维护这一份：主 agent 的工具表在 server.ts 装配、成员/分身走 buildSessionTools，
 *    两处都调本模块 —— 各写一份必然漂移。
 *
 * 本文件刻意不 import 任何东西：纯逻辑，可被单独测试。
 */

/** 会产生副作用 / 需要独占的工具（其余一律并行） */
export const SEQUENTIAL_TOOL_NAMES = new Set([
  /* 文件 / 命令 / 后台任务 */
  'fs_write', 'fs_edit', 'run_command', 'check_run',
  /* ★1128：`bg` 是家族工具本体（bg_start/bg_read… 才是子动作），同样是改状态，别漏 */
  'bg',
  /* 状态与持久化（写记忆/档案/便签/计划/设置/定时） */
  'memory', 'knowledge', 'notebook', 'project_note', 'plan_write', 'settings_update', 'schedule',
  /* 团队 / 分身：派活有顺序语义，并行派会互相覆盖黑板占位 */
  'team_dispatch', 'spawn_clone',
  /* 询问卡：会挂起等用户，不能和别的工具并行占着 */
  'ask_user',
])

/** 家族工具的子动作同样是改状态（bg_start / wb_click…） */
export function isSequentialToolName(name: string): boolean {
  if (SEQUENTIAL_TOOL_NAMES.has(name)) return true
  return name.startsWith('bg_') || name.startsWith('wb_')
}

type AnyTool = { name?: string; executionMode?: 'sequential' | 'parallel'; execute?: (...args: any[]) => any }

/** 给工具表打上执行模式（`sequential` 才写，其余不动 —— pi 缺省即并行） */
export function applyExecutionModes<T extends AnyTool>(tools: T[]): T[] {
  return tools.map((t) => (isSequentialToolName(String(t.name || '')) ? { ...t, executionMode: 'sequential' as const } : t))
}

/**
 * 按会话的并行闸门：**只作用于并行工具**（sequential 的由 pi 自己串行，不必再抢名额）。
 * 为什么按会话创建：闸门若是模块级单例，一个会话跑 4 个 fs_grep 会把别的会话一起堵住。
 * @param limit 同时最多允许几个并行工具（建议 4：本机 12 逻辑核，留出余量给渲染进程）
 */
export function createToolGate<T extends AnyTool>(limit: number): (tools: T[]) => T[] {
  const max = Math.max(1, Math.floor(limit) || 1)
  let active = 0
  const waiters: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active++
        resolve()
      })
    })
  }
  const release = (): void => {
    active--
    const next = waiters.shift()
    if (next) next()
  }

  return (tools) =>
    tools.map((t) => {
      if (t.executionMode === 'sequential') return t
      const orig = t.execute
      if (typeof orig !== 'function') return t
      return {
        ...t,
        async execute(...args: any[]) {
          await acquire()
          try {
            return await (orig as (...a: any[]) => any).apply(t, args)
          } finally {
            release()
          }
        },
      } as T
    })
}

/** 生产用默认闸门上限（与 createToolGate 的注释同口径） */
export const DEFAULT_TOOL_GATE_LIMIT = 4

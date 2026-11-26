import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { TeamV2Verify } from './teamV2Intake.ts'

/** ★1124（老板拍板）：验收器的**硬判据部分** —— 纯代码、零 LLM。
 *
 *  它只回答一件事：这张单按派工时写下的判据，**实际产物**过没过。
 *  · `files`  ：在**这一单的独立工作区**（`.nis-attempts/<attemptId>`）里看文件在不在、内容里有没有指定片段
 *  · `command`：在同一个工作区里真跑，**退出码 0 = 通过**（超时/非 0 都算失败，并把输出尾部带回去当反馈）
 *
 *  不做什么（刻意的）：
 *  · 不读成员的自述报告 —— 自报"我做好了"不算证据；
 *  · 判不出来就说 `needs-human`，**绝不补一个通过**；
 *  · 不做 LLM 判断 —— 主观判断交给独立的 C（复验器），那是另一条通道。
 */

export type VerifyCheck = { kind: 'file' | 'command'; target: string; ok: boolean; detail: string }
export type VerifyOutcome =
  | { verdict: 'pass'; checks: VerifyCheck[] }
  | { verdict: 'fail'; checks: VerifyCheck[]; reason: string }
  | { verdict: 'needs-human'; checks: VerifyCheck[]; reason: string }

export type VerifyExec = (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean; output: string }>

/** 在指定目录真跑一条命令（Windows 走 cmd /d /s /c，与项目其它执行口径一致）。 */
export const runVerifyCommand: VerifyExec = (command, cwd, timeoutMs) => new Promise(resolve => {
  let settled = false
  const finish = (value: { code: number | null; timedOut: boolean; output: string }) => {
    if (settled) return
    settled = true
    resolve(value)
  }
  let child
  try {
    child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true, env: { ...process.env } })
  } catch (error) {
    finish({ code: null, timedOut: false, output: 'spawn 失败：' + String((error as Error)?.message || error) })
    return
  }
  let output = ''
  const cap = (buf: Buffer) => { if (output.length < 8000) output += buf.toString('utf8') }
  child.stdout?.on('data', cap)
  child.stderr?.on('data', cap)
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
    finish({ code: null, timedOut: true, output })
  }, Math.max(1000, timeoutMs))
  child.on('error', error => { clearTimeout(timer); finish({ code: null, timedOut: false, output: output + '\n' + String((error as Error)?.message || error) }) })
  child.on('close', code => { clearTimeout(timer); finish({ code, timedOut: false, output }) })
})

/** 跑一次判据。`workspace` = 这一单的独立工作区（`.nis-attempts/<attemptId>`）。 */
export async function runTeamV2Verify(opts: {
  workspace: string | null | undefined
  verify: TeamV2Verify | null | undefined
  exec?: VerifyExec
}): Promise<VerifyOutcome> {
  const checks: VerifyCheck[] = []
  const { verify } = opts
  if (!verify) return { verdict: 'needs-human', checks, reason: '这张单没有可执行判据，验收要人定' }
  const workspace = opts.workspace
  if (!workspace || !fs.existsSync(workspace)) {
    return { verdict: 'needs-human', checks, reason: '找不到这一单的独立工作区，判据无法核对' }
  }
  const exec = opts.exec ?? runVerifyCommand
  const failures: string[] = []

  for (const file of verify.files ?? []) {
    const abs = path.resolve(workspace, file.path)
    const inside = abs === workspace || abs.startsWith(workspace + path.sep)
    if (!inside) {
      checks.push({ kind: 'file', target: file.path, ok: false, detail: '路径越出工作区' })
      failures.push(file.path + '：路径越出工作区')
      continue
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      checks.push({ kind: 'file', target: file.path, ok: false, detail: '文件不存在' })
      failures.push(file.path + '：文件不存在')
      continue
    }
    if (file.contains) {
      let text = ''
      try { text = fs.readFileSync(abs, 'utf8') } catch (error) {
        checks.push({ kind: 'file', target: file.path, ok: false, detail: '读不出来：' + String((error as Error)?.message || error).slice(0, 80) })
        failures.push(file.path + '：读不出来')
        continue
      }
      if (!text.includes(file.contains)) {
        checks.push({ kind: 'file', target: file.path, ok: false, detail: '内容里没有指定片段' })
        failures.push(file.path + '：内容里没有「' + file.contains + '」')
        continue
      }
      checks.push({ kind: 'file', target: file.path, ok: true, detail: '存在且含指定片段' })
      continue
    }
    checks.push({ kind: 'file', target: file.path, ok: true, detail: '存在' })
  }

  if (verify.command) {
    const result = await exec(verify.command, workspace, verify.timeoutMs ?? 120000)
    const tail = result.output.slice(-1200).trim()
    if (result.timedOut) {
      checks.push({ kind: 'command', target: verify.command, ok: false, detail: '超时' })
      failures.push('命令超时：' + verify.command)
    } else if (result.code !== 0) {
      checks.push({ kind: 'command', target: verify.command, ok: false, detail: '退出码 ' + String(result.code) })
      failures.push('命令失败（退出码 ' + String(result.code) + '）：' + (tail || '（无输出）'))
    } else {
      checks.push({ kind: 'command', target: verify.command, ok: true, detail: '退出码 0' })
    }
  }

  if (failures.length) return { verdict: 'fail', checks, reason: failures.slice(0, 5).join('；') }
  return { verdict: 'pass', checks }
}

/** 给证据/汇报用的一行人话（不含长输出）。 */
export function describeVerifyOutcome(outcome: VerifyOutcome): string {
  if (outcome.verdict === 'pass') return '硬判据全过（' + outcome.checks.map(c => c.kind === 'file' ? c.target : '命令退出 0').join('、') + '）'
  if (outcome.verdict === 'fail') return '硬判据未过：' + outcome.reason
  return outcome.reason
}

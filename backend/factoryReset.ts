/** Explicit user-only maintenance, no running-data reset. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dataRestoreBegin, dataRestoreEnd } from './dataMerge.ts'
import { mergePythonCommand } from './dataMergePython.mjs'

export type ResetContext = { dataRoot: string; memoryRoot: string; skillsRoot: string; appRoot: string }
export function resetMarker(data: string): string {
  return path.join(path.dirname(data), `.${path.basename(data)}.nis-reset-pending.json`)
}
function epochFile(data: string): string {
  return path.join(path.dirname(data), `.${path.basename(data)}.nis-reset-epoch.json`)
}
/** Generation published by the last committed reset; empty when this instance never reset. */
export function resetEpoch(data: string): string {
  const f = epochFile(data)
  if (!fs.existsSync(f)) return ''
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!/^[a-f0-9]{32}$/.test(String(j?.epoch || ''))) throw new Error('出厂重置代次标记损坏，拒绝启动')
  return j.epoch
}
/** The handshake only guards windows that could still hold pre-reset state, not every legacy client. */
export function resetGraceActive(data: string, windowMinutes = 30): boolean {
  const f = epochFile(data)
  if (!fs.existsSync(f)) return false
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return Date.now() / 1000 - Number(j.resetAt || 0) < windowMinutes * 60
  } catch { return false }
}
export async function factoryResetRequest(action: 'preview' | 'prepare' | 'cancel' | 'status', input: Record<string, unknown>, context: ResetContext): Promise<any> {
  if (action === 'prepare' && !(globalThis as any)[Symbol.for('nis.dataRuntimeLock')]) throw new Error('后端尚未取得运行保护锁，请通过官方入口手动重启后再准备重置')
  dataRestoreBegin()
  try {
    const py = mergePythonCommand()
    return await new Promise((resolve, reject) => {
      const child = spawn(py.bin, [...(py.pre || []), '-B', path.join(import.meta.dirname, 'factoryReset.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      let output = '', errors = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('重置准备超时；请重新读取待执行状态，不要直接重启')) }, 120000)
      child.stdout.on('data', b => { output += b.toString('utf8'); if (output.length > 2e6) child.kill() })
      child.stderr.on('data', b => { errors = (errors + b.toString('utf8')).slice(-2000) })
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.stdin.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        try { const j = JSON.parse(output); if (code !== 0 || !j.ok) throw new Error(j.error || errors || '恢复出厂准备失败'); resolve(j) }
        catch (e) { reject(e) }
      })
      child.stdin.end(JSON.stringify({ action, ...context, confirmation: input.confirmation, acknowledged: input.acknowledged === true }))
    })
  } finally { dataRestoreEnd() }
}

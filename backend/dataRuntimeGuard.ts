/** Only the bootstrap imports this async module. No business imports. */
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { mergePythonCommand } from './dataMergePython.mjs'
const data = path.resolve(process.env.NIS_DATA_DIR || path.join(import.meta.dirname, 'data'))
const memory = path.resolve(process.env.NIS_MEMORY_DIR || path.join(import.meta.dirname, '..', 'memory'))
const pending = path.join(path.dirname(data), `.${path.basename(data)}.nis-merge-pending.json`)
// Windows must still launch without optional memory Python installed.
let command: { bin: string; pre: string[] }
try {
  const py = mergePythonCommand()
  command = { bin: py.bin, pre: [...py.pre, '-B', path.join(import.meta.dirname, 'dataMergeLocks.py')] }
} catch (e) {
  if (process.platform !== 'win32') throw e
  command = { bin: path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), pre: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'dataRuntimeLocks.ps1')] }
}
const child = spawn(command.bin, command.pre, {
  cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
})
let acquired = false, stopping = false, output = '', stderr = ''
const key = Symbol.for('nis.dataRuntimeLock')
const state = globalThis as any
process.once('exit', () => { stopping = true; state[key] = false; child.kill() })
function lost(error: Error) {
  state[key] = false
  if (acquired && !stopping) {
    // Fail closed: a server without a living lock must not keep writing data.
    console.error('[data-lock] protection lost; terminating backend:', error.message)
    process.exit(72)
  }
}
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('数据锁握手超时，未加载业务模块')) }, 10000)
  const fail = (error: Error) => { clearTimeout(timer); reject(error); lost(error) }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (acquired || !output.includes('\n')) return
    try {
      const result = JSON.parse(output.split('\n')[0])
      if (!result.ok) { child.kill(); fail(new Error(result.error || '数据目录被占用')); return }
      if (fs.existsSync(pending) || fs.existsSync(path.join(path.dirname(data), `.${path.basename(data)}.nis-reset-pending.json`))) { child.kill(); fail(new Error('有待提交合并或出厂重置，请使用启动引导')); return }
      acquired = true; state[key] = { data, memory, pid: child.pid }
      clearTimeout(timer); resolve()
    } catch (e) { fail(e instanceof Error ? e : new Error(String(e))) }
  })
  child.on('error', fail)
  child.on('exit', (code) => fail(new Error(stderr || `数据锁进程退出：${code}`)))
  child.stdin.on('error', fail)
  child.stdin.write(JSON.stringify({ roots: [data, memory], mode: 'runtime' }) + '\n')
})
// Pipes stay open but do not keep an otherwise idle Node process alive.
child.unref()
for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as any).unref?.()

/** Offline review jobs only. No application writes, scheduler, bridge or provider startup. */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

type Context = { dataRoot: string; memoryRoot: string; workRoot: string; python: { bin: string; pre?: string[] }; onProgress?: (percent: number, phase: string) => void }
const jobs = new Map<string, { context: Context; expires: number }>()
let busy = false
let restoring = false
export function dataRestoreBegin(): void {
  if (busy || restoring) throw new Error('另一个导入操作正在运行')
  restoring = true
}
export function dataRestoreEnd(): void { restoring = false }
export function dataMergeBusy(): boolean { return busy || restoring }
export async function dataMergeRequest(action: 'preview' | 'build' | 'prepare' | 'cancel' | 'status', input: Record<string, unknown>, context: Context): Promise<any> {
  if (action === 'status') {
    // Report status even while another job holds the lock, so the UI can explain the wait.
    if (busy || restoring) return { ok: true, running: true }
  }
  if (busy || restoring) throw new Error('上一次合并/预览仍在处理中，请等它出结果，不要重复点击')
  if (['preview','build','prepare'].includes(action) && fs.existsSync(path.join(path.dirname(context.dataRoot), `.${path.basename(context.dataRoot)}.nis-reset-pending.json`))) throw new Error('已有待恢复出厂任务，请先取消，不能同时导入合并')
  if (action === 'prepare' && !(globalThis as any)[Symbol.for('nis.dataRuntimeLock')]) {
    throw new Error('后端尚未通过安全启动引导取得运行锁；请先手动重启更新后的后端，再准备合并')
  }
  const parts = Array.isArray(input.parts) ? [...new Set(input.parts.map(String))] : []
  let token = String(input.token || '')
  for (const [key, job] of jobs) if (job.expires < Date.now()) jobs.delete(key)
  if (action === 'preview') {
    if (!parts.length || parts.length > 12) throw new Error('请选择要预览的部分')
    if (typeof input.zipPath !== 'string' || !path.isAbsolute(input.zipPath)) throw new Error('请选择绝对路径的数据包')
    token = randomBytes(16).toString('hex')
    if (jobs.size >= 12) throw new Error('预览过多，请等待旧预览过期后重试')
  } else if (action !== 'cancel' && action !== 'status') {
    const job = jobs.get(token)
    if (!job || job.expires < Date.now()) throw new Error('预览已过期或后端已重启，请重新预览')
    if (path.resolve(job.context.dataRoot) !== path.resolve(context.dataRoot) || path.resolve(job.context.memoryRoot) !== path.resolve(context.memoryRoot)) throw new Error('数据根已变化，请重新预览')
    context = job.context
  }
  const script = path.join(import.meta.dirname, 'dataMerge.py')
  if (!fs.existsSync(script)) throw new Error('合并预览引擎缺失，请重新打包')
  busy = true
  try {
    const value = await new Promise<any>((resolve, reject) => {
      const child = spawn(context.python.bin, [...(context.python.pre || []), '-B', script], {
        windowsHide: true, cwd: path.dirname(script), stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      let stdout = '', stderr = '', settled = false
      const finish = (error?: Error, value?: any) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        error ? reject(error) : resolve(value)
      }
      const timer = setTimeout(() => { child.kill(); finish(new Error('合并预览超时，当前数据未切换')) }, 15 * 60_000)
      child.stdout.on('data', b => {
        stdout += b.toString('utf8')
        if (stdout.length > 2 * 1024 * 1024) { child.kill(); finish(new Error('合并引擎输出超过限制')) }
      })
      let tail = ''
      child.stderr.on('data', b => {
        stderr = (stderr + b.toString('utf8')).slice(-2000)
        tail += b.toString('utf8')
        const lines = tail.split('\n'); tail = lines.pop() || ''
        for (const line of lines) {
          const m = /^#p (\d+) (.*)$/.exec(line.trim())
          if (m) { try { context.onProgress?.(Number(m[1]), m[2]) } catch { /* progress must never break the job */ } }
          else if (line.trim()) stderr = (stderr + line + '\n').slice(-2000)
        }
      })
      child.on('error', e => finish(new Error(`无法启动合并引擎：${e.message}`)))
      child.stdin.on('error', e => finish(new Error(`合并请求发送失败：${e.message}`)))
      child.on('close', code => {
        if (settled) return
        let value: any
        try { value = JSON.parse(stdout.trim()) } catch { finish(new Error(`合并引擎返回异常：${stderr.slice(-500)}`)); return }
        if (code !== 0 || !value?.ok) finish(new Error(String(value?.error || '合并预览失败')))
        else finish(undefined, value)
      })
      // Pipe JSON and EOF explicitly; no shell invocation or backend bootstrap.
      child.stdin.end(JSON.stringify({ action, token, parts, zipPath: input.zipPath,
        dataRoot: path.resolve(context.dataRoot), memoryRoot: path.resolve(context.memoryRoot), workRoot: path.resolve(context.workRoot) }))
    })
    if (action === 'preview' || action === 'prepare') jobs.set(token, { context, expires: Date.now() + 30 * 60_000 })
    return value
  } finally { busy = false }
}

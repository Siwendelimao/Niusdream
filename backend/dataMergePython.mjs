/** Stdlib-only interpreter selection; no application imports or store initialization. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
let cached
export function mergePythonCommand() {
  if (cached) return cached
  const candidates = []
  const add = (bin, pre = []) => { if (bin) candidates.push({ bin, pre }) }
  add(process.env.NIS_MEMORY_PYTHON)
  const user = process.env.USERPROFILE || process.env.HOME
  const dirs = [process.env.NIS_ENV_DIR, user && path.join(user, 'NISEnv')]
  for (const env of dirs.filter(Boolean)) { add(path.join(env, 'memory-venv', 'Scripts', 'python.exe')); add(path.join(env, 'python.exe')) }
  add('C:/Python313/python.exe'); add('C:/Python312/python.exe'); add('python3')
  for (const version of ['313', '312', '311']) {
    add(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python' + version, 'python.exe'))
    add(path.join(process.env.ProgramFiles || 'C:/Program Files', 'Python' + version, 'python.exe'))
  }
  add('python'); add('py', ['-3'])
  for (const c of candidates) {
    if (path.isAbsolute(c.bin) && !fs.existsSync(c.bin)) continue
    const r = spawnSync(c.bin, [...c.pre, '-B', '-c', 'import sqlite3,tarfile;print("nis-merge-python")'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (r.status === 0 && r.stdout.trim() === 'nis-merge-python') return (cached = c)
  }
  throw new Error('安全合并保护需要 Python 3（标准库），未找到可用解释器')
}

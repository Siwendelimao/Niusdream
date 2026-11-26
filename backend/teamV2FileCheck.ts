import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MAX_BYTES = 1024 * 1024
export type TeamFileCheck = {
  kind: 'file-sha256'
  relativePath: string
  expected: string
  actual: string | null
  bytes: number | null
  outcome: 'matched' | 'mismatch' | 'missing'
}

/** Read only one regular, explicitly requested workspace file. Never invoke an interpreter. */
export function checkTeamFile(workDir: string, relativePath: string, expected: string): TeamFileCheck {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Enter a 64-character SHA-256 fingerprint')
  if (typeof relativePath !== 'string' || relativePath.length > 400) throw new Error('Invalid workspace-relative file path')
  const parts = relativePath.split(/[\\/]/)
  if (parts.some(p => !p || /[\x00-\x1f<>:"|?*]|[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) {
    throw new Error('Use a regular workspace-relative file path')
  }
  if (!path.isAbsolute(workDir)) throw new Error('An absolute workspace root is required')
  const root = fs.realpathSync.native(workDir)
  if (!fs.statSync(root).isDirectory()) throw new Error('Workspace root is not a directory')
  const common = { kind: 'file-sha256' as const, relativePath: parts.join('/'), expected: expected.toLowerCase() }
  let file = root
  for (const part of parts) {
    file = path.join(file, part)
    let st: fs.Stats
    try { st = fs.lstatSync(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...common, outcome: 'missing', actual: null, bytes: null }
      throw error
    }
    if (st.isSymbolicLink()) throw new Error('Symbolic links and junctions are not accepted for file verification')
  }
  const canonical = fs.realpathSync.native(file)
  const inside = path.relative(root, canonical)
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('File is outside the workspace')
  const initial = fs.statSync(canonical)
  if (!initial.isFile() || initial.size > MAX_BYTES) throw new Error('Expected a regular file of at most 1 MiB')
  const fd = fs.openSync(canonical, 'r')
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('Expected a regular file of at most 1 MiB')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (n === 0) break
      size += n
    }
    const after = fs.fstatSync(fd)
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('File changed while being verified')
    const actual = createHash('sha256').update(buffer.subarray(0, size)).digest('hex')
    return { ...common, actual, bytes: size, outcome: actual === common.expected ? 'matched' : 'mismatch' }
  } finally { fs.closeSync(fd) }
}

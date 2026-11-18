import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nis-shell-discovery-'))
process.env.NIS_DATA_DIR = root
process.env.NIS_PARENT_PID = String(process.pid)
const { readShellDescriptor, shellDescriptorPaths } = await import('./browserShellCtl.ts')
const file = path.join(root, 'browser-shell.json')
const descriptor = { pid: process.pid, dataRoot: root, cdpPort: 12345, ctlPort: 12346, startedAt: Date.now(), token: 'fixture' }
after(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.NIS_BROWSER_SHELL_FILE })

test('standalone discovery has exactly one data-root path', () => {
  delete process.env.NIS_BROWSER_SHELL_FILE
  assert.deepEqual(shellDescriptorPaths(), [file])
})
test('a missing explicit parent path must not fall back to another descriptor', () => {
  fs.writeFileSync(file, JSON.stringify(descriptor))
  const explicit = path.join(root, 'exact-parent.json')
  process.env.NIS_BROWSER_SHELL_FILE = explicit
  assert.deepEqual(shellDescriptorPaths(), [explicit])
  assert.equal(readShellDescriptor(true), null)
  delete process.env.NIS_BROWSER_SHELL_FILE
})
test('same root and living parent PID are accepted', () => {
  fs.writeFileSync(file, JSON.stringify(descriptor))
  assert.equal(readShellDescriptor(true)?.pid, process.pid)
})
test('a descriptor from another data root is not this instance', () => {
  fs.writeFileSync(file, JSON.stringify({ ...descriptor, dataRoot: path.join(root, 'another-install') }))
  assert.equal(readShellDescriptor(true), null)
})
test('a living but unrelated shell must not replace the sidecar parent', () => {
  fs.writeFileSync(file, JSON.stringify({ ...descriptor, pid: process.ppid }))
  assert.equal(readShellDescriptor(true), null)
})
test('descriptor without explicit data identity is rejected', () => {
  const { dataRoot, ...rest } = descriptor
  fs.writeFileSync(file, JSON.stringify(rest))
  assert.equal(readShellDescriptor(true), null)
})

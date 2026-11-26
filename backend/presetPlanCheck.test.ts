import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresetPlanCheck } from './presetPlanCheck.ts'

const complete = [{ done: true }]
const cmd = 'npm test'
const pass = { cmd, ok: true, exitCode: 0 }

test('required plan check only trusts an exact, current, successful receipt', () => {
  const rule = createPresetPlanCheck(cmd)
  assert.equal(rule.blockCompletion([]), false)
  assert.equal(rule.blockCompletion([{ done: false }]), false)
  assert.equal(rule.blockCompletion(complete), true)
  assert.equal(rule.begin('echo OK'), undefined)
  assert.equal(rule.begin(cmd, 'another-worktree'), undefined)
  assert.equal(rule.begin(cmd, undefined, false), undefined)
  rule.begin(cmd)!({ ...pass, ok: false, exitCode: 1 })
  assert.equal(rule.blockCompletion(complete), true)
  rule.begin(cmd)!(pass)
  assert.equal(rule.blockCompletion(complete), false)
  rule.begin(cmd)!({ cmd, ok: false, exitCode: null })
  assert.equal(rule.blockCompletion(complete), true)
  const old = rule.begin(cmd)!
  rule.invalidate()
  old(pass)
  assert.equal(rule.blockCompletion(complete), true)
  rule.begin(cmd)!(pass)
  rule.invalidate()
  assert.equal(rule.blockCompletion(complete), true)
})

test('isolated preset storage and real check_run exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nis-preset-check-'))
  mkdirSync(join(root, 'NIS_DATA_DIR', 'file-history'), { recursive: true })
  const vars = ['NIS_DATA_DIR', 'NIS_MEMORY_DIR', 'NIS_SKILLS_DIR'] as const
  const previous = vars.map(k => process.env[k])
  for (const key of vars) process.env[key] = join(root, key)
  try {
    const presets = await import('./agentPresetsStore.ts')
    assert.equal(presets.PRESETS_DIR, join(root, 'NIS_DATA_DIR', 'agent-presets'))
    const { buildCheckRunTool } = await import('./tools.ts')
    const tools = ['fs_read', 'plan_write', 'check_run']
    const base = { id: 'test-preset', name: 'Test', description: 'Test', role: 'Same role', tools, mcp: false }
    assert.equal(presets.writeAgentPreset(base).ok, true)
    assert.equal(presets.readAgentPreset(base.id)?.requiredPlanCheck, undefined)
    assert.equal(presets.writeAgentPreset({ ...base, tools: ['fs_read'], requiredPlanCheck: cmd }).ok, false)
    assert.equal(presets.writeAgentPreset({ ...base, engine: 'dsh', requiredPlanCheck: cmd }).ok, false)
    const runner = buildCheckRunTool(root)
    for (const exit of [7, 0]) {
      const command = `"${process.execPath}" -e "process.exit(${exit})"`
      assert.equal(presets.writeAgentPreset({ ...base, requiredPlanCheck: command }).ok, true)
      const saved = presets.readAgentPreset(base.id)!
      assert.deepEqual(saved.tools, tools)
      assert.equal(saved.requiredPlanCheck, command)
      const rule = createPresetPlanCheck(saved.requiredPlanCheck!)
      const record = rule.begin(command)!
      const result = await runner.execute(`check-${exit}`, { cmd: command })
      assert.equal(result.details?.exitCode, exit)
      record(result.details)
      assert.equal(rule.blockCompletion(complete), exit !== 0)
    }
    assert.equal(presets.writeAgentPreset({ ...base, requiredPlanCheck: '' }).ok, true)
    assert.equal(presets.readAgentPreset(base.id)?.requiredPlanCheck, undefined)
  } finally {
    for (const [i, key] of vars.entries()) {
      if (previous[i] === undefined) delete process.env[key]
      else process.env[key] = previous[i]
    }
    rmSync(root, { recursive: true, force: true })
  }
})

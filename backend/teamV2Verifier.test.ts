import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { test } from 'node:test'
import { describeVerifyOutcome, runTeamV2Verify, type VerifyExec } from './teamV2Verifier.ts'
import { normalizeTeamV2Verify } from './teamV2Intake.ts'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'nis-verify-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('files: missing file fails, existing file with required snippet passes', async () => {
  const w = workspace()
  try {
    fs.writeFileSync(join(w.root, 'alpha.txt'), 'hello world')
    const missing = await runTeamV2Verify({ workspace: w.root, verify: { files: [{ path: 'beta.txt' }] } })
    assert.equal(missing.verdict, 'fail')
    assert.match(String(missing.verdict === 'fail' ? missing.reason : ''), /beta\.txt：文件不存在/)

    const noSnippet = await runTeamV2Verify({ workspace: w.root, verify: { files: [{ path: 'alpha.txt', contains: 'goodbye' }] } })
    assert.equal(noSnippet.verdict, 'fail')
    assert.match(String(noSnippet.verdict === 'fail' ? noSnippet.reason : ''), /内容里没有「goodbye」/)

    const ok = await runTeamV2Verify({ workspace: w.root, verify: { files: [{ path: 'alpha.txt', contains: 'hello' }] } })
    assert.equal(ok.verdict, 'pass')
    assert.equal(ok.checks.length, 1)
    assert.equal(ok.checks[0].ok, true)
    assert.match(describeVerifyOutcome(ok), /硬判据全过/)
  } finally { w.done() }
})

test('files: path escaping the workspace is refused (never read outside)', async () => {
  const w = workspace()
  try {
    for (const bad of ['../outside.txt', '/abs.txt', 'a/../../b.txt']) {
      assert.throws(() => normalizeTeamV2Verify({ files: [{ path: bad }] }), /relative path/, '规范层就应该拒绝：' + bad)
    }
    /* 就算绕过了规范层，执行层也要再挡一次（双保险，不靠单点校验） */
    const escaped = await runTeamV2Verify({ workspace: w.root, verify: { files: [{ path: '../x.txt' }] } })
    assert.equal(escaped.verdict, 'fail')
    assert.match(String(escaped.verdict === 'fail' ? escaped.reason : ''), /越出工作区/)
  } finally { w.done() }
})

test('command: exit 0 passes, non-zero fails with output tail, timeout fails', async () => {
  const w = workspace()
  try {
    const okExec: VerifyExec = async () => ({ code: 0, timedOut: false, output: 'all good' })
    const ok = await runTeamV2Verify({ workspace: w.root, verify: { command: 'npm test' }, exec: okExec })
    assert.equal(ok.verdict, 'pass')
    assert.equal(ok.checks[0].detail, '退出码 0')

    const badExec: VerifyExec = async () => ({ code: 2, timedOut: false, output: 'ts(2339): Property x does not exist' })
    const bad = await runTeamV2Verify({ workspace: w.root, verify: { command: 'npm run typecheck' }, exec: badExec })
    assert.equal(bad.verdict, 'fail')
    assert.match(String(bad.verdict === 'fail' ? bad.reason : ''), /退出码 2.*ts\(2339\)/)

    const slowExec: VerifyExec = async () => ({ code: null, timedOut: true, output: '' })
    const slow = await runTeamV2Verify({ workspace: w.root, verify: { command: 'long' }, exec: slowExec })
    assert.equal(slow.verdict, 'fail')
    assert.match(String(slow.verdict === 'fail' ? slow.reason : ''), /超时/)
  } finally { w.done() }
})

test('no verify / no workspace ⇒ needs-human (never a synthetic pass)', async () => {
  const w = workspace()
  try {
    const none = await runTeamV2Verify({ workspace: w.root, verify: null })
    assert.equal(none.verdict, 'needs-human')
    assert.match(none.verdict === 'needs-human' ? none.reason : '', /没有可执行判据/)

    const gone = await runTeamV2Verify({ workspace: join(w.root, 'nope'), verify: { files: [{ path: 'a.txt' }] } })
    assert.equal(gone.verdict, 'needs-human')
    assert.equal(gone.checks.length, 0)
  } finally { w.done() }
})

test('real command executes inside the attempt workspace', async () => {
  const w = workspace()
  try {
    const real = await runTeamV2Verify({ workspace: w.root, verify: { command: 'cmd /c echo made-by-verify>probe.txt', timeoutMs: 20000 } })
    /* Windows 上这条一定是退出码 0；文件应该落在**这个工作区**里，证明 cwd 传对了 */
    assert.equal(real.verdict, 'pass', JSON.stringify(real))
    assert.equal(fs.existsSync(join(w.root, 'probe.txt')), true, '命令必须在 attempt 工作区里执行')
  } finally { w.done() }
})

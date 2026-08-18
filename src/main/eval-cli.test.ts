import { execFile } from 'child_process'
import { resolve } from 'path'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('eval CLI', () => {
  // Bundles the CLI with Vite and replays it in a child process, so this test is
  // orders of magnitude slower than the unit suite it runs alongside.
  it('replays a recorded session without credentials', { timeout: 120_000 }, async () => {
    const root = resolve('tests/fixtures/eval')
    const result = await execFileAsync(process.execPath, [
      'scripts/run-eval.mjs',
      '--case', `${root}/basic.case.json`,
      '--replay', `${root}/basic.recording.json`,
    ], { cwd: process.cwd(), windowsHide: true })
    const report = JSON.parse(result.stdout) as { passed: boolean; finishReason: string; workspacePath: string }

    expect(report).toMatchObject({ passed: true, finishReason: 'settled', workspacePath: '(removed)' })
  })
})

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'release-local.js')

function dryRun(...args) {
  return spawnSync(process.execPath, [script, '--dry-run', '--skip-build', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('release runtime gate ordering', () => {
  it('verifies the runtime before any tag, push or upload', () => {
    const result = dryRun('--smoke-runtime')
    expect(result.status).toBe(0)
    const smoke = result.stdout.indexOf('smoke-runtime.mjs')
    expect(smoke).toBeGreaterThan(0)
    for (const command of ['git tag', 'git push', 'gh release create']) {
      expect(result.stdout.indexOf(command)).toBeGreaterThan(smoke)
    }
  })

  it('verification-only stops without publication or installation', () => {
    const result = dryRun('--verify-only', '--smoke-runtime')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('smoke-runtime.mjs')
    expect(result.stdout).toContain('nothing published')
    expect(result.stdout).not.toMatch(/git tag|git push|gh release|Start-Process/)
  })

  it('rejects installation combined with verification-only', () => {
    const result = dryRun('--verify-only', '--install')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--verify-only cannot be combined with --install')
  })
})

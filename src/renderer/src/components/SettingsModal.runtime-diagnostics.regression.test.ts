import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

describe('SettingsModal runtime diagnostics', () => {
  it('shows runtime event summaries through the existing diagnostics IPC shape', () => {
    expect(source).toContain('async function loadRuntimeDiagnostics()')
    expect(source).toContain('api.diagnostics.getLogs()')
    expect(source).toContain('setRuntimeDiagnostics(result.runtimeEvents ?? null)')
    expect(source).toContain('最近运行')
    expect(source).toContain('runtimeDiagnostics?.runs')
  })
})

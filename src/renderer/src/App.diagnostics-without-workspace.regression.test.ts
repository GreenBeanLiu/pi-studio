import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./components/SettingsModal.tsx', import.meta.url), 'utf8')

describe('diagnostics before a workspace opens', () => {
  it('keeps an exporter available and does not gate it on workspace state', () => {
    expect(app).toContain('diagnosticsExporter ?? exportStartupDiagnostics')
    expect(app).not.toContain('diagnosticsDisabled={!workspace}')
    expect(settings).not.toContain('diagnosticsDisabled')
  })
})

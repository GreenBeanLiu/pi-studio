import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from './api'
import { diagnosticFileName, exportGlobalDiagnostics, sanitizeForDiagnostics } from './diagnostics-export'

describe('diagnostics export', () => {
  it('redacts secrets recursively and truncates oversized strings', () => {
    expect(
      sanitizeForDiagnostics({ token: 'secret', nested: { apiKey: 'secret', message: 'x'.repeat(4001) } }),
    ).toEqual({
      token: '[redacted]',
      nested: { apiKey: '[redacted]', message: `${'x'.repeat(4000)}\n...[truncated 1 chars]` },
    })
  })

  it('creates a portable timestamped file name', () => {
    expect(diagnosticFileName('no/workspace', new Date('2026-08-26T01:02:03.004Z'))).toBe(
      'pi-studio-diagnostics-no-workspace-2026-08-26T01-02-03-004Z.json',
    )
  })

  it('exports useful startup evidence when settings and runtime are unavailable', async () => {
    const save = vi.fn(async (payload: Parameters<DesktopApi['diagnostics']['save']>[0]) => {
      void payload
      return { ok: true as const, path: 'diagnostics.json' }
    })
    const result = await exportGlobalDiagnostics(
      {
        platform: 'win32',
        app: { version: async () => '0.12.0', piVersion: async () => '0.84.2' },
        settings: { load: async () => Promise.reject(new Error('settings unavailable')) },
        diagnostics: {
          getLogs: async () => ({ ok: true, content: 'startup failed', agentJobs: [] }),
          save,
        },
        pi: { getRuntimeSnapshot: async () => Promise.reject(new Error('runtime unavailable')) },
      },
      new Date('2026-08-26T01:02:03.004Z'),
    )

    expect(result).toEqual({ ok: true, path: 'diagnostics.json' })
    const payload = save.mock.calls[0][0]
    expect(JSON.parse(payload.content)).toMatchObject({
      app: { version: '0.12.0', piVersion: '0.84.2', platform: 'win32' },
      workspace: null,
      settings: null,
      runtime: null,
      logs: { ok: true, content: 'startup failed' },
    })
  })
})

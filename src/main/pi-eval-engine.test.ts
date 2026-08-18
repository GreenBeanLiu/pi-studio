import { describe, expect, it, vi } from 'vitest'
import { PiEvalEngine } from './pi-eval-engine'
import type { EvalEngineRequest } from './eval-driver'

function request(): EvalEngineRequest {
  return {
    caseId: 'case-1', workspacePath: 'D:\\workspace', sessionId: 'eval-session', prompt: 'do it', timeoutMs: 1_000,
    profile: {
      type: 'pi', provider: 'test', model: 'model', security: 'host-full-access',
      env: { TEST_API_KEY: { fromEnv: 'SOURCE_KEY' } },
    },
  }
}

function client() {
  let listener: ((event: unknown) => void) | undefined
  return {
    send: vi.fn(async () => { listener?.({ type: 'agent_start' }) }),
    whenIdle: vi.fn(async () => { listener?.({ type: 'agent_settled' }) }),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    forceDispose: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ sessionId: 'pi-session' })),
    getMessages: vi.fn(async () => ([{ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }])),
    onEvent: vi.fn((next: (event: unknown) => void) => { listener = next; return () => { listener = undefined } }),
  }
}

describe('PiEvalEngine', () => {
  it('runs Pi to settled, records projected events, and owns disposal', async () => {
    const fake = client()
    let compiled: unknown
    const engine = new PiEvalEngine({
      start: async (profile) => { compiled = profile; return fake as never },
      cliPath: () => 'C:\\pi\\cli.js',
      environment: { SOURCE_KEY: 'secret' },
    })
    const events: unknown[] = []

    const result = await engine.run(request(), (event) => events.push(event), new AbortController().signal)

    expect(result).toMatchObject({ finalResponse: 'finished', finishReason: 'settled', exitCode: 0, sessionId: 'pi-session' })
    expect(compiled).toMatchObject({ provider: 'test', model: 'model', env: { TEST_API_KEY: 'secret' }, security: { enforcement: 'none' } })
    expect(events).toHaveLength(2)
    expect(fake.forceDispose).toHaveBeenCalledOnce()
  })

  it('disposes a started client when state discovery fails', async () => {
    const fake = client()
    fake.getState.mockRejectedValueOnce(new Error('state failed'))
    const engine = new PiEvalEngine({
      start: async () => fake as never,
      cliPath: () => 'C:\\pi\\cli.js',
      environment: {},
    })
    const withoutCredential = { ...request(), profile: { ...request().profile, env: undefined } }

    await expect(engine.run(withoutCredential, () => {}, new AbortController().signal)).rejects.toThrow('state failed')
    expect(fake.forceDispose).toHaveBeenCalledOnce()
  })

  it('reports provider totals including cache tokens', async () => {
    const fake = client()
    fake.getMessages.mockResolvedValueOnce([{
      role: 'assistant',
      content: [{ type: 'text', text: 'finished' }],
      usage: { input: 302, output: 136, cacheRead: 130_000, cacheWrite: 816, totalTokens: 131_254 },
    }] as never)
    const engine = new PiEvalEngine({
      start: async () => fake as never,
      cliPath: () => 'C:\\pi\\cli.js',
      environment: {},
    })
    const withoutCredential = { ...request(), profile: { ...request().profile, env: undefined } }

    const result = await engine.run(withoutCredential, () => {}, new AbortController().signal)

    expect(result.usage).toEqual({
      inputTokens: 302,
      outputTokens: 136,
      cacheReadTokens: 130_000,
      cacheWriteTokens: 816,
      totalTokens: 131_254,
    })
  })
})

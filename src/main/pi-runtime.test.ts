import { describe, expect, it, vi } from 'vitest'
import { PiRunTimeoutError, runPromptToSettled, startPiRuntime } from './pi-runtime'
import type { CompiledRunProfile } from './run-profile'

describe('runPromptToSettled', () => {
  it('does not complete a headless run until Pi reports idle', async () => {
    const calls: string[] = []
    const client = {
      prompt: vi.fn(async () => {
        calls.push('prompt')
      }),
      waitForIdle: vi.fn(async () => {
        calls.push('settled')
      }),
      abort: vi.fn(async () => {}),
    }

    await runPromptToSettled(client, 'build the model', 1_000)

    expect(calls).toEqual(['prompt', 'settled'])
    expect(client.waitForIdle).toHaveBeenCalledWith(2_000)
  })

  it('aborts the active run when waiting for idle fails', async () => {
    const failure = new Error('Timed out waiting for agent to become idle')
    const client = {
      prompt: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {
        throw failure
      }),
      abort: vi.fn(async () => {}),
    }

    await expect(runPromptToSettled(client, 'build the model', 50)).rejects.toBe(failure)
    expect(client.abort).toHaveBeenCalledOnce()
  })

  it('owns the timeout and reports a stable timeout error', async () => {
    vi.useFakeTimers()
    const client = {
      prompt: vi.fn(async () => {}),
      waitForIdle: vi.fn(() => new Promise<void>(() => {})),
      abort: vi.fn(async () => {}),
    }

    const result = runPromptToSettled(client, 'build the model', 50)
    const rejection = expect(result).rejects.toEqual(new PiRunTimeoutError(50))
    await vi.advanceTimersByTimeAsync(50)

    await rejection
    expect(client.abort).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('owns the timeout while prompt dispatch is stalled', async () => {
    vi.useFakeTimers()
    const client = {
      prompt: vi.fn(() => new Promise<void>(() => {})),
      waitForIdle: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }

    const result = runPromptToSettled(client, 'build the model', 50)
    const rejection = expect(result).rejects.toEqual(new PiRunTimeoutError(50))
    await vi.advanceTimersByTimeAsync(50)

    await rejection
    expect(client.waitForIdle).not.toHaveBeenCalled()
    expect(client.abort).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})

describe('startPiRuntime', () => {
  it('owns RpcClient construction and startup for a compiled profile', async () => {
    const options: unknown[] = []
    const starts: string[] = []
    const thinkingLevels: string[] = []
    class FakeRpcClient {
      constructor(value: unknown) {
        options.push(value)
      }
      async start() {
        starts.push('started')
      }
      async setThinkingLevel(level: 'high') {
        thinkingLevels.push(level)
      }
    }
    const profile = {
      kind: 'routine',
      cwd: 'D:\\repo',
      provider: 'openai',
      model: 'gpt-test',
      env: { OPENAI_API_KEY: 'secret' },
      cliPath: 'C:\\pi\\cli.js',
      args: ['--no-extensions'],
      thinkingLevel: 'high',
      sandboxMode: null,
      security: {
        requested: 'full-access',
        filesystemMode: 'danger-full-access',
        networkMode: 'unrestricted',
        backend: 'host',
        enforcement: 'none',
        hostCodeExecution: false,
        reason: 'test',
      },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile

    const client = await startPiRuntime(profile, {
      loadClient: async () => FakeRpcClient,
      runtimePath: () => 'C:\\electron.exe',
      nodeEnv: (env) => ({ ...env, ELECTRON_RUN_AS_NODE: '1' }),
    })

    expect(client).toBeInstanceOf(FakeRpcClient)
    expect(starts).toEqual(['started'])
    expect(thinkingLevels).toEqual(['high'])
    expect(options).toEqual([
      {
        cwd: 'D:\\repo',
        provider: 'openai',
        model: 'gpt-test',
        env: { OPENAI_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1' },
        cliPath: 'C:\\pi\\cli.js',
        runtimePath: 'C:\\electron.exe',
        args: ['--no-extensions'],
      },
    ])
  })
})

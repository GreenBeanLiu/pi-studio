import { describe, expect, it, vi } from 'vitest'
import { PiRunTimeoutError, runPromptToSettled, startPiRuntime } from './pi-runtime'
import type { CompiledRunProfile } from './run-profile'

describe('runPromptToSettled', () => {
  it('does not complete a headless run until Pi reports idle', async () => {
    const calls: string[] = []
    const client = {
      send: vi.fn(async () => {
        calls.push('prompt')
      }),
      whenIdle: vi.fn(async () => {
        calls.push('settled')
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }

    await runPromptToSettled(client, 'build the model', 1_000)

    expect(calls).toEqual(['prompt', 'settled'])
    expect(client.whenIdle).toHaveBeenCalledWith(2_000)
  })

  it('aborts the active run when waiting for idle fails', async () => {
    const failure = new Error('Timed out waiting for agent to become idle')
    const client = {
      send: vi.fn(async () => {}),
      whenIdle: vi.fn(async () => {
        throw failure
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }

    await expect(runPromptToSettled(client, 'build the model', 50)).rejects.toBe(failure)
    expect(client.cancel).toHaveBeenCalledOnce()
  })

  it('owns the timeout and reports a stable timeout error', async () => {
    vi.useFakeTimers()
    const client = {
      send: vi.fn(async () => {}),
      whenIdle: vi.fn(() => new Promise<void>(() => {})),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }

    const result = runPromptToSettled(client, 'build the model', 50)
    const rejection = expect(result).rejects.toEqual(new PiRunTimeoutError(50))
    await vi.advanceTimersByTimeAsync(50)

    await rejection
    expect(client.cancel).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('owns the timeout while prompt dispatch is stalled', async () => {
    vi.useFakeTimers()
    const client = {
      send: vi.fn(() => new Promise<void>(() => {})),
      whenIdle: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }

    const result = runPromptToSettled(client, 'build the model', 50)
    const rejection = expect(result).rejects.toEqual(new PiRunTimeoutError(50))
    await vi.advanceTimersByTimeAsync(50)

    await rejection
    expect(client.whenIdle).not.toHaveBeenCalled()
    expect(client.cancel).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})

describe('startPiRuntime', () => {
  it('owns RpcClient construction and startup for a compiled profile', async () => {
    const options: unknown[] = []
    const starts: string[] = []
    const thinkingLevels: string[] = []
    const lifecycle: string[] = []
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
      async prompt(message: string) {
        lifecycle.push(`send:${message}`)
      }
      async waitForIdle(timeout?: number) {
        lifecycle.push(`idle:${timeout}`)
      }
      async abort() {
        lifecycle.push('cancel')
      }
      async stop() {
        lifecycle.push('dispose')
      }
      async getState() {
        return { sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }
      }
      async getMessages() { return [] }
      async getCommands() { return [] }
      onEvent() {
        return () => {}
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
      engineVersion: () => '0.80.7-test',
      runtimeId: () => 'runtime-1',
    })

    expect(client).not.toBeInstanceOf(FakeRpcClient)
    expect(client.id).toBe('runtime-1')
    expect(client.capabilities).toMatchObject({
      engine: 'pi',
      engineVersion: '0.80.7-test',
      protocolVersion: 'rpc-v1',
      sessionFormatVersion: 'pi-jsonl-v1',
      handshake: { verified: true, state: true, messages: true, commands: true },
      features: {
        listSessions: true,
        resume: false,
        fork: false,
        images: true,
        compact: false,
      },
    })
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

    await client.send('hello')
    await client.whenIdle(1_234)
    await client.cancel('test cancellation')
    await client.dispose()
    expect(lifecycle).toEqual(['send:hello', 'idle:1234', 'cancel', 'dispose'])
  })

  it('fails startup when the adapter cannot satisfy the core run handle contract', async () => {
    class IncompleteRpcClient {
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return Promise.resolve() }
    }
    const profile = {
      kind: 'routine',
      cwd: 'D:\\repo',
      provider: 'openai',
      env: {},
      cliPath: 'C:\\pi\\cli.js',
      args: [],
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

    await expect(
      startPiRuntime(profile, {
        loadClient: async () => IncompleteRpcClient,
        runtimePath: () => 'C:\\electron.exe',
        nodeEnv: (env) => env,
        engineVersion: () => '0.80.7-test',
        runtimeId: () => 'runtime-1',
      }),
    ).rejects.toThrow('missing required RPC capabilities')
  })

  it('stops a partially started adapter when startup configuration fails', async () => {
    const stops: string[] = []
    class FailingRpcClient {
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.reject(new Error('thinking rejected')) }
      stop() { stops.push('stopped'); return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
    }
    const profile = {
      kind: 'routine',
      cwd: 'D:\\repo',
      provider: 'openai',
      env: {},
      cliPath: 'C:\\pi\\cli.js',
      args: [],
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

    await expect(
      startPiRuntime(profile, {
        loadClient: async () => FailingRpcClient,
        runtimePath: () => 'C:\\electron.exe',
        nodeEnv: (env) => env,
        engineVersion: () => '0.80.7-test',
        runtimeId: () => 'runtime-1',
      }),
    ).rejects.toThrow('thinking rejected')
    expect(stops).toEqual(['stopped'])
  })

  it('fails closed and stops the child when the runtime handshake is incompatible', async () => {
    const stops: string[] = []
    class IncompatibleRpcClient {
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { stops.push('stopped'); return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: '', isStreaming: 'no', thinkingLevel: null }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'chat',
      cwd: 'D:\\repo',
      provider: 'openai',
      env: {},
      cliPath: 'C:\\pi\\cli.js',
      args: [],
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

    await expect(
      startPiRuntime(profile, {
        loadClient: async () => IncompatibleRpcClient,
        runtimePath: () => 'C:\\electron.exe',
        nodeEnv: (env) => env,
        engineVersion: () => '0.80.7-test',
        runtimeId: () => 'runtime-1',
      }),
    ).rejects.toThrow('incompatible rpc-v1 state payload')
    expect(stops).toEqual(['stopped'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  PiRunTimeoutError,
  runPromptToSettled,
  startPiRuntime,
  startPiRuntimeCancellable,
} from './pi-runtime'
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

  it('registers startup ownership before start settles and cleans up on abort', async () => {
    let resolveStart!: () => void
    const startPending = new Promise<void>((resolve) => {
      resolveStart = resolve
    })
    const stops: string[] = []
    class StartingRpcClient {
      start() { return startPending }
      setThinkingLevel() { return Promise.resolve() }
      stop() { stops.push('stopped'); return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const controller = new AbortController()
    let ownedCleanup: (() => Promise<void>) | undefined
    const startup = startPiRuntimeCancellable(profile, controller.signal, {
      dependencies: {
        loadClient: async () => StartingRpcClient,
        runtimePath: () => 'C:\\electron.exe',
        nodeEnv: (env) => env,
        engineVersion: () => '0.80.7-test',
        runtimeId: () => 'runtime-1',
      },
      onOwned: (cleanup) => { ownedCleanup = cleanup },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(ownedCleanup).toEqual(expect.any(Function))
    controller.abort(new Error('cancelled during startup'))
    await ownedCleanup?.()
    resolveStart()

    await expect(startup).rejects.toThrow('cancelled during startup')
    expect(stops.length).toBeGreaterThan(0)
  })

  it('waits for process exit before force disposal resolves', async () => {
    let exit: (() => void) | undefined
    let forceDisposed = false
    class ProcessRpcClient {
      process = {
        on: (event: 'exit' | 'error', listener: () => void) => {
          if (event === 'exit') exit = listener
        },
        kill: () => true,
      }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => ProcessRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1',
    })

    const disposal = handle.forceDispose().then(() => { forceDisposed = true })
    await Promise.resolve()
    expect(forceDisposed).toBe(false)
    exit?.()
    await disposal
    expect(forceDisposed).toBe(true)
  })

  it('terminates the owned process tree when the adapter exposes a pid', async () => {
    let exit: (() => void) | undefined
    const directKill = vi.fn(() => true)
    const terminateTree = vi.fn(async (pid: number) => { void pid; exit?.() })
    class TreeProcessRpcClient {
      process = {
        pid: 43_210,
        on: (event: 'exit' | 'error', listener: () => void) => {
          if (event === 'exit') exit = listener
        },
        kill: directKill,
      }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => TreeProcessRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1', terminateTree,
    })

    await handle.forceDispose()

    expect(terminateTree).toHaveBeenCalledWith(43_210)
    expect(directKill).not.toHaveBeenCalled()
  })

  it('observes a synchronous process exit emitted by kill', async () => {
    let exit: (() => void) | undefined
    class SynchronousExitRpcClient {
      process = {
        on: (event: 'exit' | 'error', listener: () => void) => {
          if (event === 'exit') exit = listener
        },
        kill: () => { exit?.(); return true },
      }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => SynchronousExitRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1',
    })

    await expect(handle.forceDispose()).resolves.toBeUndefined()
  })

  it('keeps normal stop available when forced disposal fails', async () => {
    let stopAttempts = 0
    class RetryableRpcClient {
      process = { on: () => {}, kill: () => false }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() {
        stopAttempts += 1
        return stopAttempts === 1 ? Promise.reject(new Error('stop failed')) : Promise.resolve()
      }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => RetryableRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1',
    })

    await expect(handle.forceDispose()).rejects.toThrow('stop failed')
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(stopAttempts).toBe(2)
  })

  it('does not treat a process error as confirmed exit', async () => {
    let processError: ((error: Error) => void) | undefined
    let stops = 0
    class ProcessErrorRpcClient {
      process = {
        on: (event: 'exit' | 'error', listener: (value: Error) => void) => {
          if (event === 'error') processError = listener
        },
        kill: () => true,
      }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { stops += 1; return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => ProcessErrorRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1',
    })

    const disposal = handle.forceDispose()
    processError?.(new Error('spawn error'))
    await expect(disposal).rejects.toThrow('spawn error')
    await handle.dispose()
    expect(stops).toBe(1)
  })

  it('bounds the graceful-stop fallback used by forced cleanup', async () => {
    vi.useFakeTimers()
    class HungStopRpcClient {
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return new Promise<void>(() => {}) }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      onEvent() { return () => {} }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\\repo', provider: 'openai', env: {}, cliPath: 'C:\\pi\\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile
    const handle = await startPiRuntime(profile, {
      loadClient: async () => HungStopRpcClient,
      runtimePath: () => 'C:\\electron.exe', nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test', runtimeId: () => 'runtime-1',
    })

    const disposal = handle.forceDispose()
    const rejection = expect(disposal).rejects.toThrow('stop did not complete')
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    vi.useRealTimers()
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

describe('unattended approval gate', () => {
  class DialogRpcClient {
    static listeners: Array<(event: unknown) => void> = []
    static written: string[] = []
    process = {
      pid: 4321,
      stdin: { write: (chunk: string) => DialogRpcClient.written.push(chunk) },
    }
    start() { return Promise.resolve() }
    setThinkingLevel() { return Promise.resolve() }
    stop() { return Promise.resolve() }
    prompt() { return Promise.resolve() }
    waitForIdle() { return Promise.resolve() }
    abort() { return Promise.resolve() }
    getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
    getMessages() { return Promise.resolve([]) }
    getCommands() { return Promise.resolve([]) }
    onEvent(listener: (event: unknown) => void) {
      DialogRpcClient.listeners.push(listener)
      return () => {
        DialogRpcClient.listeners = DialogRpcClient.listeners.filter((item) => item !== listener)
      }
    }
  }

  const dialogProfile = (kind: CompiledRunProfile['kind']): CompiledRunProfile =>
    ({
      kind,
      cwd: 'D:\repo',
      provider: 'openai',
      env: {},
      cliPath: 'C:\pi\cli.js',
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
    }) satisfies CompiledRunProfile

  const startDialogRuntime = (kind: CompiledRunProfile['kind']) => {
    DialogRpcClient.listeners = []
    DialogRpcClient.written = []
    return startPiRuntime(dialogProfile(kind), {
      loadClient: async () => DialogRpcClient,
      runtimePath: () => 'C:\electron.exe',
      nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test',
      runtimeId: () => 'runtime-1',
    })
  }

  const emit = (event: unknown): void => {
    for (const listener of [...DialogRpcClient.listeners]) listener(event)
  }

  it('denies a blocking dialog raised by a run nobody is watching', async () => {
    const client = await startDialogRuntime('routine')

    emit({
      type: 'extension_ui_request',
      id: 'confirm-1',
      method: 'confirm',
      title: '运行命令',
      message: 'Command: rm -rf build',
    })

    expect(DialogRpcClient.written).toEqual([
      `${JSON.stringify({ type: 'extension_ui_response', id: 'confirm-1', cancelled: true })}\n`,
    ])
    expect(client.deniedApprovals()).toMatchObject([{ id: 'confirm-1', outcome: 'unavailable' }])
  })

  it('leaves an interactive chat approval for the user to answer', async () => {
    const client = await startDialogRuntime('chat')

    emit({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'x', message: 'y' })

    expect(DialogRpcClient.written).toEqual([])
    expect(client.deniedApprovals()).toEqual([])
  })

  it('stops answering once the run is disposed', async () => {
    const client = await startDialogRuntime('code-model')
    await client.dispose()

    emit({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'x', message: 'y' })

    expect(DialogRpcClient.written).toEqual([])
  })
})

describe('unattended approval delivery failures', () => {
  it('keeps a denial that could not be delivered visible instead of losing it', async () => {
    let listener: ((event: unknown) => void) | undefined
    class StdinlessRpcClient {
      process = { pid: 4321 }
      start() { return Promise.resolve() }
      setThinkingLevel() { return Promise.resolve() }
      stop() { return Promise.resolve() }
      prompt() { return Promise.resolve() }
      waitForIdle() { return Promise.resolve() }
      abort() { return Promise.resolve() }
      getState() { return Promise.resolve({ sessionId: 'session-1', isStreaming: false, thinkingLevel: 'high' }) }
      getMessages() { return Promise.resolve([]) }
      getCommands() { return Promise.resolve([]) }
      onEvent(fn: (event: unknown) => void) {
        listener = fn
        return () => { listener = undefined }
      }
    }
    const profile = {
      kind: 'routine', cwd: 'D:\repo', provider: 'openai', env: {}, cliPath: 'C:\pi\cli.js', args: [],
      thinkingLevel: 'high', sandboxMode: null,
      security: { requested: 'full-access', filesystemMode: 'danger-full-access', networkMode: 'unrestricted', backend: 'host', enforcement: 'none', hostCodeExecution: false, reason: 'test' },
      profileDigest: 'digest',
    } satisfies CompiledRunProfile

    const client = await startPiRuntime(profile, {
      loadClient: async () => StdinlessRpcClient,
      runtimePath: () => 'C:\electron.exe',
      nodeEnv: (env) => env,
      engineVersion: () => '0.80.7-test',
      runtimeId: () => 'runtime-1',
    })
    listener?.({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'x', message: 'y' })

    expect(client.deniedApprovals()).toMatchObject([
      { id: 'confirm-1', deliveryError: 'Agent process stdin is not available' },
    ])
  })
})

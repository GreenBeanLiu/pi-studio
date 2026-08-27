import { describe, expect, it, vi } from 'vitest'
import { RuntimeHost } from './runtime-host'
import type { PiAgentRunHandle } from './pi-runtime'
import type { CompiledRunProfile } from './run-profile'
import type { RuntimeEventRecord } from './runtime-event-recorder'

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
  declaredCapabilities: { subagents: false },
  profileDigest: 'digest',
} satisfies CompiledRunProfile

describe('RuntimeHost', () => {
  it('compiles and starts a run through one seam', async () => {
    const client = {} as PiAgentRunHandle
    const compileProfile = vi.fn(async () => profile)
    const startRuntime = vi.fn(async () => client)
    const startCancellableRuntime = vi.fn()
    const appendLog = vi.fn()
    const host = new RuntimeHost({
      compileProfile,
      startRuntime,
      startCancellableRuntime,
      appendLog,
    })

    const run = await host.start('routine', 'D:\\repo', {
      extensions: ['C:\\pi-studio\\workspace-memory.ts'],
      audit: { routineId: 'routine-1' },
    })

    expect(run).toEqual({ profile, client })
    expect(compileProfile).toHaveBeenCalledWith('routine', 'D:\\repo', {
      extensions: ['C:\\pi-studio\\workspace-memory.ts'],
    })
    expect(startRuntime).toHaveBeenCalledWith(profile)
    expect(startCancellableRuntime).not.toHaveBeenCalled()
    expect(appendLog).toHaveBeenCalledWith('info', 'agent.start', 'Pi agent process started', {
      kind: 'routine',
      cwd: 'D:\\repo',
      provider: 'openai',
      model: 'gpt-test',
      sandboxMode: null,
      security: profile.security,
      profileDigest: 'digest',
      routineId: 'routine-1',
    })
  })

  it('starts a precompiled profile with cancellable startup ownership', async () => {
    const client = {} as PiAgentRunHandle
    const controller = new AbortController()
    const onOwned = vi.fn()
    const compileProfile = vi.fn()
    const startRuntime = vi.fn()
    const startCancellableRuntime = vi.fn(async () => client)
    const appendLog = vi.fn()
    const host = new RuntimeHost({
      compileProfile,
      startRuntime,
      startCancellableRuntime,
      appendLog,
    })

    const run = await host.startCompiled(profile, {
      signal: controller.signal,
      onOwned,
      audit: { caseId: 'case-1' },
    })

    expect(run).toEqual({ profile, client })
    expect(compileProfile).not.toHaveBeenCalled()
    expect(startRuntime).not.toHaveBeenCalled()
    expect(startCancellableRuntime).toHaveBeenCalledWith(profile, controller.signal, { onOwned })
    expect(appendLog).toHaveBeenCalledWith(
      'info',
      'agent.start',
      'Pi agent process started',
      expect.objectContaining({ kind: 'routine', caseId: 'case-1' }),
    )
  })

  it('records run lifecycle events behind the runtime host seam', async () => {
    const records: RuntimeEventRecord[] = []
    const observed: { listener?: (event: unknown) => void; detached: boolean } = {
      detached: false,
    }
    const client = {
      id: 'run-1',
      onEvent: vi.fn((listener: (event: unknown) => void) => {
        observed.listener = listener
        return () => {
          observed.detached = true
          observed.listener = undefined
        }
      }),
      dispose: vi.fn(async () => {}),
      forceDispose: vi.fn(async () => {}),
    } as unknown as PiAgentRunHandle
    const compileProfile = vi.fn()
    const startRuntime = vi.fn(async () => client)
    const startCancellableRuntime = vi.fn()
    const appendLog = vi.fn()
    const host = new RuntimeHost({
      compileProfile,
      startRuntime,
      startCancellableRuntime,
      appendLog,
      resolveRecorder: () => ({
        append: (record) => {
          records.push(record)
        },
      }),
    })

    const run = await host.startCompiled(profile, {
      audit: { source: 'test' },
    })
    expect(run.client).toBe(client)
    expect(client.onEvent).toHaveBeenCalledOnce()
    expect(records[0]).toMatchObject({
      type: 'run.started',
      runId: 'run-1',
      profile: {
        kind: 'routine',
        cwd: 'D:\\repo',
        provider: 'openai',
        model: 'gpt-test',
        sandboxMode: null,
        profileDigest: 'digest',
      },
      audit: { source: 'test' },
    })
    expect(JSON.stringify(records[0])).not.toContain('OPENAI_API_KEY')

    observed.listener?.({ type: 'agent_settled', result: 'ok' })
    await client.dispose()

    expect(records.map((record) => record.type)).toEqual([
      'run.started',
      'runtime.event',
      'run.settled',
      'cleanup',
    ])
    expect(records[1]).toMatchObject({
      type: 'runtime.event',
      runId: 'run-1',
      event: { type: 'agent_settled', result: 'ok' },
    })
    expect(records[2]).toMatchObject({ type: 'run.settled', runId: 'run-1' })
    expect(records[3]).toMatchObject({
      type: 'cleanup',
      runId: 'run-1',
      mode: 'dispose',
      status: 'ok',
    })
    expect(observed.detached).toBe(true)
  })

  it('does not fail startup when the runtime recorder cannot initialize', async () => {
    const client = { id: 'run-1' } as PiAgentRunHandle
    const compileProfile = vi.fn()
    const startRuntime = vi.fn(async () => client)
    const startCancellableRuntime = vi.fn()
    const appendLog = vi.fn()
    const host = new RuntimeHost({
      compileProfile,
      startRuntime,
      startCancellableRuntime,
      appendLog,
      resolveRecorder: async () => {
        throw new Error('no log directory')
      },
    })

    await expect(host.startCompiled(profile)).resolves.toEqual({ profile, client })
    expect(appendLog).toHaveBeenCalledWith(
      'warn',
      'runtime.events',
      'Failed to initialize runtime recorder',
      { runId: 'run-1', error: 'no log directory' },
    )
  })
})

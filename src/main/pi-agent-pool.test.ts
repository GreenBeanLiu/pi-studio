import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPool, type AgentPoolRuntimeLauncher } from './pi-agent-pool'
import type { AgentPoolHost } from './pi-agent-pool'
import type { LaunchContext } from './pi-agent-entry'
import type { PiAgentRunHandle } from './pi-runtime'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

let userData = ''

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}))

function launchContext(): LaunchContext {
  return {
    kind: 'chat',
    cwd: 'D:\\repo',
    provider: 'openai',
    model: 'gpt-test',
    env: { PI_CODING_AGENT_DIR: 'D:\\agent' },
    cliPath: 'C:\\pi\\cli.js',
    args: [],
    thinkingLevel: 'high',
    sandboxMode: null,
    sandboxSessionPaths: false,
    security: {
      requested: 'full-access',
      filesystemMode: 'danger-full-access',
      networkMode: 'unrestricted',
      backend: 'host',
      enforcement: 'none',
      hostCodeExecution: false,
      reason: 'test',
    },
    declaredCapabilities: { subagents: true },
    profileDigest: 'digest',
  }
}

function host(): AgentPoolHost {
  return {
    currentWorkspacePath: () => 'D:\\repo',
    isActive: () => true,
    handleRuntimeEvent: vi.fn(),
    onEntryRemoved: vi.fn(),
    emitStatus: vi.fn(),
    emitActivity: vi.fn(),
  }
}

function expectRuntimeEventListener(
  value: unknown,
): asserts value is (event: PiRuntimeEvent) => void {
  expect(value).toEqual(expect.any(Function))
}

function client(overrides: Record<string, unknown> = {}): PiAgentRunHandle {
  return {
    capabilities: {
      engine: 'pi',
      engineVersion: '0.84.2-test',
      protocolVersion: 'rpc-v1',
      sessionFormatVersion: 'pi-jsonl-v1',
      handshake: { verified: true, state: true, messages: true, commands: true },
      features: {
        listSessions: true,
        resume: true,
        fork: false,
        subagents: true,
        images: true,
        compact: true,
        approvals: true,
        sessionRead: true,
      },
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    respondExtensionUi: vi.fn(),
    conversation: vi.fn(() => null),
    observeProcess: vi.fn(),
    processId: vi.fn(() => 42),
    dispose: vi.fn(async () => {}),
    forceDispose: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: null })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    ...overrides,
  } as unknown as PiAgentRunHandle
}

describe('AgentPool runtime host seam', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pi-agent-pool-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('launches chat sessions through the injected runtime host while keeping pool-owned env', async () => {
    const launched: Array<{ profile: LaunchContext; audit: Record<string, unknown> | undefined }> = []
    const runtimeClient = client({
      getState: vi.fn(async () => ({
        sessionId: 'session-1',
        sessionFile: 'D:\\agent\\sessions\\session.jsonl',
      })),
      switchSession: vi.fn(async () => ({ cancelled: false })),
    })
    const launchRuntime: AgentPoolRuntimeLauncher = vi.fn(async (profile, options) => {
      launched.push({ profile, audit: options?.audit })
      return { client: runtimeClient }
    })
    const pool = new AgentPool(host(), launchRuntime)
    pool.setLaunch(launchContext())

    const entry = await pool.spawn('D:\\agent\\sessions\\previous.jsonl')

    expect(entry.client).toBe(runtimeClient)
    expect(entry.pi).toBe(runtimeClient)
    expect(launchRuntime).toHaveBeenCalledOnce()
    expect(launched[0].audit).toEqual({
      source: 'chat-pool',
      requestedSessionFile: 'D:\\agent\\sessions\\previous.jsonl',
    })
    expect(launched[0].profile).toMatchObject({
      kind: 'chat',
      cwd: 'D:\\repo',
      env: {
        PI_CODING_AGENT_DIR: 'D:\\agent',
        PI_STUDIO_STATUS_FILE: expect.stringContaining('runtime-status'),
        PI_STUDIO_ARTIFACT_DIR: join(userData, 'pi-agent', 'artifacts'),
        PI_STUDIO_ARTIFACT_WORKSPACE_KEY: expect.any(String),
      },
    })
    expect(runtimeClient.switchSession).toHaveBeenCalledWith('D:\\agent\\sessions\\previous.jsonl')
    expect(entry.sessionId).toBe('session-1')
    expect(entry.sessionFile).toBe('D:\\agent\\sessions\\session.jsonl')
  })

  it('passes raw runtime events back to the pool host', async () => {
    const observed: { listener?: (event: PiRuntimeEvent) => void } = {}
    const runtimeClient = client({
      getState: vi.fn(async () => ({ sessionId: 'session-1', sessionFile: null })),
      onEvent: vi.fn((next: (event: PiRuntimeEvent) => void) => {
        observed.listener = next
        return () => {
          observed.listener = undefined
        }
      }),
    })
    const runtimeHost = vi.fn(async () => ({ client: runtimeClient }))
    const poolHost = host()
    const pool = new AgentPool(poolHost, runtimeHost)
    pool.setLaunch(launchContext())

    const entry = await pool.spawn(null)
    expectRuntimeEventListener(observed.listener)
    observed.listener({ type: 'agent_start' } as PiRuntimeEvent)

    expect(poolHost.handleRuntimeEvent).toHaveBeenCalledWith(entry, { type: 'agent_start' })
  })
})

import { randomUUID } from 'crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  AgentSessionEvent,
  RpcClient as RpcClientType,
} from '@earendil-works/pi-coding-agent'
import type { CompiledRunProfile } from './run-profile'
import {
  embeddedNodeEnv,
  loadRpcClient,
  resolveEmbeddedNodePath,
  resolvePiEngineVersion,
} from './pi-process'
import { DEFAULT_THINKING_LEVEL } from '../shared/agent-defaults'
import type {
  ExtensionUiResponse,
  PiRuntimeCapabilities,
  SlashCommand,
} from '../shared/ipc/contract'

type StartablePiClient = {
  start: () => Promise<void>
  setThinkingLevel: (level: typeof DEFAULT_THINKING_LEVEL) => Promise<void>
}
type PiClientConstructor<C extends StartablePiClient> = new (options: {
  cwd: string
  env: Record<string, string>
  runtimePath: string
  provider: string
  model?: string
  cliPath: string
  args: string[]
}) => C

type StartPiRuntimeDependencies<C extends StartablePiClient> = {
  loadClient: () => Promise<PiClientConstructor<C>>
  runtimePath: () => string
  nodeEnv: (env: Record<string, string>) => Record<string, string>
  engineVersion: () => string
  runtimeId: () => string
}

const DEFAULT_START_DEPENDENCIES: StartPiRuntimeDependencies<RpcClientType> = {
  loadClient: loadRpcClient,
  runtimePath: resolveEmbeddedNodePath,
  nodeEnv: embeddedNodeEnv,
  engineVersion: resolvePiEngineVersion,
  runtimeId: randomUUID,
}

type RuntimeProcess = {
  stdin?: { write: (chunk: string) => void }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void }
  on: {
    (event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    (event: 'error', listener: (error: Error) => void): void
  }
}

const REQUIRED_CORE_METHODS = [
  'prompt',
  'waitForIdle',
  'abort',
  'stop',
  'onEvent',
  'getState',
  'getMessages',
  'getCommands',
] as const
const SUPPORTED_ENGINE_VERSION = /^0\.80\./

function assertCoreCapabilities(client: StartablePiClient): asserts client is RpcClientType {
  const candidate = client as unknown as Record<string, unknown>
  const missing = REQUIRED_CORE_METHODS.filter((method) => typeof candidate[method] !== 'function')
  if (missing.length > 0) {
    throw new Error(`Pi adapter missing required RPC capabilities: ${missing.join(', ')}`)
  }
}

function runtimeCapabilities(
  client: RpcClientType,
  engineVersion: string,
  declaredSubagents: boolean,
): PiRuntimeCapabilities {
  const candidate = client as unknown as Record<string, unknown>
  const process = candidate.process as RuntimeProcess | undefined
  return Object.freeze({
    engine: 'pi',
    engineVersion,
    protocolVersion: 'rpc-v1',
    sessionFormatVersion: 'pi-jsonl-v1',
    handshake: Object.freeze({ verified: true, state: true, messages: true, commands: true }),
    features: Object.freeze({
      listSessions: true,
      resume: typeof candidate.switchSession === 'function',
      fork: typeof candidate.fork === 'function',
      subagents: declaredSubagents,
      images: true,
      compact: typeof candidate.compact === 'function',
      approvals: typeof process?.stdin?.write === 'function',
      sessionRead:
        typeof candidate.getState === 'function' && typeof candidate.getMessages === 'function',
    }),
  })
}

async function verifyRuntimeHandshake(client: RpcClientType, engineVersion: string): Promise<void> {
  if (!engineVersion.trim()) throw new Error('Pi runtime handshake returned an empty engine version')
  if (!SUPPORTED_ENGINE_VERSION.test(engineVersion)) {
    throw new Error(
      `Pi engine ${engineVersion} is outside the verified rpc-v1/pi-jsonl-v1 compatibility range`,
    )
  }
  const state = await client.getState()
  if (
    !state ||
    typeof state.sessionId !== 'string' ||
    !state.sessionId ||
    typeof state.isStreaming !== 'boolean' ||
    typeof state.thinkingLevel !== 'string'
  ) {
    throw new Error('Pi runtime handshake returned an incompatible rpc-v1 state payload')
  }
  const messages = await client.getMessages()
  if (!Array.isArray(messages)) {
    throw new Error('Pi runtime handshake returned an incompatible pi-jsonl-v1 message payload')
  }
  const commands = await client.getCommands()
  if (!Array.isArray(commands)) {
    throw new Error('Pi runtime handshake returned an incompatible command payload')
  }
}

export class PiAgentRunHandle {
  readonly capabilities: PiRuntimeCapabilities
  private disposed = false

  constructor(
    readonly id: string,
    readonly profileDigest: string,
    private readonly client: RpcClientType,
    engineVersion: string,
    declaredSubagents: boolean,
  ) {
    this.capabilities = runtimeCapabilities(client, engineVersion, declaredSubagents)
  }

  send(message: string, images?: ImageContent[]): Promise<void> {
    return this.client.prompt(message, images)
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    return this.client.steer(message, images)
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    return this.client.followUp(message, images)
  }

  cancel(reason?: string): Promise<void> {
    void reason
    return this.client.abort()
  }

  whenIdle(timeout?: number): Promise<void> {
    return this.client.waitForIdle(timeout)
  }

  onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    return this.client.onEvent(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.client.stop()
  }

  observeProcess(listeners: {
    stderr?: (chunk: Buffer | string) => void
    exit?: (code: number | null, signal: string | null) => void
    error?: (error: Error) => void
  }): void {
    const process = (this.client as unknown as { process?: RuntimeProcess }).process
    if (!process) return
    if (listeners.stderr) process.stderr?.on('data', listeners.stderr)
    if (listeners.exit) process.on('exit', listeners.exit)
    if (listeners.error) process.on('error', listeners.error)
  }

  respondExtensionUi(response: ExtensionUiResponse): void {
    const process = (this.client as unknown as { process?: RuntimeProcess }).process
    if (!process?.stdin) throw new Error('Agent process stdin is not available')
    process.stdin.write(`${JSON.stringify(response)}\n`)
  }

  switchSession(...args: Parameters<RpcClientType['switchSession']>) {
    return this.client.switchSession(...args)
  }
  getState() { return this.client.getState() }
  getMessages() { return this.client.getMessages() }
  getAvailableModels() { return this.client.getAvailableModels() }
  bash(...args: Parameters<RpcClientType['bash']>): Promise<unknown> {
    return this.client.bash(...args)
  }
  setModel(...args: Parameters<RpcClientType['setModel']>) { return this.client.setModel(...args) }
  setThinkingLevel(...args: Parameters<RpcClientType['setThinkingLevel']>) {
    return this.client.setThinkingLevel(...args)
  }
  setSteeringMode(...args: Parameters<RpcClientType['setSteeringMode']>) {
    return this.client.setSteeringMode(...args)
  }
  setFollowUpMode(...args: Parameters<RpcClientType['setFollowUpMode']>) {
    return this.client.setFollowUpMode(...args)
  }
  setAutoCompaction(...args: Parameters<RpcClientType['setAutoCompaction']>) {
    return this.client.setAutoCompaction(...args)
  }
  compact(...args: Parameters<RpcClientType['compact']>) { return this.client.compact(...args) }
  getCommands(): Promise<SlashCommand[]> {
    return this.client.getCommands()
  }
  setSessionName(...args: Parameters<RpcClientType['setSessionName']>) {
    return this.client.setSessionName(...args)
  }
}

/** Start a Pi process from one compiled, auditable launch profile. */
export function startPiRuntime(profile: CompiledRunProfile): Promise<PiAgentRunHandle>
export function startPiRuntime<C extends StartablePiClient>(
  profile: CompiledRunProfile,
  dependencies: StartPiRuntimeDependencies<C>,
): Promise<PiAgentRunHandle>
export async function startPiRuntime(
  profile: CompiledRunProfile,
  dependencies?: StartPiRuntimeDependencies<StartablePiClient>,
): Promise<PiAgentRunHandle> {
  const resolved = dependencies ?? DEFAULT_START_DEPENDENCIES
  const RpcClient = await resolved.loadClient()
  const client = new RpcClient({
    cwd: profile.cwd,
    env: resolved.nodeEnv(profile.env),
    runtimePath: resolved.runtimePath(),
    provider: profile.provider,
    model: profile.model,
    cliPath: profile.cliPath,
    args: profile.args,
  })
  let engineVersion = ''
  try {
    await client.start()
    await client.setThinkingLevel(profile.thinkingLevel)
    assertCoreCapabilities(client)
    engineVersion = resolved.engineVersion()
    await verifyRuntimeHandshake(client, engineVersion)
  } catch (error) {
    const stop = (client as unknown as { stop?: () => Promise<void> }).stop
    if (stop) await stop.call(client).catch(() => {})
    throw error
  }
  return new PiAgentRunHandle(
    resolved.runtimeId(),
    profile.profileDigest,
    client,
    engineVersion,
    profile.declaredCapabilities?.subagents ?? false,
  )
}

export type AgentRunHandle = {
  send: (message: string, images?: ImageContent[]) => Promise<void>
  whenIdle: (timeout?: number) => Promise<void>
  cancel: (reason?: string) => Promise<void>
  dispose: () => Promise<void>
}

export class PiRunTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Pi run did not settle within ${timeoutMs}ms`)
    this.name = 'PiRunTimeoutError'
  }
}

/** Run one headless Pi prompt through its real terminal condition. */
export async function runPromptToSettled(
  client: AgentRunHandle,
  message: string,
  timeoutMs: number,
  images?: ImageContent[],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const run = (async () => {
      await client.send(message, images)
      // RpcClient defaults this helper to 60 seconds. Keep its cleanup timer
      // behind our owned deadline so longer run profiles retain their budget.
      await client.whenIdle(timeoutMs + 1_000)
    })()
    await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PiRunTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } catch (error) {
    await client.cancel('run failed or timed out').catch(() => {})
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

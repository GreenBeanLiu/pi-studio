import { randomUUID } from 'crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  AgentSessionEvent,
  JsonAgentSessionEvent,
  RpcClient as RpcClientType,
} from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
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
import { terminateProcessTree } from './process-tree'
import {
  answerabilityFor,
  UnattendedApprovalGate,
  type DeniedApproval,
} from './approval-gateway'

type StartablePiClient = {
  start: () => Promise<void>
  setThinkingLevel: (level: typeof DEFAULT_THINKING_LEVEL) => Promise<void>
  stop?: () => Promise<void>
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
  terminateTree?: typeof terminateProcessTree
}

const DEFAULT_START_DEPENDENCIES: StartPiRuntimeDependencies<RpcClientType> = {
  loadClient: loadRpcClient,
  runtimePath: resolveEmbeddedNodePath,
  nodeEnv: embeddedNodeEnv,
  engineVersion: resolvePiEngineVersion,
  runtimeId: randomUUID,
}

type RuntimeProcess = {
  pid?: number
  stdin?: { write: (chunk: string) => void }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void }
  on: {
    (event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    (event: 'error', listener: (error: Error) => void): void
  }
  kill?: (signal?: NodeJS.Signals | number) => boolean
}

type CancellableRuntimeOptions<C extends StartablePiClient> = {
  dependencies: StartPiRuntimeDependencies<C>
  onOwned?: (cleanup: () => Promise<void>) => void
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
const SUPPORTED_ENGINE_VERSION = /^0\.84\./

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

function waitForRuntimeExit(
  process: RuntimeProcess,
  timeoutMs = 2_000,
): { promise: Promise<void>; cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let complete!: () => void
  const promise = new Promise<void>((resolve, reject) => {
    complete = (): void => {
      if (timeout) clearTimeout(timeout)
      resolve()
    }
    process.on('exit', complete)
    process.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    timeout = setTimeout(() => reject(new Error('Pi process did not exit after SIGKILL')), timeoutMs)
  })
  return { promise, cancel: complete }
}

async function stopRuntimeWithDeadline(client: StartablePiClient, timeoutMs = 2_000): Promise<void> {
  if (!client.stop) throw new Error('Pi runtime does not expose a cleanup operation')
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.stop(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Pi runtime stop did not complete')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function forceDisposeClient(
  client: StartablePiClient,
  terminateTree: typeof terminateProcessTree = terminateProcessTree,
): Promise<void> {
  const process = (client as unknown as { process?: RuntimeProcess }).process
  if (!process?.kill) {
    await stopRuntimeWithDeadline(client)
    return
  }
  // Attach listeners before kill: some process adapters emit exit synchronously.
  const exit = waitForRuntimeExit(process)
  let killed = false
  if (process.pid) {
    try {
      await terminateTree(process.pid)
      killed = true
    } catch (error) {
      exit.cancel()
      throw error
    }
  } else {
    try {
      killed = process.kill('SIGKILL')
    } catch {
      killed = false
    }
  }
  if (!killed) {
    exit.cancel()
    await stopRuntimeWithDeadline(client)
    return
  }
  await exit.promise
}

type PiRunFailedEvent = {
  type: 'run_failed'
  scope: 'prompt'
  message: string
}

type StableRuntimeEvent = AgentSessionEvent | PiRunFailedEvent

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return structuredClone(message)
}

function ensureContentSlot(message: AssistantMessage, index: number): void {
  while (message.content.length <= index) {
    message.content.push({ type: 'text', text: '' })
  }
}

function applyAssistantDelta(
  message: AssistantMessage,
  event: AssistantMessageEvent,
  toolCallArgumentText: Map<number, string>,
): void {
  if (event.type === 'start') return
  if (event.type === 'done') {
    Object.assign(message, cloneMessage(event.message))
    return
  }
  if (event.type === 'error') {
    Object.assign(message, cloneMessage(event.error))
    return
  }
  ensureContentSlot(message, event.contentIndex)
  const current = message.content[event.contentIndex]
  if (event.type === 'text_start') {
    message.content[event.contentIndex] = { type: 'text', text: '' }
  } else if (event.type === 'text_delta' && current?.type === 'text') {
    current.text += event.delta
  } else if (event.type === 'text_end') {
    message.content[event.contentIndex] = { type: 'text', text: event.content }
  } else if (event.type === 'thinking_start') {
    message.content[event.contentIndex] = { type: 'thinking', thinking: '' }
  } else if (event.type === 'thinking_delta' && current?.type === 'thinking') {
    current.thinking += event.delta
  } else if (event.type === 'thinking_end') {
    message.content[event.contentIndex] = { type: 'thinking', thinking: event.content }
  } else if (event.type === 'toolcall_start') {
    message.content[event.contentIndex] = { type: 'toolCall', id: '', name: '', arguments: {} }
    toolCallArgumentText.set(event.contentIndex, '')
  } else if (event.type === 'toolcall_delta') {
    const toolCall = message.content[event.contentIndex]
    if (toolCall?.type === 'toolCall') {
      const argumentText = `${toolCallArgumentText.get(event.contentIndex) ?? ''}${event.delta}`
      toolCallArgumentText.set(event.contentIndex, argumentText)
      try {
        toolCall.arguments = JSON.parse(argumentText) as Record<string, unknown>
      } catch {
        // Tool-call arguments are often delivered as incomplete JSON fragments.
      }
    }
  } else if (event.type === 'toolcall_end') {
    message.content[event.contentIndex] = event.toolCall
    toolCallArgumentText.delete(event.contentIndex)
  }
}

export class PiAgentRunHandle {
  readonly capabilities: PiRuntimeCapabilities
  private disposed = false
  private streamingAssistant: AssistantMessage | null = null
  private readonly toolCallArgumentText = new Map<number, string>()
  private approvalGate: UnattendedApprovalGate | null = null
  private detachApprovalGate: (() => void) | null = null

  constructor(
    readonly id: string,
    readonly profileDigest: string,
    private readonly client: RpcClientType,
    engineVersion: string,
    declaredSubagents: boolean,
    private readonly forceDisposeOwned: () => Promise<void> = () => forceDisposeClient(client),
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

  onEvent(listener: (event: StableRuntimeEvent) => void): () => void {
    return this.client.onEvent((event) => listener(this.normalizeEvent(event)))
  }

  private normalizeEvent(event: JsonAgentSessionEvent): StableRuntimeEvent {
    if (event.type === 'message_start') {
      const message = event.message as AssistantMessage
      if (message.role === 'assistant') {
        this.streamingAssistant = cloneMessage(message)
        this.toolCallArgumentText.clear()
      }
      return event
    }
    if (event.type === 'message_end') {
      const message = event.message as AssistantMessage
      if (message.role === 'assistant') {
        this.streamingAssistant = null
        this.toolCallArgumentText.clear()
      }
      return event
    }
    if (event.type !== 'message_update') return event

    const update = event.assistantMessageEvent as AssistantMessageEvent & { message?: AssistantMessage }
    if ('message' in update && update.message) {
      this.streamingAssistant = cloneMessage(update.message)
    } else if (!this.streamingAssistant) {
      return event as unknown as StableRuntimeEvent
    } else {
      applyAssistantDelta(this.streamingAssistant, update, this.toolCallArgumentText)
      this.streamingAssistant.usage = event.usage
    }
    const message = cloneMessage(this.streamingAssistant)
    return {
      type: 'message_update',
      message,
      usage: event.usage,
      assistantMessageEvent: { ...update, partial: message },
    } as unknown as AgentSessionEvent
  }

  /**
   * Deny the blocking dialogs of a run nobody is watching. Pi keeps a `confirm`,
   * `select`, `input` or `editor` request pending until the host answers, so an
   * unanswered one hangs the run until its outer deadline and then reports a
   * timeout that hides the real cause.
   */
  guardUnattendedApprovals(
    gate: UnattendedApprovalGate,
    onDenied?: (denied: DeniedApproval) => void,
  ): void {
    if (this.approvalGate) return
    this.approvalGate = gate
    this.detachApprovalGate = this.onEvent((event) => {
      const answer = gate.answer(event)
      if (!answer) return
      try {
        this.respondExtensionUi(answer.response)
      } catch (error) {
        // Reported rather than logged here: this module also runs headless, outside
        // Electron, so it must not reach for the desktop app log.
        gate.recordDeliveryFailure(
          answer.denied.id,
          error instanceof Error ? error.message : String(error),
        )
      }
      onDenied?.(answer.denied)
    })
  }

  deniedApprovals(): readonly DeniedApproval[] {
    return this.approvalGate?.denied() ?? []
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.releaseApprovalGate()
    await this.client.stop()
    this.disposed = true
  }

  /** Last-resort ownership boundary used after a cancellation grace period. */
  async forceDispose(): Promise<void> {
    if (this.disposed) return
    this.releaseApprovalGate()
    await this.forceDisposeOwned()
    this.disposed = true
  }

  private releaseApprovalGate(): void {
    this.detachApprovalGate?.()
    this.detachApprovalGate = null
  }

  processId(): number | null {
    return (this.client as unknown as { process?: RuntimeProcess }).process?.pid ?? null
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
  return guardedHandle(
    new PiAgentRunHandle(
      resolved.runtimeId(),
      profile.profileDigest,
      client,
      engineVersion,
      profile.declaredCapabilities?.subagents ?? false,
      () => forceDisposeClient(client, resolved.terminateTree ?? terminateProcessTree),
    ),
    profile,
  )
}

/**
 * The compiled profile decides whether a run has an answerer, so no unattended
 * call site can forget the gate by wiring its own event listener.
 */
function guardedHandle(handle: PiAgentRunHandle, profile: CompiledRunProfile): PiAgentRunHandle {
  if (answerabilityFor(profile.kind) === 'unattended') {
    handle.guardUnattendedApprovals(new UnattendedApprovalGate())
  }
  return handle
}

/** Cancellable startup registers process ownership before start/handshake can yield. */
export function startPiRuntimeCancellable(
  profile: CompiledRunProfile,
  signal: AbortSignal,
  options?: { onOwned?: (cleanup: () => Promise<void>) => void },
): Promise<PiAgentRunHandle>
export function startPiRuntimeCancellable<C extends StartablePiClient>(
  profile: CompiledRunProfile,
  signal: AbortSignal,
  options: CancellableRuntimeOptions<C>,
): Promise<PiAgentRunHandle>
export async function startPiRuntimeCancellable(
  profile: CompiledRunProfile,
  signal: AbortSignal,
  options?: {
    dependencies?: StartPiRuntimeDependencies<StartablePiClient>
    onOwned?: (cleanup: () => Promise<void>) => void
  },
): Promise<PiAgentRunHandle> {
  const resolved = options?.dependencies ?? DEFAULT_START_DEPENDENCIES
  const RpcClient = await resolved.loadClient()
  signal.throwIfAborted()
  const client = new RpcClient({
    cwd: profile.cwd,
    env: resolved.nodeEnv(profile.env),
    runtimePath: resolved.runtimePath(),
    provider: profile.provider,
    model: profile.model,
    cliPath: profile.cliPath,
    args: profile.args,
  })
  let cleanupPromise: Promise<void> | null = null
  let cleaned = false
  const cleanup = (): Promise<void> => {
    if (cleaned) return Promise.resolve()
    cleanupPromise ??= forceDisposeClient(client, resolved.terminateTree ?? terminateProcessTree)
      .then(() => { cleaned = true })
      .finally(() => { cleanupPromise = null })
    return cleanupPromise
  }
  options?.onOwned?.(cleanup)
  const abort = (): void => {
    void cleanup().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  let engineVersion = ''
  try {
    signal.throwIfAborted()
    await client.start()
    signal.throwIfAborted()
    await client.setThinkingLevel(profile.thinkingLevel)
    signal.throwIfAborted()
    assertCoreCapabilities(client)
    engineVersion = resolved.engineVersion()
    await verifyRuntimeHandshake(client, engineVersion)
    signal.throwIfAborted()
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
  return guardedHandle(
    new PiAgentRunHandle(
      resolved.runtimeId(),
      profile.profileDigest,
      client as RpcClientType,
      engineVersion,
      profile.declaredCapabilities?.subagents ?? false,
      () => forceDisposeClient(client, resolved.terminateTree ?? terminateProcessTree),
    ),
    profile,
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

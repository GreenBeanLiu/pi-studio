import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type Model,
  type StreamFunction,
} from '@earendil-works/pi-ai'
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type {
  EvalEngine,
  EvalEngineEvent,
  EvalEngineRequest,
  EvalEngineResult,
  EvalRecording,
} from './eval-driver'
import { EVAL_WORKSPACE_TOKEN } from './eval-driver'
import { SessionProjectionTracker } from './session-projection'

const BUILTIN_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])

type TimedProviderEvent = { event: AssistantMessageEvent; atMs: number }

function restoreWorkspace<T>(value: T, workspace: string): T {
  if (typeof value === 'string') return value.replaceAll(EVAL_WORKSPACE_TOKEN, workspace) as T
  if (Array.isArray(value)) return value.map((entry) => restoreWorkspace(entry, workspace)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreWorkspace(entry, workspace)])) as T
  }
  return value
}

function containsUnsafeAbsolutePath(value: unknown, workspace: string): boolean {
  if (typeof value === 'string') {
    const normalizedWorkspace = workspace.replaceAll('\\', '/').toLowerCase()
    const normalized = value.replaceAll('\\', '/')
    const candidates = [
      ...normalized.matchAll(/[A-Za-z]:\/[^\s"'`]+/g),
      ...normalized.matchAll(/(?:^|[\s"'`=])(\/[^\s"'`]+)/g),
    ].map((match) => (match[1] ?? match[0]).trim())
    return candidates.some((candidate) => !candidate.toLowerCase().startsWith(normalizedWorkspace))
  }
  if (Array.isArray(value)) return value.some((entry) => containsUnsafeAbsolutePath(entry, workspace))
  if (value && typeof value === 'object') return Object.values(value).some((entry) => containsUnsafeAbsolutePath(entry, workspace))
  return false
}

function assertReplayToolContainment(event: AssistantMessageEvent, workspace: string): void {
  const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial
  for (const content of message.content) {
    if (content.type === 'toolCall' && containsUnsafeAbsolutePath(content.arguments, workspace)) {
      throw new Error(`recorded tool call ${content.name} contains an absolute path outside the replay workspace`)
    }
  }
}

function recordedProviderStreams(recording: EvalRecording, workspace: string): TimedProviderEvent[][] {
  const streams: TimedProviderEvent[][] = []
  let current: TimedProviderEvent[] | null = null
  for (const frame of recording.events) {
    const message = restoreWorkspace(frame.raw.message, workspace) as { role?: string; stopReason?: string } | undefined
    if (frame.raw.type === 'message_start' && message?.role === 'assistant') {
      if (current) throw new Error('recording starts a provider stream before the previous stream ended')
      const event = { type: 'start', partial: structuredClone(message) } as AssistantMessageEvent
      assertReplayToolContainment(event, workspace)
      current = [{ event, atMs: frame.atMs }]
      continue
    }
    if (frame.raw.type === 'message_end' && message?.role === 'assistant') {
      if (!current) continue
      const terminal = message.stopReason === 'error' || message.stopReason === 'aborted'
        ? { type: 'error', reason: message.stopReason, error: structuredClone(message) }
        : {
            type: 'done',
            reason: message.stopReason === 'length' || message.stopReason === 'toolUse' ? message.stopReason : 'stop',
            message: structuredClone(message),
          }
      assertReplayToolContainment(terminal as AssistantMessageEvent, workspace)
      current.push({ event: terminal as AssistantMessageEvent, atMs: frame.atMs })
      streams.push(current)
      current = null
      continue
    }
    if (frame.raw.type !== 'message_update') continue
    const event = restoreWorkspace(frame.raw.assistantMessageEvent, workspace) as AssistantMessageEvent | undefined
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'start') {
      if (current) throw new Error('recording starts a provider stream before the previous stream ended')
      current = []
    }
    if (!current) throw new Error('recording contains a provider event before stream start')
    assertReplayToolContainment(event, workspace)
    current.push({ event: structuredClone(event), atMs: frame.atMs })
    if (event.type === 'done' || event.type === 'error') {
      streams.push(current)
      current = null
    }
  }
  if (current) throw new Error('recording provider stream has no terminal event')
  if (streams.length === 0 && !recording.replay?.providerSteps.length) {
    throw new Error('recording does not contain an LLM provider stream')
  }
  return streams
}

async function waitRecordedDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return !signal?.aborted
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (completed: boolean): void => {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      resolve(completed)
    }
    const abort = (): void => finish(false)
    if (signal?.aborted) finish(false)
    else {
      signal?.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(() => finish(true), delayMs)
    }
  })
}

function abortedReplayMessage(message = 'Recorded provider hang was cancelled'): Extract<AssistantMessageEvent, { type: 'error' }>['error'] {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'pi-studio-replay',
    model: 'pi-studio-eval-replay',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'aborted',
    errorMessage: message,
    timestamp: Date.now(),
  }
}

function replayModel(): Model<'openai-completions'> {
  return {
    id: 'pi-studio-eval-replay',
    name: 'pi-studio eval replay',
    api: 'openai-completions',
    provider: 'pi-studio-replay',
    baseUrl: 'http://127.0.0.1.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 100_000,
  }
}

function emptyResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Replay a recorded pi-studio evaluation exactly.',
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as unknown as { role?: string; content?: unknown }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part): part is { type: string; text: string } =>
        !!part && typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** Replays recorded provider chunks through the real Pi agent loop and built-in tools. */
export class PiReplayEvalEngine implements EvalEngine {
  private activeSession: AgentSession | null = null
  private cleanupPromise: Promise<void> | null = null

  constructor(private readonly recording: EvalRecording) {}

  async run(
    request: EvalEngineRequest,
    emit: (event: EvalEngineEvent) => void,
    signal: AbortSignal,
  ): Promise<EvalEngineResult> {
    if (this.recording.caseId !== request.caseId) throw new Error('recording does not match evaluation case')
    const streams = recordedProviderStreams(this.recording, request.workspacePath)
    const providerSteps = this.recording.replay?.providerSteps ?? streams.map(() => ({ kind: 'recorded-stream' as const }))
    const expectedStreamSteps = providerSteps.filter((step) => step.kind === 'recorded-stream').length
    if (expectedStreamSteps !== streams.length) {
      throw new Error(`recording sidecar expects ${expectedStreamSteps} streams, found ${streams.length}`)
    }
    let stepIndex = 0
    let streamIndex = 0
    const streamFn: StreamFunction = (_model, _context, options) => {
      const step = providerSteps[stepIndex++]
      if (!step) throw new Error(`recording has no provider step for turn ${stepIndex}`)
      if (step.kind === 'throw') throw new Error(step.message)
      if (step.kind === 'cancel') {
        const stream = createAssistantMessageEventStream()
        queueMicrotask(() => {
          const error = abortedReplayMessage(step.message ?? 'Recorded provider cancellation')
          stream.push({ type: 'error', reason: 'aborted', error })
          stream.end(error)
        })
        return stream
      }
      if (step.kind === 'hang') {
        const stream = createAssistantMessageEventStream()
        const onAbort = (): void => {
          const error = abortedReplayMessage()
          stream.push({ type: 'error', reason: 'aborted', error })
          stream.end(error)
        }
        if (options?.signal?.aborted) onAbort()
        else options?.signal?.addEventListener('abort', onAbort, { once: true })
        return stream
      }
      const events = streams[streamIndex++]
      if (!events) throw new Error(`recording has no provider stream for turn ${streamIndex}`)
      const stream = createAssistantMessageEventStream()
      queueMicrotask(async () => {
        let previousAt = events[0]?.atMs ?? 0
        for (const timed of events) {
          const active = await waitRecordedDelay(Math.max(0, timed.atMs - previousAt), options?.signal)
          if (!active) {
            const error = abortedReplayMessage()
            stream.push({ type: 'error', reason: 'aborted', error })
            stream.end(error)
            return
          }
          previousAt = timed.atMs
          const cloned = structuredClone(timed.event)
          stream.push(cloned)
          if (cloned.type === 'done') stream.end(cloned.message)
          if (cloned.type === 'error') stream.end(cloned.error)
        }
      })
      return stream
    }
    const toolNames = [...new Set(this.recording.events
      .filter((frame) => frame.raw.type === 'tool_execution_start')
      .map((frame) => frame.raw.toolName)
      .filter((name): name is string => typeof name === 'string'))]
    const unsupported = toolNames.filter((name) => !BUILTIN_TOOLS.has(name))
    if (unsupported.length) throw new Error(`recording uses unsupported replay tools: ${unsupported.join(', ')}`)
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey('pi-studio-replay', 'recorded-stream-no-network')
    const modelRegistry = ModelRegistry.inMemory(authStorage)
    const { session } = await createAgentSession({
      cwd: request.workspacePath,
      model: replayModel(),
      thinkingLevel: 'off',
      authStorage,
      modelRegistry,
      resourceLoader: emptyResourceLoader(),
      tools: toolNames.length ? toolNames : ['read', 'edit', 'write', 'grep', 'find', 'ls'],
      sessionManager: SessionManager.inMemory(request.workspacePath),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    })
    this.activeSession = session
    session.agent.streamFn = streamFn
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad(request.workspacePath, null, request.sessionId)
    const unsubscribe = session.subscribe((runtimeEvent) => {
      const raw = runtimeEvent as unknown as Record<string, unknown>
      const observedAt = new Date().toISOString()
      emit({ raw, normalized: tracker.ingest(request.sessionId, raw as { type: string }, observedAt).event, observedAt })
    })
    const abort = (): void => { void this.cleanup().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await session.prompt(request.prompt)
      if (stepIndex !== providerSteps.length || streamIndex !== streams.length) {
        throw new Error(`replay consumed ${stepIndex} of ${providerSteps.length} provider steps`)
      }
      return {
        finalResponse: finalAssistantText(session.messages),
        finishReason: this.recording.engineResult.finishReason,
        exitCode: this.recording.engineResult.exitCode,
        sessionId: request.sessionId,
        messages: session.messages,
        ...(this.recording.engineResult.usage ? { usage: this.recording.engineResult.usage } : {}),
        ...(this.recording.engineResult.error ? { error: this.recording.engineResult.error } : {}),
      }
    } finally {
      signal.removeEventListener('abort', abort)
      unsubscribe()
      if (this.cleanupPromise) await this.cleanupPromise
      else session.dispose()
      if (this.activeSession === session) this.activeSession = null
      this.cleanupPromise = null
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    const session = this.activeSession
    if (!session) return
    this.cleanupPromise = (async () => {
      await session.abort()
      session.dispose()
    })()
    return this.cleanupPromise
  }
}

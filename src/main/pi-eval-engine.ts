import { createHash } from 'crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { EvalEngine, EvalEngineRequest, EvalEngineResult } from './eval-driver'
import { runPromptToSettled, type PiAgentRunHandle } from './pi-runtime'
import { resolvePiCliPath } from './pi-process'
import { SessionProjectionTracker } from './session-projection'
import type { CompiledRunProfile } from './run-profile'
import { runtimeHost, type RuntimeHostStartOptions } from './runtime-host'

type PiEvalClient = Pick<
  PiAgentRunHandle,
  'send' | 'whenIdle' | 'cancel' | 'dispose' | 'forceDispose' | 'getState' | 'getMessages' | 'onEvent'
>

type PiEvalEngineDependencies = {
  runtimeHost: {
    startCompiled: (
      profile: CompiledRunProfile,
      options?: Omit<RuntimeHostStartOptions, 'extensions' | 'subagentsAvailable'>,
    ) => Promise<{ profile: CompiledRunProfile; client: PiEvalClient }>
  }
  cliPath: () => string
  environment: NodeJS.ProcessEnv
}

const DEFAULT_DEPENDENCIES: PiEvalEngineDependencies = {
  runtimeHost,
  cliPath: resolvePiCliPath,
  environment: process.env,
}

function profileFor(
  request: EvalEngineRequest,
  dependencies: Pick<PiEvalEngineDependencies, 'cliPath' | 'environment'>,
): CompiledRunProfile {
  const env = Object.fromEntries(Object.entries(request.profile.env ?? {}).map(([target, source]) => {
    const value = dependencies.environment[source.fromEnv]
    if (!value) throw new Error(`Missing evaluation credential environment variable: ${source.fromEnv}`)
    return [target, value]
  }))
  const base = {
    kind: 'chat' as const,
    cwd: request.workspacePath,
    provider: request.profile.provider,
    ...(request.profile.model ? { model: request.profile.model } : {}),
    env,
    cliPath: dependencies.cliPath(),
    args: request.profile.args ?? ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'],
    thinkingLevel: 'high' as const,
    sandboxMode: null,
    security: {
      requested: 'full-access' as const,
      filesystemMode: 'danger-full-access' as const,
      networkMode: 'unrestricted' as const,
      backend: 'host' as const,
      enforcement: 'none' as const,
      hostCodeExecution: false,
      reason: 'Eval case explicitly selected host-full-access.',
    },
    declaredCapabilities: { subagents: false },
  }
  return {
    ...base,
    profileDigest: createHash('sha256').update(JSON.stringify({ ...base, env: Object.keys(env).sort() })).digest('hex').slice(0, 16),
  }
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as unknown as { role?: string; content?: unknown }
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim()
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter((part): part is { type: string; text: string } => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

function usageFrom(messages: AgentMessage[]): EvalEngineResult['usage'] | undefined {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let totalTokens = 0
  for (const message of messages as unknown as Array<{
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
  }>) {
    inputTokens += message.usage?.input ?? 0
    outputTokens += message.usage?.output ?? 0
    cacheReadTokens += message.usage?.cacheRead ?? 0
    cacheWriteTokens += message.usage?.cacheWrite ?? 0
    totalTokens += message.usage?.totalTokens ?? 0
  }
  return inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens || totalTokens
    ? {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      }
    : undefined
}

export class PiEvalEngine implements EvalEngine {
  private activeClient: PiEvalClient | null = null
  private startupCleanup: (() => Promise<void>) | null = null
  private cleanupPromise: Promise<void> | null = null

  constructor(private readonly dependencies: PiEvalEngineDependencies = DEFAULT_DEPENDENCIES) {}

  async run(request: EvalEngineRequest, emit: Parameters<EvalEngine['run']>[1], signal: AbortSignal): Promise<EvalEngineResult> {
    const { client } = await this.dependencies.runtimeHost.startCompiled(profileFor(request, this.dependencies), {
      signal,
      onOwned: (cleanup) => {
        this.startupCleanup = cleanup
      },
      audit: {
        source: 'eval',
        caseId: request.caseId,
        requestedSessionId: request.sessionId,
      },
    })
    this.activeClient = client
    this.startupCleanup = null
    let unsubscribe = (): void => {}
    const abort = (): void => { void this.cleanup().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const state = await client.getState()
      const sessionId = state.sessionId || request.sessionId
      const tracker = new SessionProjectionTracker()
      tracker.beginLoad(request.workspacePath, null, sessionId)
      unsubscribe = client.onEvent((runtimeEvent) => {
        const raw = runtimeEvent as unknown as Record<string, unknown>
        const observedAt = new Date().toISOString()
        emit({ raw, normalized: tracker.ingest(sessionId, raw as { type: string }, observedAt).event, observedAt })
      })
      await runPromptToSettled(client, request.prompt, request.timeoutMs)
      const messages = await client.getMessages()
      const usage = usageFrom(messages)
      return {
        finalResponse: finalAssistantText(messages),
        finishReason: 'settled',
        exitCode: 0,
        sessionId,
        messages,
        ...(usage ? { usage } : {}),
      }
    } finally {
      signal.removeEventListener('abort', abort)
      unsubscribe()
      if (this.cleanupPromise) {
        await this.cleanupPromise
      } else {
        await client.forceDispose()
      }
      if (this.activeClient === client) this.activeClient = null
      this.cleanupPromise = null
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    const cleanup = this.activeClient
      ? () => this.activeClient!.forceDispose()
      : this.startupCleanup
    if (!cleanup) return
    this.cleanupPromise = cleanup()
    return this.cleanupPromise
  }
}

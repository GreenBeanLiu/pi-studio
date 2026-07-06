import { existsSync } from 'fs'
import { join } from 'path'
import type { RpcClient as RpcClientType } from '@earendil-works/pi-coding-agent'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { appendAppLog, normalizeError } from './app-log'

export type PiEventListener = (event: AgentEvent) => void
export type AgentStatusEvent =
  | { status: 'started'; cwd: string; restoredSession: boolean; sessionFile?: string }
  | { status: 'exited'; cwd: string; code: number | null; signal: string | null; expected: boolean; message: string }
  | { status: 'error'; cwd: string; message: string }
export type AgentStatusListener = (event: AgentStatusEvent) => void

type RpcClient = RpcClientType

type AgentProcessLike = {
  stderr?: {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) => void
  }
  on: {
    (event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    (event: 'error', listener: (err: Error) => void): void
  }
}

// `@earendil-works/pi-coding-agent` ships ESM-only (no "require" export
// condition), but electron-vite compiles the main process to CJS. A static
// `import` would become a `require()` that Node's exports resolution
// rejects, so we load it lazily via dynamic `import()` instead — that always
// goes through ESM resolution regardless of the caller's module format.
async function loadRpcClient(): Promise<typeof RpcClientType> {
  const mod = await import('@earendil-works/pi-coding-agent')
  return mod.RpcClient
}

// RpcClient's default cliPath is the *relative* string "dist/cli.js",
// resolved against the spawned process's `cwd` — which for us is the user's
// workspace directory, not pi-coding-agent's own install location. Has to be
// passed explicitly as an absolute path. `require.resolve()` can't be used
// here either (same exports-map problem as the dynamic import above), so we
// walk the plain node_modules search paths instead — that mechanism doesn't
// consult the package's "exports" map at all.
function resolvePiCliPath(): string {
  const searchPaths = require.resolve.paths('@earendil-works/pi-coding-agent') ?? []
  for (const base of searchPaths) {
    const candidate = join(base, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent/dist/cli.js')
}

/**
 * Owns the single active RpcClient (one `pi` CLI subprocess running RPC mode)
 * for the currently open workspace. Switching workspaces stops the old
 * subprocess and starts a fresh one — conversations within a workspace are
 * pi's own session concept (new_session/switch_session), not separate
 * subprocesses.
 */
class PiClientManager {
  private client: RpcClient | null = null
  private workspacePath: string | null = null
  private unsubscribe: (() => void) | null = null
  private lastSessionFile: string | null = null
  private activeRunId = 0
  private expectedStopRunIds = new Set<number>()

  /** Pre-import the pi-coding-agent ESM graph so the first workspace open
   *  doesn't pay the module-load cost (hundreds of ms) on click. */
  warmup(): void {
    loadRpcClient().catch((err) => {
      appendAppLog('warn', 'agent.warmup', 'Failed to warm up pi coding agent', normalizeError(err))
    })
  }

  async startWorkspace(
    cwd: string,
    env: Record<string, string>,
    provider: string | undefined,
    model: string | undefined,
    onEvent: PiEventListener,
    onStatus?: AgentStatusListener,
  ): Promise<void> {
    const restoreSessionFile = this.workspacePath === cwd ? this.lastSessionFile : null
    await this.stop()

    const runId = ++this.activeRunId
    const RpcClient = await loadRpcClient()
    const client = new RpcClient({ cwd, env, provider, model, cliPath: resolvePiCliPath() })
    await client.start()
    this.attachAgentProcessLoggers(client, cwd, runId, onStatus)

    this.client = client
    this.workspacePath = cwd
    this.unsubscribe = client.onEvent(onEvent)

    let restoredSession = false
    if (restoreSessionFile) {
      try {
        const result = await client.switchSession(restoreSessionFile)
        restoredSession = !(result as { cancelled?: boolean }).cancelled
        if (restoredSession) this.lastSessionFile = restoreSessionFile
      } catch (err) {
        appendAppLog('warn', 'agent.restoreSession', 'Failed to restore previous session', {
          cwd,
          sessionFile: restoreSessionFile,
          error: normalizeError(err),
        })
      }
    }

    try {
      const state = await client.getState()
      if (state?.sessionFile) this.lastSessionFile = state.sessionFile
    } catch (err) {
      appendAppLog('warn', 'agent.state', 'Failed to read initial agent state', normalizeError(err))
    }

    appendAppLog('info', 'agent.start', 'Pi agent process started', {
      cwd,
      provider,
      modelConfigured: !!model,
      restoredSession,
    })
    onStatus?.({
      status: 'started',
      cwd,
      restoredSession,
      sessionFile: this.lastSessionFile ?? undefined,
    })
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.client) {
      this.expectedStopRunIds.add(this.activeRunId)
      await this.client.stop().catch(() => {})
      appendAppLog('info', 'agent.stop', 'Pi agent process stopped', {
        cwd: this.workspacePath,
      })
    }
    this.client = null
    this.workspacePath = null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  private require(): RpcClient {
    if (!this.client) throw new Error('No workspace is open')
    return this.client
  }

  private attachAgentProcessLoggers(
    client: RpcClient,
    cwd: string,
    runId: number,
    onStatus?: AgentStatusListener,
  ): void {
    const child = (client as unknown as { process?: AgentProcessLike }).process
    if (!child) return

    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (!message) return
      appendAppLog('warn', 'agent.stderr', message, { cwd })
    })

    child.on('exit', (code, signal) => {
      if (runId !== this.activeRunId) return
      const expected = this.expectedStopRunIds.has(runId)
      appendAppLog(code === 0 ? 'info' : 'warn', 'agent.exit', 'Pi agent process exited', {
        cwd,
        code,
        signal,
        expected,
      })
      this.expectedStopRunIds.delete(runId)
      if (!expected) {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.client = null
        onStatus?.({
          status: 'exited',
          cwd,
          code,
          signal,
          expected,
          message:
            code === null
              ? `Agent process exited with signal ${signal ?? 'unknown'}`
              : `Agent process exited with code ${code}`,
        })
      }
    })

    child.on('error', (err) => {
      if (runId !== this.activeRunId) return
      appendAppLog('error', 'agent.process', 'Pi agent process error', {
        cwd,
        error: normalizeError(err),
      })
      this.unsubscribe?.()
      this.unsubscribe = null
      this.client = null
      onStatus?.({
        status: 'error',
        cwd,
        message: err.message ?? String(err),
      })
    })
  }

  prompt(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().prompt(message, images)
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().steer(message, images)
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().followUp(message, images)
  }

  abort(): Promise<void> {
    return this.require().abort()
  }

  bash(command: string): ReturnType<RpcClient['bash']> {
    return this.require().bash(command)
  }

  respondExtensionUi(response: {
    type: 'extension_ui_response'
    id: string
    value?: string
    confirmed?: boolean
    cancelled?: true
  }): void {
    const client = this.require() as unknown as { process?: { stdin?: { write: (chunk: string) => void } } }
    const stdin = client.process?.stdin
    if (!stdin) throw new Error('Agent process stdin is not available')
    stdin.write(`${JSON.stringify(response)}\n`)
  }

  newSession(): ReturnType<RpcClient['newSession']> {
    return this.require().newSession()
  }

  async getState(): Promise<Awaited<ReturnType<RpcClient['getState']>>> {
    const state = await this.require().getState()
    if (state?.sessionFile) this.lastSessionFile = state.sessionFile
    return state
  }

  getMessages(): ReturnType<RpcClient['getMessages']> {
    return this.require().getMessages()
  }

  getAvailableModels(): ReturnType<RpcClient['getAvailableModels']> {
    return this.require().getAvailableModels()
  }

  setModel(provider: string, modelId: string): ReturnType<RpcClient['setModel']> {
    return this.require().setModel(provider, modelId)
  }

  setThinkingLevel(level: Parameters<RpcClient['setThinkingLevel']>[0]): ReturnType<RpcClient['setThinkingLevel']> {
    return this.require().setThinkingLevel(level)
  }

  setSteeringMode(mode: Parameters<RpcClient['setSteeringMode']>[0]): ReturnType<RpcClient['setSteeringMode']> {
    return this.require().setSteeringMode(mode)
  }

  setFollowUpMode(mode: Parameters<RpcClient['setFollowUpMode']>[0]): ReturnType<RpcClient['setFollowUpMode']> {
    return this.require().setFollowUpMode(mode)
  }

  setAutoCompaction(enabled: boolean): ReturnType<RpcClient['setAutoCompaction']> {
    return this.require().setAutoCompaction(enabled)
  }

  compact(): ReturnType<RpcClient['compact']> {
    return this.require().compact()
  }

  switchSession(sessionPath: string): ReturnType<RpcClient['switchSession']> {
    return this.require().switchSession(sessionPath)
  }

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.require().getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.require().setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()

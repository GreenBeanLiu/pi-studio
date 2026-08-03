import { existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { createRequire } from 'module'
import type {
  AgentSessionEvent,
  RpcClient as RpcClientType,
} from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import { appendAppLog, normalizeError } from './app-log'
import { DEFAULT_THINKING_LEVEL } from '../shared/agent-defaults'
import { loadSettings, saveSelectedModelRoute } from './settings'
import {
  prepareSandboxLaunch,
  sandboxSessionPathToContainer,
  sandboxSessionPathToHost,
} from './sandbox'

export type PiEventListener = (event: AgentSessionEvent) => void
export type AgentStatusEvent =
  | {
      status: 'started'
      cwd: string
      restoredSession: boolean
      sessionFile?: string
      /** 本工作区的 agent 是否跑在沙箱里(WSL bubblewrap / Docker 回退) */
      sandbox?: 'wsl' | 'docker'
    }
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
export async function loadRpcClient(): Promise<typeof RpcClientType> {
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
export function resolvePiCliPath(): string {
  // ESM 下没有全局 require;createRequire 的 resolve.paths 走同样的 node_modules 搜索路径
  const cjsRequire = createRequire(import.meta.url)
  const searchPaths = cjsRequire.resolve.paths('@earendil-works/pi-coding-agent') ?? []
  for (const base of searchPaths) {
    const candidate = join(base, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent/dist/cli.js')
}

/**
 * Electron's executable can run ordinary Node scripts when this flag is set.
 * Passing it explicitly to RpcClient removes the target machine's system-Node dependency.
 */
export function embeddedNodeEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, ELECTRON_RUN_AS_NODE: '1' }
}

/**
 * 一轮是否还在跑。agent_end 之后 pi 可能还要重试或压缩后续跑,
 * agent_settled 才是这一轮真正结束的点(和 AgentRuntimeTracker 保持同一口径)。
 */
export function nextRunActive(current: boolean, eventType: string): boolean {
  if (eventType === 'agent_start') return true
  if (eventType === 'agent_settled') return false
  return current
}

/**
 * macOS registers the main app executable in Dock even in ELECTRON_RUN_AS_NODE mode.
 * Electron's LSUIElement Helper provides the same embedded Node runtime without a Dock icon.
 */
export function resolveEmbeddedNodePath(
  execPath = process.execPath,
  platform = process.platform,
): string {
  if (platform !== 'darwin') return execPath
  const executableName = basename(execPath)
  const helperPath = resolve(
    dirname(execPath),
    '..',
    'Frameworks',
    `${executableName} Helper.app`,
    'Contents',
    'MacOS',
    `${executableName} Helper`,
  )
  return existsSync(helperPath) ? helperPath : execPath
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
  private sandboxSessionPaths = false
  private sandboxMode: 'wsl' | 'docker' | null = null
  private activeRunId = 0
  private expectedStopRunIds = new Set<number>()
  /** agent_start .. agent_settled 之间为 true —— 换会话前必须先收拾干净。 */
  private runActive = false

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
    onWorkspaceStopped?: (cwd: string) => Promise<void>,
  ): Promise<void> {
    const previousWorkspacePath = this.workspacePath
    const restoreSessionFile = previousWorkspacePath === cwd ? this.lastSessionFile : null
    await this.stop()
    if (previousWorkspacePath) await onWorkspaceStopped?.(previousWorkspacePath)

    const runId = ++this.activeRunId
    const RpcClient = await loadRpcClient()
    // 沙箱模式:改用中继 shim 让 pi 在 Docker 容器里跑(daemon/镜像没就绪会抛错)
    const sandboxEnabled = loadSettings().sandboxEnabled
    const launch = sandboxEnabled
      ? await prepareSandboxLaunch(cwd, env)
      : { cliPath: resolvePiCliPath(), env, mode: null }
    const runtimeEnv = embeddedNodeEnv(launch.env)
    this.sandboxSessionPaths = sandboxEnabled
    this.sandboxMode = launch.mode
    const client = new RpcClient({
      cwd,
      env: runtimeEnv,
      runtimePath: resolveEmbeddedNodePath(),
      provider,
      model,
      cliPath: launch.cliPath,
    })
    await client.start()
    this.attachAgentProcessLoggers(client, cwd, runId, onStatus)

    this.client = client
    this.workspacePath = cwd
    this.runActive = false
    this.unsubscribe = client.onEvent((event) => {
      this.runActive = nextRunActive(this.runActive, event.type)
      onEvent(event)
    })

    let restoredSession = false
    if (restoreSessionFile) {
      try {
        const sessionPath = this.sandboxSessionPaths
          ? sandboxSessionPathToContainer(restoreSessionFile)
          : restoreSessionFile
        const result = await client.switchSession(sessionPath)
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

    await client.setThinkingLevel(DEFAULT_THINKING_LEVEL)

    try {
      const state = await this.getState()
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
      sandbox: this.sandboxMode ?? undefined,
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
    this.sandboxSessionPaths = false
    this.sandboxMode = null
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

  /**
   * pi 的 new_session / switch_session 会直接 dispose 当前会话,不管有没有正在跑的一轮:
   * 实测流被掐断后 message_end / turn_end / agent_end / agent_settled 一个都不发,
   * 那一轮就这么凭空消失(界面永远停在最后一步,会话文件也断在半句)。
   * 先 abort 再切:abort 会把收尾事件正常发完,界面、运行记录和会话文件才对得上。
   */
  private async settleActiveRun(): Promise<boolean> {
    if (!this.runActive || !this.client) return false
    await this.client.abort().catch(() => {})
    this.runActive = false
    return true
  }

  async newSession(): Promise<{ cancelled: boolean; interruptedRun: boolean }> {
    const interruptedRun = await this.settleActiveRun()
    const result = (await this.require().newSession()) as { cancelled?: boolean } | undefined
    return { cancelled: result?.cancelled === true, interruptedRun }
  }

  async getState(): Promise<Awaited<ReturnType<RpcClient['getState']>>> {
    const state = await this.require().getState()
    if (!state?.sessionFile) return state
    const sessionFile = this.sandboxSessionPaths
      ? sandboxSessionPathToHost(state.sessionFile)
      : state.sessionFile
    this.lastSessionFile = sessionFile
    return sessionFile === state.sessionFile ? state : { ...state, sessionFile }
  }

  getMessages(): ReturnType<RpcClient['getMessages']> {
    return this.require().getMessages()
  }

  getAvailableModels(): ReturnType<RpcClient['getAvailableModels']> {
    return this.require().getAvailableModels()
  }

  async setModel(provider: string, modelId: string): Promise<Awaited<ReturnType<RpcClient['setModel']>>> {
    const selected = await this.require().setModel(provider, modelId)
    saveSelectedModelRoute(provider, modelId)
    return selected
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

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean; interruptedRun: boolean }> {
    const path = this.sandboxSessionPaths
      ? sandboxSessionPathToContainer(sessionPath)
      : sessionPath
    const interruptedRun = await this.settleActiveRun()
    const result = (await this.require().switchSession(path)) as { cancelled?: boolean } | undefined
    return { cancelled: result?.cancelled === true, interruptedRun }
  }

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.require().getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.require().setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()

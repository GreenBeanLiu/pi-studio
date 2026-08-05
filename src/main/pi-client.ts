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

/** 后台会话的运行状态变化(前台会话走完整的事件流)。 */
export type SessionActivityEvent = { sessionFile: string | null; running: boolean }
export type SessionActivityListener = (event: SessionActivityEvent) => void

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

/** 同时保活的 agent 进程上限(每个约 150MB)。超了就回收最久没用的空闲会话。 */
export const MAX_LIVE_AGENTS = 4

/**
 * 会话文件的比较键。手机端传来的路径没经过 main 的规范化(桌面 IPC 走 parseSessionPath),
 * 分隔符或大小写差一点就会认不出"这个会话已经有进程了",于是又起一个 —— 两个 agent
 * 同时往同一个 jsonl 里写。Windows 上路径不区分大小写。
 */
export function sessionKey(sessionFile: string | null): string | null {
  if (!sessionFile) return null
  const normalized = resolve(sessionFile)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

type EvictionCandidate = { runActive: boolean; lastActivatedAt: number }

/**
 * 挑一个可以回收的 agent:当前会话和正在跑的会话都不能动,其余取最久没被切到前台的。
 * 全都在跑就返回 null —— 宁可多占内存,也不能把用户正在跑的一轮杀掉。
 */
export function pickEvictableAgent<T extends EvictionCandidate>(
  entries: readonly T[],
  active: T | null,
): T | null {
  const idle = entries.filter((entry) => entry !== active && !entry.runActive)
  if (idle.length === 0) return null
  return idle.reduce((oldest, entry) =>
    entry.lastActivatedAt < oldest.lastActivatedAt ? entry : oldest,
  )
}

type AgentEntry = {
  client: RpcClient
  runId: number
  /** 会话文件在 agent 起来读到 state 之后才知道 */
  sessionFile: string | null
  runActive: boolean
  lastActivatedAt: number
  unsubscribe: (() => void) | null
  /** 后台会话弹出的扩展 UI 请求(工具审批等),等它切到前台再补发,否则没人应答会卡死 */
  pendingUi: AgentSessionEvent[]
}

type LaunchContext = {
  cwd: string
  env: Record<string, string>
  provider: string | undefined
  model: string | undefined
  cliPath: string
  sandboxMode: 'wsl' | 'docker' | null
  sandboxSessionPaths: boolean
}

/**
 * 一个聊天一个 `pi` RPC 子进程。
 *
 * 早先所有聊天共用一个进程、靠 pi 的 new_session/switch_session 来回切,但那两个
 * 调用会直接 dispose 当前会话:正在跑的一轮被掐断且一个收尾事件都不发(实测),
 * 界面就永远停在最后一步。而且模型、推理深度这些是进程级状态,在一个聊天里改会串到
 * 另一个聊天。改成按会话开进程之后,切换只是换看哪一个,后台那轮照常跑完。
 */
class PiClientManager {
  private workspacePath: string | null = null
  private launch: LaunchContext | null = null
  private entries: AgentEntry[] = []
  private active: AgentEntry | null = null
  private lastSessionFile: string | null = null
  private nextRunId = 0
  private expectedStopRunIds = new Set<number>()
  private onEvent: PiEventListener | null = null
  private onStatus: AgentStatusListener | null = null
  private onActivity: SessionActivityListener | null = null

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
    onActivity?: SessionActivityListener,
  ): Promise<void> {
    const previousWorkspacePath = this.workspacePath
    const restoreSessionFile = previousWorkspacePath === cwd ? this.lastSessionFile : null
    await this.stop()
    if (previousWorkspacePath) await onWorkspaceStopped?.(previousWorkspacePath)

    // 沙箱模式:改用中继 shim 让 pi 在 Docker 容器里跑(daemon/镜像没就绪会抛错)
    const sandboxEnabled = loadSettings().sandboxEnabled
    const prepared = sandboxEnabled
      ? await prepareSandboxLaunch(cwd, env)
      : { cliPath: resolvePiCliPath(), env, mode: null }
    this.launch = {
      cwd,
      env: prepared.env,
      provider,
      model,
      cliPath: prepared.cliPath,
      sandboxMode: prepared.mode,
      sandboxSessionPaths: sandboxEnabled,
    }
    this.workspacePath = cwd
    this.onEvent = onEvent
    this.onStatus = onStatus ?? null
    this.onActivity = onActivity ?? null

    const entry = await this.spawn(restoreSessionFile)
    this.activate(entry)

    appendAppLog('info', 'agent.start', 'Pi agent process started', {
      cwd,
      provider,
      modelConfigured: !!model,
      restoredSession: !!restoreSessionFile && entry.sessionFile === restoreSessionFile,
    })
    onStatus?.({
      status: 'started',
      cwd,
      restoredSession: !!restoreSessionFile && entry.sessionFile === restoreSessionFile,
      sessionFile: entry.sessionFile ?? undefined,
      sandbox: this.launch.sandboxMode ?? undefined,
    })
  }

  /** 起一个新的 agent 进程;restoreSessionFile 非空时让它接管那个已有会话。 */
  private async spawn(restoreSessionFile: string | null): Promise<AgentEntry> {
    const launch = this.launch
    if (!launch) throw new Error('No workspace is open')

    const RpcClient = await loadRpcClient()
    const runId = ++this.nextRunId
    const client = new RpcClient({
      cwd: launch.cwd,
      env: embeddedNodeEnv(launch.env),
      runtimePath: resolveEmbeddedNodePath(),
      provider: launch.provider,
      model: launch.model,
      cliPath: launch.cliPath,
    })
    await client.start()

    const entry: AgentEntry = {
      client,
      runId,
      sessionFile: null,
      runActive: false,
      lastActivatedAt: Date.now(),
      unsubscribe: null,
      pendingUi: [],
    }
    this.attachAgentProcessLoggers(entry)
    entry.unsubscribe = client.onEvent((event) => this.handleEvent(entry, event))
    this.entries.push(entry)

    // 全新的 agent 上没有正在跑的一轮,这时候 switch_session 是安全的
    if (restoreSessionFile) {
      try {
        await client.switchSession(
          launch.sandboxSessionPaths
            ? sandboxSessionPathToContainer(restoreSessionFile)
            : restoreSessionFile,
        )
      } catch (err) {
        appendAppLog('warn', 'agent.restoreSession', 'Failed to restore previous session', {
          cwd: launch.cwd,
          sessionFile: restoreSessionFile,
          error: normalizeError(err),
        })
      }
    }

    await client.setThinkingLevel(DEFAULT_THINKING_LEVEL)

    try {
      const state = await client.getState()
      entry.sessionFile = this.toHostSessionPath(state?.sessionFile ?? null)
    } catch (err) {
      appendAppLog('warn', 'agent.state', 'Failed to read initial agent state', normalizeError(err))
    }

    await this.evictIfNeeded()
    return entry
  }

  private handleEvent(entry: AgentEntry, event: AgentSessionEvent): void {
    entry.runActive = nextRunActive(entry.runActive, event.type)
    if (entry === this.active) {
      this.onEvent?.(event)
      return
    }
    // 后台会话:审批之类的请求先攒着,切回前台再补发;其余只上报运行状态给侧栏
    if ((event as { type?: string }).type === 'extension_ui_request') entry.pendingUi.push(event)
    this.onActivity?.({ sessionFile: entry.sessionFile, running: entry.runActive })
  }

  private activate(entry: AgentEntry): void {
    this.active = entry
    entry.lastActivatedAt = Date.now()
    this.lastSessionFile = entry.sessionFile
    const pending = entry.pendingUi.splice(0)
    for (const event of pending) this.onEvent?.(event)
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.length > MAX_LIVE_AGENTS) {
      const victim = pickEvictableAgent(this.entries, this.active)
      if (!victim) return
      await this.stopEntry(victim, 'evicted')
    }
  }

  private async stopEntry(entry: AgentEntry, reason: string): Promise<void> {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    this.expectedStopRunIds.add(entry.runId)
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    if (this.active === entry) this.active = null
    await entry.client.stop().catch(() => {})
    appendAppLog('info', 'agent.stop', 'Pi agent process stopped', {
      cwd: this.workspacePath,
      sessionFile: entry.sessionFile,
      reason,
    })
  }

  async stop(): Promise<void> {
    for (const entry of [...this.entries]) await this.stopEntry(entry, 'workspace closed')
    this.entries = []
    this.active = null
    this.workspacePath = null
    this.launch = null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  /** 当前有几个 agent 进程在跑(诊断用)。 */
  liveAgentCount(): number {
    return this.entries.length
  }

  /**
   * 删除会话前先把占着它的 agent 收掉,否则那个进程还在往已删掉的文件里写。
   * 正在跑的一轮不给收 —— 调用方应据此拒绝删除。
   */
  async releaseSession(sessionFile: string): Promise<{ released: boolean; running: boolean }> {
    const wanted = sessionKey(sessionFile)
    const entry = this.entries.find((candidate) => sessionKey(candidate.sessionFile) === wanted)
    if (!entry) return { released: true, running: false }
    if (entry.runActive) return { released: false, running: true }
    await this.stopEntry(entry, 'session deleted')
    return { released: true, running: false }
  }

  private require(): RpcClient {
    if (!this.active) throw new Error('No workspace is open')
    return this.active.client
  }

  private toHostSessionPath(sessionFile: string | null): string | null {
    if (!sessionFile) return null
    return this.launch?.sandboxSessionPaths ? sandboxSessionPathToHost(sessionFile) : sessionFile
  }

  private attachAgentProcessLoggers(entry: AgentEntry): void {
    const cwd = this.launch?.cwd ?? ''
    const child = (entry.client as unknown as { process?: AgentProcessLike }).process
    if (!child) return

    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (!message) return
      appendAppLog('warn', 'agent.stderr', message, { cwd })
    })

    child.on('exit', (code, signal) => {
      const expected = this.expectedStopRunIds.has(entry.runId)
      appendAppLog(code === 0 ? 'info' : 'warn', 'agent.exit', 'Pi agent process exited', {
        cwd,
        sessionFile: entry.sessionFile,
        code,
        signal,
        expected,
      })
      this.expectedStopRunIds.delete(entry.runId)
      if (expected) return
      const wasActive = this.active === entry
      this.forgetEntry(entry)
      // 后台会话崩了不该打翻前台:只报活动状态,前台崩了才走 agent 错误横幅
      if (!wasActive) {
        this.onActivity?.({ sessionFile: entry.sessionFile, running: false })
        return
      }
      this.onStatus?.({
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
    })

    child.on('error', (err) => {
      appendAppLog('error', 'agent.process', 'Pi agent process error', {
        cwd,
        sessionFile: entry.sessionFile,
        error: normalizeError(err),
      })
      const wasActive = this.active === entry
      this.forgetEntry(entry)
      if (!wasActive) return
      this.onStatus?.({ status: 'error', cwd, message: err.message ?? String(err) })
    })
  }

  private forgetEntry(entry: AgentEntry): void {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    if (this.active === entry) this.active = null
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

  /** 新聊天 = 新进程,当前会话该跑还跑。 */
  async newSession(): Promise<{ cancelled: boolean }> {
    if (!this.launch) throw new Error('No workspace is open')
    const entry = await this.spawn(null)
    this.activate(entry)
    return { cancelled: false }
  }

  /** 切聊天 = 换看哪个进程;没有进程的会话就现起一个来接管。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    if (!this.launch) throw new Error('No workspace is open')
    const wanted = sessionKey(sessionPath)
    const existing = this.entries.find((entry) => sessionKey(entry.sessionFile) === wanted)
    if (existing) {
      this.activate(existing)
      return { cancelled: false }
    }
    const entry = await this.spawn(sessionPath)
    this.activate(entry)
    return { cancelled: false }
  }

  async getState(): Promise<Awaited<ReturnType<RpcClient['getState']>>> {
    const state = await this.require().getState()
    if (!state?.sessionFile) return state
    const sessionFile = this.toHostSessionPath(state.sessionFile)
    if (this.active) this.active.sessionFile = sessionFile
    this.lastSessionFile = sessionFile
    return sessionFile === state.sessionFile ? state : { ...state, sessionFile: sessionFile! }
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

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.require().getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.require().setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()

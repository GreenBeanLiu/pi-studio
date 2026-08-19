import { join, resolve, win32 } from 'path'
import { randomUUID } from 'crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { appendAppLog, normalizeError } from './app-log'
import { agentConfigDir, saveSelectedModelRoute } from './settings'
import { sandboxAgentPath, sandboxSessionPathToContainer, sandboxSessionPathToHost } from './sandbox'
import type { CompiledRunProfile } from './run-profile'
import type {
  ExecutionSecuritySnapshot,
  ExtensionUiResponse,
  PiRuntimeEvent,
} from '../shared/ipc/contract'
import {
  loadRpcClient,
} from './pi-process'
import { startPiRuntime, type PiAgentRunHandle } from './pi-runtime'
import {
  isBlockingExtensionUiMethod,
  type BlockingExtensionUiMethod,
} from './extension-ui-ownership'
import {
  AgentJobRegistry,
  isTerminalJobState,
  type AgentJob,
  type AgentJobSnapshot,
} from './agent-job-registry'
import { AgentLoopGuard, type LoopDetection } from './agent-loop-guard'
import { AgentStatusTracker } from './agent-status'

export { embeddedNodeEnv, loadRpcClient, resolveEmbeddedNodePath, resolvePiCliPath } from './pi-process'

export type PiEventContext = {
  sessionId: string
  sessionFile: string | null
  runActive: boolean
  awaitingApproval: boolean
  runStartedAt: number | null
}
export type PiEventListener = (event: PiRuntimeEvent, context: PiEventContext) => void
export type AgentStatusEvent =
  | {
      status: 'started'
      cwd: string
      restoredSession: boolean
      sessionId?: string
      sessionFile?: string
      /** 本工作区的 agent 是否跑在沙箱里(WSL bubblewrap / Docker 回退) */
      sandbox?: 'wsl' | 'docker'
      security?: ExecutionSecuritySnapshot
      profileDigest?: string
    }
  | { status: 'exited'; cwd: string; code: number | null; signal: string | null; expected: boolean; message: string }
  | { status: 'error'; cwd: string; message: string }
export type AgentStatusListener = (event: AgentStatusEvent) => void

/** 后台会话的运行状态变化(前台会话走完整的事件流)。 */
export type SessionActivityEvent = { sessionFile: string | null; running: boolean }
export type SessionActivityListener = (event: SessionActivityEvent) => void
export type SessionActivatedListener = (context: PiEventContext) => void

type RpcClient = PiAgentRunHandle

/**
 * 没打开工作区时每条 RPC 都抛这个。手机端要按它区分「桌面没开工作目录」和
 * 别的失败(见 remote-control 的 NO_WORKSPACE),所以文案单独拎出来共用。
 */
export const NO_WORKSPACE_ERROR = 'No workspace is open'

/**
 * 一轮是否还在跑。agent_end 之后 pi 可能还要重试或压缩后续跑,
 * agent_settled 才是这一轮真正结束的点(和 AgentRuntimeTracker 保持同一口径)。
 */
export function nextRunActive(current: boolean, eventType: string): boolean {
  if (eventType === 'agent_start') return true
  if (eventType === 'agent_settled') return false
  return current
}

/** 同时保活的 agent 进程上限(每个约 150MB)。超了就回收最久没用的空闲会话。 */
export const MAX_LIVE_AGENTS = 4

/** Windows 盘符或 UNC 路径。一个账户下 Mac 和 Windows 都能被同一台手机控制。 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * 会话文件的比较键。手机端传来的路径没经过 main 的规范化(桌面 IPC 走 parseSessionPath),
 * 分隔符或大小写差一点就会认不出"这个会话已经有进程了",于是又起一个 —— 两个 agent
 * 同时往同一个 jsonl 里写。Windows 上路径不区分大小写。
 */
export function sessionKey(sessionFile: string | null): string | null {
  if (!sessionFile) return null
  if (process.platform === 'win32') return resolve(sessionFile).toLowerCase()
  // mac / Linux 上 resolve() 不认反斜杠,会把整条 Windows 路径当成一个文件名,
  // 还会给它拼上 cwd —— 手机端把那台 Windows 电脑的会话路径发过来时就认不出
  // "这个会话已经有进程了"。用 win32 的解析规则处理,两种写法才会落到同一个键。
  if (WINDOWS_PATH.test(sessionFile)) return win32.resolve(sessionFile).toLowerCase()
  return resolve(sessionFile)
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
  /** 进程的所有权与生命周期都记在 job 上:状态、取消、以及"资源真的放掉了"的证据。 */
  job: AgentJob
  /** 会话文件在 agent 起来读到 state 之后才知道 */
  sessionFile: string | null
  sessionId: string | null
  unsubscribe: (() => void) | null
  /** 后台会话弹出的扩展 UI 请求(工具审批等),等它切到前台再补发,否则没人应答会卡死 */
  pendingUi: PiRuntimeEvent[]
  /** 当前子进程实际持有、仍可回答的阻塞 UI 请求。 */
  outstandingUi: Map<string, BlockingExtensionUiMethod>
  /** 子代理跑在 pi 进程内部,宿主只能按工具调用观察它们的血缘与终态。 */
  subagentJobs: Map<string, AgentJob>
  statusFile: string
  status: AgentStatusTracker
  loopGuard: AgentLoopGuard
}

type LaunchContext = CompiledRunProfile & { sandboxSessionPaths: boolean }

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
  private readonly jobs = new AgentJobRegistry()
  private onEvent: PiEventListener | null = null
  private onStatus: AgentStatusListener | null = null
  private onActivity: SessionActivityListener | null = null
  private onActivated: SessionActivatedListener | null = null

  /** Pre-import the pi-coding-agent ESM graph so the first workspace open
   *  doesn't pay the module-load cost (hundreds of ms) on click. */
  warmup(): void {
    loadRpcClient().catch((err) => {
      appendAppLog('warn', 'agent.warmup', 'Failed to warm up pi coding agent', normalizeError(err))
    })
  }

  async startWorkspace(
    cwd: string,
    compileProfile: () => Promise<CompiledRunProfile>,
    onEvent: PiEventListener,
    onStatus?: AgentStatusListener,
    onWorkspaceStopped?: (cwd: string) => Promise<void>,
    onActivity?: SessionActivityListener,
    onActivated?: SessionActivatedListener,
  ): Promise<void> {
    const previousWorkspacePath = this.workspacePath
    const restoreSessionFile = previousWorkspacePath === cwd ? this.lastSessionFile : null
    await this.stop()
    if (previousWorkspacePath) await onWorkspaceStopped?.(previousWorkspacePath)

    const profile = await compileProfile()
    this.launch = {
      ...profile,
      sandboxSessionPaths: profile.sandboxMode !== null,
    }
    this.workspacePath = cwd
    this.onEvent = onEvent
    this.onStatus = onStatus ?? null
    this.onActivity = onActivity ?? null
    this.onActivated = onActivated ?? null

    const entry = await this.spawn(restoreSessionFile)
    this.activate(entry)

    appendAppLog('info', 'agent.start', 'Pi agent process started', {
      cwd,
      provider: profile.provider,
      model: profile.model ?? null,
      modelConfigured: !!profile.model,
      restoredSession: !!restoreSessionFile && entry.sessionFile === restoreSessionFile,
    })
    onStatus?.({
      status: 'started',
      cwd,
      restoredSession: !!restoreSessionFile && entry.sessionFile === restoreSessionFile,
      sessionId: entry.sessionId ?? entry.job.id,
      sessionFile: entry.sessionFile ?? undefined,
      sandbox: this.launch.sandboxMode ?? undefined,
      security: this.launch.security,
      profileDigest: this.launch.profileDigest,
    })
  }

  /** 起一个新的 agent 进程;restoreSessionFile 非空时让它接管那个已有会话。 */
  private async spawn(restoreSessionFile: string | null): Promise<AgentEntry> {
    const launch = this.launch
    if (!launch) throw new Error(NO_WORKSPACE_ERROR)

    const statusFile = join(agentConfigDir(), 'runtime-status', `${randomUUID()}.json`)
    const runtimeLaunch = {
      ...launch,
      env: {
        ...launch.env,
        PI_STUDIO_STATUS_FILE: launch.sandboxSessionPaths
          ? sandboxAgentPath(statusFile, launch.sandboxMode!)
          : statusFile,
      },
    }
    const client = await startPiRuntime(runtimeLaunch)
    const job = this.jobs.register({
      kind: 'chat',
      owner: { sessionFile: restoreSessionFile },
      resources: {
        dispose: () => client.dispose(),
        forceDispose: () => client.forceDispose(),
        pid: client.processId(),
      },
    })

    const entry: AgentEntry = {
      client,
      job,
      sessionFile: null,
      sessionId: null,
      unsubscribe: null,
      pendingUi: [],
      outstandingUi: new Map(),
      subagentJobs: new Map(),
      statusFile,
      status: new AgentStatusTracker(statusFile, launch.cwd),
      loopGuard: new AgentLoopGuard(),
    }
    entry.status.write()
    this.attachAgentProcessLoggers(entry)
    entry.unsubscribe = client.onEvent((event) => this.handleEvent(entry, event as PiRuntimeEvent))
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

    try {
      const state = await client.getState()
      entry.sessionFile = this.toHostSessionPath(state?.sessionFile ?? null)
      entry.sessionId = state?.sessionId ?? null
    } catch (err) {
      appendAppLog('warn', 'agent.state', 'Failed to read initial agent state', normalizeError(err))
    }
    job.claim({ sessionId: entry.sessionId, sessionFile: entry.sessionFile })
    job.ready()

    await this.evictIfNeeded()
    return entry
  }

  private handleEvent(entry: AgentEntry, event: PiRuntimeEvent): void {
    entry.job.observeRun(nextRunActive(entry.job.isRunActive(), event.type))
    entry.status.observe(event)
    const loop = entry.loopGuard.observe(event)
    if (event.type === 'agent_settled') entry.outstandingUi.clear()
    if (
      event.type === 'extension_ui_request' &&
      isBlockingExtensionUiMethod(event.method)
    ) {
      entry.outstandingUi.set(event.id, event.method)
    }
    this.trackSubagentLineage(entry, event)
    if (entry === this.active) {
      this.onEvent?.(event, this.context(entry))
    }
    if (loop) this.handleLoopDetection(entry, loop)
    if (entry === this.active) return
    // 后台会话:审批之类的请求先攒着,切回前台再补发;其余只上报运行状态给侧栏
    if ((event as { type?: string }).type === 'extension_ui_request') entry.pendingUi.push(event)
    this.onActivity?.({ sessionFile: entry.sessionFile, running: entry.job.isRunActive() })
  }

  /**
   * 子代理在 pi 子进程里跑,宿主拿不到它的进程,但"谁派生了谁"是重启后仍要解释的事实。
   * 按工具调用登记成没有资源的逻辑 job,血缘和终态就都能观察到,而不是只剩一张卡片。
   */
  private handleLoopDetection(entry: AgentEntry, detection: LoopDetection): void {
    const message = `检测到 Agent 可能陷入循环：${detection.message}。已停止本轮运行，请检查失败原因后继续。`
    entry.status.loopDetected(message)
    appendAppLog('warn', 'agent.loop-guard', message, {
      cwd: this.workspacePath,
      sessionFile: entry.sessionFile,
      kind: detection.kind,
      signature: detection.signature,
      count: detection.count,
    })
    if (entry === this.active) {
      this.onEvent?.({ type: 'run_failed', scope: 'prompt', message }, this.context(entry))
    }
    void entry.client.cancel('loop guard detected repeated tool activity').catch((error) => {
      appendAppLog('warn', 'agent.loop-guard', 'Failed to abort repeated agent run', normalizeError(error))
    })
  }

  private trackSubagentLineage(entry: AgentEntry, event: PiRuntimeEvent): void {
    if (event.type === 'tool_execution_start' && event.toolName === 'subagent') {
      entry.subagentJobs.set(
        event.toolCallId,
        this.jobs.register({
          kind: 'subagent',
          parentId: entry.job.id,
          owner: { sessionId: entry.sessionId, sessionFile: entry.sessionFile },
        }),
      )
      return
    }
    if (event.type === 'tool_execution_end') {
      const job = entry.subagentJobs.get(event.toolCallId)
      if (!job) return
      entry.subagentJobs.delete(event.toolCallId)
      void job.finish(event.isError ? 'subagent failed' : 'subagent returned')
      return
    }
    if (event.type !== 'agent_settled') return
    // 一轮结束还挂着的子代理没有权威结果可等,按中断收尾而不是永远留在 running。
    for (const [callId, job] of entry.subagentJobs) {
      entry.subagentJobs.delete(callId)
      void job.finish('run settled without a subagent result')
    }
  }

  private activate(entry: AgentEntry): void {
    this.active = entry
    entry.job.touch()
    this.lastSessionFile = entry.sessionFile
    this.onActivated?.(this.context(entry))
    const pending = entry.pendingUi.splice(0)
    for (const event of pending) this.onEvent?.(event, this.context(entry))
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.length > MAX_LIVE_AGENTS) {
      const candidates = this.entries.map((entry) => ({
        entry,
        runActive: entry.job.isRunActive(),
        lastActivatedAt: entry.job.activatedAt(),
      }))
      const active = candidates.find((candidate) => candidate.entry === this.active) ?? null
      const victim = pickEvictableAgent(candidates, active)
      if (!victim) return
      await this.stopEntry(victim.entry, 'evicted')
    }
  }

  private async stopEntry(entry: AgentEntry, reason: string): Promise<void> {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    if (this.active === entry) this.active = null
    for (const [, job] of entry.subagentJobs) void job.finish(reason)
    entry.status.dispose()
    entry.subagentJobs.clear()
    // finish() 只在资源真的放掉之后才回 done:优雅停不住就强杀,强杀也失败就留成
    // orphaned 并带上证据,而不是当作已回收。
    this.reportJobSettled(await entry.job.finish(reason), entry)
  }

  private reportJobSettled(snapshot: AgentJobSnapshot, entry: AgentEntry): void {
    const details = {
      cwd: this.workspacePath,
      sessionFile: entry.sessionFile,
      jobId: snapshot.id,
      reason: snapshot.finishReason,
      pid: snapshot.pid,
      forced: snapshot.forced,
    }
    if (snapshot.state === 'orphaned') {
      appendAppLog('error', 'agent.stop', 'Pi agent process cleanup could not be confirmed', {
        ...details,
        cleanupError: snapshot.cleanupError,
      })
      return
    }
    appendAppLog(
      snapshot.forced ? 'warn' : 'info',
      'agent.stop',
      snapshot.forced ? 'Pi agent process killed after a stalled stop' : 'Pi agent process stopped',
      details,
    )
  }

  async stop(): Promise<void> {
    // 每个 job 的收尾都是有界的,并行收不会互相拖住工作区切换。
    await Promise.all(
      [...this.entries].map((entry) => this.stopEntry(entry, 'workspace closed')),
    )
    this.entries = []
    this.active = null
    this.workspacePath = null
    this.launch = null
    this.onActivated = null
    this.jobs.prune()
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  /** 还没确认放掉资源的 agent 数(诊断用);orphaned 的算在里面,它的进程可能还活着。 */
  liveAgentCount(): number {
    return this.jobs.live().length
  }

  /** owner、血缘、终态和资源回收证据 —— 诊断包里能看到后台到底剩了什么。 */
  agentJobs(): AgentJobSnapshot[] {
    return this.jobs.snapshot()
  }

  /**
   * 删除会话前先把占着它的 agent 收掉,否则那个进程还在往已删掉的文件里写。
   * 正在跑的一轮不给收 —— 调用方应据此拒绝删除。
   */
  async releaseSession(sessionFile: string): Promise<{ released: boolean; running: boolean }> {
    const wanted = sessionKey(sessionFile)
    const entry = this.entries.find((candidate) => sessionKey(candidate.sessionFile) === wanted)
    if (!entry) return { released: true, running: false }
    if (entry.job.isRunActive()) return { released: false, running: true }
    await this.stopEntry(entry, 'session deleted')
    return { released: true, running: false }
  }

  private require(): RpcClient {
    if (!this.active) throw new Error(NO_WORKSPACE_ERROR)
    return this.active.client
  }

  private requireEntry(): AgentEntry {
    if (!this.active) throw new Error(NO_WORKSPACE_ERROR)
    return this.active
  }

  private context(entry: AgentEntry): PiEventContext {
    return {
      sessionId: entry.sessionId ?? entry.sessionFile ?? entry.job.id,
      sessionFile: entry.sessionFile,
      runActive: entry.job.isRunActive(),
      awaitingApproval: entry.outstandingUi.size > 0,
      runStartedAt: entry.job.startedRunAt(),
    }
  }

  getActiveSessionIdentity(): PiEventContext | null {
    return this.active ? this.context(this.active) : null
  }

  getRuntimeCapabilities() {
    return this.active?.client.capabilities ?? null
  }

  getActiveApprovalIds(): ReadonlySet<string> {
    return new Set(
      [...(this.active?.outstandingUi ?? [])]
        .filter(([, method]) => method === 'confirm')
        .map(([id]) => id),
    )
  }

  getActiveUiRequestMethod(id: string): BlockingExtensionUiMethod | null {
    return this.active?.outstandingUi.get(id) ?? null
  }

  private toHostSessionPath(sessionFile: string | null): string | null {
    if (!sessionFile) return null
    return this.launch?.sandboxSessionPaths ? sandboxSessionPathToHost(sessionFile) : sessionFile
  }

  private attachAgentProcessLoggers(entry: AgentEntry): void {
    const cwd = this.launch?.cwd ?? ''
    entry.client.observeProcess({
      stderr: (chunk) => {
        const message = String(chunk).trim()
        if (!message) return
        appendAppLog('warn', 'agent.stderr', message, { cwd })
      },
      exit: (code, signal) => {
        // 谁在收这个 job 就写在 job 状态上,不用另存一份 runId 集合。
        const state = entry.job.currentState()
        const expected = state === 'cancelling' || isTerminalJobState(state)
        appendAppLog(code === 0 ? 'info' : 'warn', 'agent.exit', 'Pi agent process exited', {
          cwd,
          sessionFile: entry.sessionFile,
          jobId: entry.job.id,
          code,
          signal,
          expected,
        })
        if (expected) return
        entry.job.crashed(
          code === null
            ? `Agent process exited with signal ${signal ?? 'unknown'}`
            : `Agent process exited with code ${code}`,
        )
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
      },
      error: (err) => {
        appendAppLog('error', 'agent.process', 'Pi agent process error', {
          cwd,
          sessionFile: entry.sessionFile,
          jobId: entry.job.id,
          error: normalizeError(err),
        })
        entry.job.crashed(err.message ?? String(err))
        const wasActive = this.active === entry
        this.forgetEntry(entry)
        if (!wasActive) return
        this.onStatus?.({ status: 'error', cwd, message: err.message ?? String(err) })
      },
    })
  }

  private forgetEntry(entry: AgentEntry): void {
    entry.unsubscribe?.()
    entry.unsubscribe = null
    entry.status.dispose()
    this.entries = this.entries.filter((candidate) => candidate !== entry)
    if (this.active === entry) this.active = null
    // 进程已经没了,子代理的逻辑 job 不能继续挂在 running 上。
    for (const [, job] of entry.subagentJobs) void job.finish('parent agent process ended')
    entry.subagentJobs.clear()
  }

  prompt(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    entry.status.prompt(message)
    return entry.client.send(message, images)
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    entry.status.prompt(message)
    return entry.client.steer(message, images)
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    entry.status.prompt(message)
    return entry.client.followUp(message, images)
  }

  abort(): Promise<void> {
    const entry = this.requireEntry()
    return entry.client.cancel('user requested abort').then(() => {
      entry.outstandingUi.clear()
    })
  }

  bash(command: string): ReturnType<RpcClient['bash']> {
    return this.require().bash(command)
  }

  respondExtensionUi(response: ExtensionUiResponse): { remainingBlockingRequests: number } {
    const entry = this.requireEntry()
    entry.client.respondExtensionUi(response)
    entry.outstandingUi.delete(response.id)
    entry.status.approvalResolved()
    return { remainingBlockingRequests: entry.outstandingUi.size }
  }

  /** 新聊天 = 新进程,当前会话该跑还跑。 */
  async newSession(): Promise<{ cancelled: boolean }> {
    if (!this.launch) throw new Error(NO_WORKSPACE_ERROR)
    const entry = await this.spawn(null)
    this.activate(entry)
    return { cancelled: false }
  }

  /** 切聊天 = 换看哪个进程;没有进程的会话就现起一个来接管。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    if (!this.launch) throw new Error(NO_WORKSPACE_ERROR)
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
    const entry = this.requireEntry()
    const state = await entry.client.getState()
    entry.sessionId = state.sessionId
    const sessionFile = this.toHostSessionPath(state.sessionFile ?? null)
    entry.sessionFile = sessionFile
    if (this.active === entry) this.lastSessionFile = sessionFile
    if (!state?.sessionFile) return state
    return sessionFile === state.sessionFile ? state : { ...state, sessionFile: sessionFile! }
  }

  async readActiveProjection(): Promise<{
    sessionId: string
    sessionFile: string | null
    messages: AgentMessage[]
  } | null> {
    const entry = this.requireEntry()
    const state = await entry.client.getState()
    const sessionFile = this.toHostSessionPath(state.sessionFile ?? null)
    entry.sessionId = state.sessionId
    entry.sessionFile = sessionFile
    const messages = await entry.client.getMessages()
    if (this.active !== entry) return null
    this.lastSessionFile = sessionFile
    return { sessionId: state.sessionId, sessionFile, messages }
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

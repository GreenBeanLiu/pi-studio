import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { appendAppLog, normalizeError } from './app-log'
import { saveSelectedModelRoute } from './settings'
import type { CompiledRunProfile } from './run-profile'
import type { ExtensionUiResponse, ModelInfo, PiRuntimeEvent } from '../shared/ipc/contract'
import { loadRpcClient } from './pi-process'
import type { BlockingExtensionUiMethod } from './extension-ui-ownership'
import type { AgentJob, AgentJobSnapshot } from './agent-job-registry'
import type { AgentStatusSnapshot } from './agent-status'
import { AgentPool, type AgentPoolHost } from './pi-agent-pool'
import { AcpRegistry } from './acp-registry'
import { resolveAcpLaunchSpec } from './acp-launch-spec'
import {
  ACP_MODEL_PROVIDER,
  acpModelEntries,
  isAcpModelRoute,
  mergeModelEntries,
} from './acp-model-entries'
import { EventProjection, type EventProjectionHost } from './pi-event-projection'
import {
  entryContext,
  unsupportedByBackend,
  NO_WORKSPACE_ERROR,
  type AgentEntry,
  type AgentStatusEvent,
  type AgentStatusListener,
  type PiEventContext,
  type PiEventListener,
  type RpcClient,
  type SessionActivatedListener,
  type SessionActivityEvent,
  type SessionActivityListener,
} from './pi-agent-entry'

export { embeddedNodeEnv, loadRpcClient, resolveEmbeddedNodePath, resolvePiCliPath } from './pi-process'

// 进程层(pi-agent-pool)、投影层(pi-event-projection)和这里的会话层拆开之后,
// 这些共享定义落在 pi-agent-entry;从 pi-client 继续导出,调用方不用改。
export {
  MAX_LIVE_AGENTS,
  NO_WORKSPACE_ERROR,
  nextRunActive,
  pickEvictableAgent,
  sessionKey,
} from './pi-agent-entry'
export type {
  AgentStatusEvent,
  AgentStatusListener,
  PiEventContext,
  PiEventListener,
  SessionActivatedListener,
  SessionActivityEvent,
  SessionActivityListener,
} from './pi-agent-entry'

/**
 * 会话层:哪个 agent 在前台、切换/新建/释放会话,以及对外的 RPC 门面。
 *
 * 进程的生死交给 {@link AgentPool},事件流投影交给 {@link EventProjection} ——
 * 这里只回答"现在看的是哪一个",并把 RPC 转发给它。
 */
class PiClientManager implements AgentPoolHost, EventProjectionHost {
  private workspacePath: string | null = null
  private active: AgentEntry | null = null
  private lastSessionFile: string | null = null
  private onEvent: PiEventListener | null = null
  private onStatus: AgentStatusListener | null = null
  private onActivity: SessionActivityListener | null = null
  private onActivated: SessionActivatedListener | null = null
  private readonly pool = new AgentPool(this)
  private readonly projection = new EventProjection(this)
  private readonly acpRegistry = new AcpRegistry()
  /**
   * 上一次从 pi 进程拿到的模型列表。当前会话是 ACP 时没有 pi 进程可问,
   * 但用户仍然要能切回自己的模型 —— 宁可给一份缓存的,也不能让那一组整个消失。
   */
  private lastPiModels: ModelInfo[] = []

  // ---- AgentPoolHost / EventProjectionHost ----

  currentWorkspacePath(): string | null {
    return this.workspacePath
  }

  isActive(entry: AgentEntry): boolean {
    return this.active === entry
  }

  /** 池子收到的子进程事件一律先过投影层,再决定推不推给界面。 */
  handleRuntimeEvent(entry: AgentEntry, event: PiRuntimeEvent): void {
    this.projection.handleEvent(entry, event)
  }

  onEntryRemoved(entry: AgentEntry): void {
    if (this.active === entry) this.active = null
  }

  emitEvent(event: PiRuntimeEvent, context: PiEventContext): void {
    this.onEvent?.(event, context)
  }

  emitActivity(event: SessionActivityEvent): void {
    this.onActivity?.(event)
  }

  emitStatus(event: AgentStatusEvent): void {
    this.onStatus?.(event)
  }

  registerSubagentJob(entry: AgentEntry): AgentJob {
    return this.pool.registerSubagentJob(entry)
  }

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
    const launch = {
      ...profile,
      sandboxSessionPaths: profile.sandboxMode !== null,
    }
    this.pool.setLaunch(launch)
    this.workspacePath = cwd
    this.onEvent = onEvent
    this.onStatus = onStatus ?? null
    this.onActivity = onActivity ?? null
    this.onActivated = onActivated ?? null

    const entry = await this.pool.spawn(restoreSessionFile)
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
      sandbox: launch.sandboxMode ?? undefined,
      security: launch.security,
      profileDigest: launch.profileDigest,
    })
  }

  private activate(entry: AgentEntry): void {
    this.active = entry
    entry.job.touch()
    this.lastSessionFile = entry.sessionFile
    this.onActivated?.(entryContext(entry))
    const pending = entry.pendingUi.splice(0)
    for (const event of pending) this.onEvent?.(event, entryContext(entry))
  }

  async stop(): Promise<void> {
    await this.pool.stopAll('workspace closed')
    this.active = null
    this.workspacePath = null
    this.onActivated = null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  /** 还没确认放掉资源的 agent 数(诊断用);orphaned 的算在里面,它的进程可能还活着。 */
  liveAgentCount(): number {
    return this.pool.liveAgentCount()
  }

  /** owner、血缘、终态和资源回收证据 —— 诊断包里能看到后台到底剩了什么。 */
  agentJobs(): AgentJobSnapshot[] {
    return this.pool.agentJobs()
  }

  /**
   * 删除会话前先把占着它的 agent 收掉,否则那个进程还在往已删掉的文件里写。
   * 正在跑的一轮不给收 —— 调用方应据此拒绝删除。
   */
  async releaseSession(sessionFile: string): Promise<{ released: boolean; running: boolean }> {
    const entry = this.pool.find(sessionFile)
    if (!entry) return { released: true, running: false }
    if (entry.job.isRunActive()) return { released: false, running: true }
    await this.pool.stopEntry(entry, 'session deleted')
    return { released: true, running: false }
  }

  /** pi 独有能力的入口。ACP 会话在这里明确报错,而不是静默无效。 */
  private requirePi(what: string): RpcClient {
    return this.piOf(this.requireEntry(), what)
  }

  private piOf(entry: AgentEntry, what: string): RpcClient {
    if (!entry.pi) throw unsupportedByBackend(entry, what)
    return entry.pi
  }

  private requireEntry(): AgentEntry {
    if (!this.active) throw new Error(NO_WORKSPACE_ERROR)
    return this.active
  }

  getActiveSessionIdentity(): PiEventContext | null {
    return this.active ? entryContext(this.active) : null
  }

  getRuntimeCapabilities() {
    return this.active?.client.capabilities ?? null
  }

  getAgentStatusSnapshot(): AgentStatusSnapshot | null {
    return this.active?.status.snapshot() ?? null
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

  prompt(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    const checkpoint = entry.status.prompt(message)
    return entry.client.send(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    const checkpoint = entry.status.prompt(message)
    return this.piOf(entry, '插话').steer(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    const entry = this.requireEntry()
    const checkpoint = entry.status.prompt(message)
    return this.piOf(entry, '追问').followUp(message, images).catch((error) => {
      entry.status.promptRejected(checkpoint)
      throw error
    })
  }

  abort(): Promise<void> {
    const entry = this.requireEntry()
    return entry.client.cancel('user requested abort').then(() => {
      entry.outstandingUi.clear()
    })
  }

  bash(command: string): ReturnType<RpcClient['bash']> {
    return this.requirePi('执行 bash 命令').bash(command)
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
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const entry = await this.pool.spawn(null)
    this.activate(entry)
    return { cancelled: false }
  }

  /** 切聊天 = 换看哪个进程;没有进程的会话就现起一个来接管。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const existing = this.pool.find(sessionPath)
    if (existing) {
      this.activate(existing)
      return { cancelled: false }
    }
    const entry = await this.pool.spawn(sessionPath)
    this.activate(entry)
    return { cancelled: false }
  }

  /**
   * ACP 会话没有 pi 的会话状态,但 sessionId 是知道的 —— 合成一份返回,不要抛。
   *
   * 会话侧栏是 `Promise.all([sessions.list(), pi.getState()])`,这里一抛错
   * 整个列表就加载不出来:只要当前会话是外部 agent,侧栏就废了。
   */
  private acpSessionState(entry: AgentEntry): Awaited<ReturnType<RpcClient['getState']>> {
    return {
      thinkingLevel: 'medium',
      isStreaming: entry.job.isRunActive(),
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      sessionId: entry.sessionId ?? entry.job.id,
      autoCompactionEnabled: false,
      messageCount: 0,
      pendingMessageCount: 0,
    }
  }

  async getState(): Promise<Awaited<ReturnType<RpcClient['getState']>>> {
    const entry = this.requireEntry()
    if (!entry.pi) return this.acpSessionState(entry)
    const state = await entry.pi.getState()
    entry.sessionId = state.sessionId
    const sessionFile = this.pool.toHostSessionPath(state.sessionFile ?? null)
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
    if (!entry.pi) {
      // 外部 agent 的历史存在它自己那边,宿主读不到。当前这一轮由事件流驱动,
      // 所以回一份空投影而不是抛错 —— 抛错会让聊天区整个加载失败。
      if (this.active !== entry) return null
      return { sessionId: entry.sessionId ?? entry.job.id, sessionFile: null, messages: [] }
    }
    const pi = entry.pi
    const state = await pi.getState()
    const sessionFile = this.pool.toHostSessionPath(state.sessionFile ?? null)
    entry.sessionId = state.sessionId
    entry.sessionFile = sessionFile
    const messages = await pi.getMessages()
    if (this.active !== entry) return null
    this.lastSessionFile = sessionFile
    return { sessionId: state.sessionId, sessionFile, messages }
  }

  getMessages(): ReturnType<RpcClient['getMessages']> {
    return this.requirePi('读取会话内容').getMessages()
  }

  /** pi 的模型 + 可用的 ACP agent。两边任意一边拉不到都不该让另一边消失。 */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const entry = this.requireEntry()
    if (entry.pi) {
      try {
        this.lastPiModels = (await entry.pi.getAvailableModels()) as ModelInfo[]
      } catch (error) {
        appendAppLog('warn', 'agent.models', 'Failed to list pi models', normalizeError(error))
      }
    }
    let acp: ModelInfo[] = []
    try {
      acp = acpModelEntries(await this.acpRegistry.load())
    } catch (error) {
      // 目录拉不到只是少一组外部 agent,不该让整个模型选择器报错。
      appendAppLog('warn', 'acp.registry', 'Failed to load the ACP agent registry', normalizeError(error))
    }
    return mergeModelEntries(this.lastPiModels, acp)
  }

  /** 选中 ACP agent 不是「换个模型」,是用那个 agent 起一个新会话。 */
  async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
    if (isAcpModelRoute(provider)) return this.startAcpSession(modelId)
    const selected = await this.requirePi('切换模型').setModel(provider, modelId)
    saveSelectedModelRoute(provider, modelId)
    return selected
  }

  private async startAcpSession(agentId: string): Promise<{ provider: string; id: string }> {
    if (!this.pool.launchContext()) throw new Error(NO_WORKSPACE_ERROR)
    const agents = await this.acpRegistry.load()
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) throw new Error(`ACP 目录里没有 ${agentId}`)
    const resolved = resolveAcpLaunchSpec(agent)
    if (!resolved.ok) throw new Error(resolved.error.message)
    const entry = await this.pool.spawnAcp(agentId, resolved.spec)
    this.activate(entry)
    appendAppLog('info', 'acp.session', 'Started an ACP-backed session', {
      cwd: this.workspacePath,
      agentId,
      command: resolved.spec.command,
      sessionId: entry.sessionId,
    })
    return { provider: ACP_MODEL_PROVIDER, id: agentId }
  }

  setThinkingLevel(level: Parameters<RpcClient['setThinkingLevel']>[0]): ReturnType<RpcClient['setThinkingLevel']> {
    return this.requirePi('调整推理深度').setThinkingLevel(level)
  }

  setSteeringMode(mode: Parameters<RpcClient['setSteeringMode']>[0]): ReturnType<RpcClient['setSteeringMode']> {
    return this.requirePi('设置插话模式').setSteeringMode(mode)
  }

  setFollowUpMode(mode: Parameters<RpcClient['setFollowUpMode']>[0]): ReturnType<RpcClient['setFollowUpMode']> {
    return this.requirePi('设置追问模式').setFollowUpMode(mode)
  }

  setAutoCompaction(enabled: boolean): ReturnType<RpcClient['setAutoCompaction']> {
    return this.requirePi('设置自动压缩').setAutoCompaction(enabled)
  }

  compact(): ReturnType<RpcClient['compact']> {
    return this.requirePi('压缩上下文').compact()
  }

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.requirePi('列出命令').getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.requirePi('重命名会话').setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()

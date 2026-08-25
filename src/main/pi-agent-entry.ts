import { resolve, win32 } from 'path'
import type { CompiledRunProfile } from './run-profile'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  ExecutionSecuritySnapshot,
  ExtensionUiResponse,
  PiRuntimeCapabilities,
  PiRuntimeEvent,
  SandboxMode,
} from '../shared/ipc/contract'
import type { PiAgentRunHandle } from './pi-runtime'
import type { BlockingExtensionUiMethod } from './extension-ui-ownership'
import type { AgentJob } from './agent-job-registry'
import type { AgentStatusTracker } from './agent-status'
import type { AgentLoopGuard } from './agent-loop-guard'

export type RpcClient = PiAgentRunHandle

/**
 * 一个 agent 后端最小的共同面:自家的 pi 子进程和通过 ACP 接进来的外部 agent
 * (Claude Code / Codex)都满足它。
 *
 * 进程层和投影层只依赖这一层。pi 独有的那一大票能力(bash、compact、
 * setThinkingLevel、会话读写……)走 {@link AgentEntry.pi},ACP 后端那里是 null,
 * 门面会明确报错而不是静默无效。界面按 `capabilities.features` 提前灰掉。
 */
export type AgentBackend = {
  readonly capabilities: PiRuntimeCapabilities
  send(message: string, images?: ImageContent[]): Promise<void>
  cancel(reason?: string): Promise<void>
  onEvent(listener: (event: PiRuntimeEvent) => void): () => void
  /** 应答阻塞式 UI 请求。pi 转发给子进程,ACP 用它结算 session/request_permission。 */
  respondExtensionUi(response: ExtensionUiResponse): void
  observeProcess(listeners: {
    stderr?: (chunk: Buffer | string) => void
    exit?: (code: number | null, signal: string | null) => void
    error?: (error: Error) => void
  }): void
  processId(): number | null
  dispose(): Promise<void>
  forceDispose(): Promise<void>
}

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
      sandbox?: SandboxMode
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

export type AgentEntry = {
  /** 后端的共同面。进程层和投影层只用这个。 */
  client: AgentBackend
  /** pi 独有的能力面;ACP 会话是 null。 */
  pi: RpcClient | null
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

export type LaunchContext = CompiledRunProfile & { sandboxSessionPaths: boolean }

/** pi 独有的能力在 ACP 会话上不可用时的错误文案。 */
export function unsupportedByBackend(entry: AgentEntry, what: string): Error {
  return new Error(`当前会话由 ${entry.client.capabilities.engine} agent 驱动,不支持${what}`)
}

/**
 * entry 对外的身份。sessionId 在 agent 读到 state 之前是空的,依次回退到会话文件、
 * job id,保证界面任何时候都有一个稳定的键可用。
 */
export function entryContext(entry: AgentEntry): PiEventContext {
  return {
    sessionId: entry.sessionId ?? entry.sessionFile ?? entry.job.id,
    sessionFile: entry.sessionFile,
    runActive: entry.job.isRunActive(),
    awaitingApproval: entry.outstandingUi.size > 0,
    runStartedAt: entry.job.startedRunAt(),
  }
}

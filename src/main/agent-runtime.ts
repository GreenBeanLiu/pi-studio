import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentStatusEvent } from './pi-client'

/**
 * Agent Runtime 权威快照(见 优化.md「Agent Runtime 成为唯一权威状态源」)。
 *
 * renderer 各组件原来分别攒 opening/agentIssue/sandboxMode 等状态,全靠事件
 * 顺序恢复 —— 页面重挂载或 reload 后事件已经错过,状态就猜错了。现在 main
 * 维护显式状态机,renderer 先取快照再订阅带 revision 的变化事件。
 *
 *   closed -> starting -> idle -> running -> idle
 *                       │        ├── awaiting_approval -> running
 *                       │        └── error
 *                       └─────────── error
 *
 * 快照只管生命周期;消息流仍由聊天域自己处理(不把 token 流塞进全局)。
 */

export type AgentRuntimePhase =
  | 'closed'
  | 'starting'
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'stopping'
  | 'error'

export type AgentRuntimeSnapshot = {
  revision: number
  phase: AgentRuntimePhase
  workspacePath: string | null
  sessionFile: string | null
  sandbox: 'wsl' | 'docker' | null
  activeRun: { startedAt: number } | null
  error: { message: string } | null
}

/** 需要用户响应的扩展 UI 请求方法(其余 setStatus/notify 之类不阻塞运行) */
const APPROVAL_METHODS = new Set(['confirm', 'select', 'input'])

export class AgentRuntimeTracker {
  private snap: AgentRuntimeSnapshot = {
    revision: 0,
    phase: 'closed',
    workspacePath: null,
    sessionFile: null,
    sandbox: null,
    activeRun: null,
    error: null,
  }

  constructor(private broadcast: (snapshot: AgentRuntimeSnapshot) => void = () => {}) {}

  snapshot(): AgentRuntimeSnapshot {
    return { ...this.snap, activeRun: this.snap.activeRun ? { ...this.snap.activeRun } : null }
  }

  private patch(next: Partial<AgentRuntimeSnapshot>): void {
    this.snap = { ...this.snap, ...next, revision: this.snap.revision + 1 }
    this.broadcast(this.snapshot())
  }

  starting(workspacePath: string): void {
    this.patch({
      phase: 'starting',
      workspacePath,
      sessionFile: null,
      sandbox: null,
      activeRun: null,
      error: null,
    })
  }

  /** startWorkspace 抛异常(子进程没起来) */
  startFailed(message: string): void {
    this.patch({ phase: 'error', error: { message }, activeRun: null })
  }

  status(event: AgentStatusEvent): void {
    // 旧工作区子进程的收尾事件不应打翻新工作区的状态
    if (this.snap.workspacePath && event.cwd !== this.snap.workspacePath) return
    if (event.status === 'started') {
      this.patch({
        phase: 'idle',
        sandbox: event.sandbox ?? null,
        sessionFile: event.sessionFile ?? null,
        activeRun: null,
        error: null,
      })
      return
    }
    if (event.status === 'exited' && event.expected) {
      this.patch({ phase: 'closed', activeRun: null })
      return
    }
    this.patch({ phase: 'error', error: { message: event.message }, activeRun: null })
  }

  agentEvent(event: AgentSessionEvent | { type: string; [k: string]: unknown }): void {
    const phase = this.snap.phase
    switch (event.type) {
      case 'agent_start':
        this.patch({ phase: 'running', activeRun: { startedAt: Date.now() }, error: null })
        return
      case 'agent_settled':
        // agent_end 后可能还有收尾事件,settled 才是稳定回到 idle 的点
        if (phase === 'running' || phase === 'awaiting_approval') {
          this.patch({ phase: 'idle', activeRun: null })
        }
        return
      case 'extension_ui_request': {
        const method = (event as { method?: string }).method
        if (phase === 'running' && method && APPROVAL_METHODS.has(method)) {
          this.patch({ phase: 'awaiting_approval' })
        }
        return
      }
      default:
        return
    }
  }

  /** 用户回应了扩展 UI(确认/选择/输入),回到 running */
  uiResponded(): void {
    if (this.snap.phase === 'awaiting_approval') this.patch({ phase: 'running' })
  }

  stopping(): void {
    if (this.snap.phase !== 'closed') this.patch({ phase: 'stopping', activeRun: null })
  }

  closed(): void {
    this.patch({
      phase: 'closed',
      workspacePath: null,
      sessionFile: null,
      sandbox: null,
      activeRun: null,
      error: null,
    })
  }
}

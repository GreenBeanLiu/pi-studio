import type { AgentStatusEvent, ThinkingLevel } from '../../../shared/ipc/contract'
import type { ToolExecutionState } from './ToolCallCard'

/** 主进程报上来的、不会自行恢复的 agent 进程故障(started 之外的状态)。 */
export type AgentIssue = Exclude<AgentStatusEvent, { status: 'started' }>

export type RunStatus = 'running' | 'done' | 'error' | 'aborted'

export type RunTimelineItem = {
  id: string
  type: 'event' | 'tool'
  label: string
  detail?: string
  timestamp: string
  status?: RunStatus
}

export type RunToolRecord = {
  id: string
  toolName: string
  args?: unknown
  status: ToolExecutionState['status']
  result?: unknown
  startedAt: string
  endedAt?: string
}

export type RunRecord = {
  id: string
  workspaceName?: string
  workspacePath?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  model?: string
  provider?: string
  thinking: ThinkingLevel
  tools: RunToolRecord[]
  timeline: RunTimelineItem[]
}

export type MemorySuggestion = {
  id: string
  createdAt: string
  content: string
}

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'error'

export type ToolApprovalRequest = {
  id: string
  runId: string | null
  title: string
  message: string
  command?: string
  reason?: string
  createdAt: string
  status: ApprovalStatus
  error?: string
}

export type ApprovalDecision = 'allow-once' | 'deny'

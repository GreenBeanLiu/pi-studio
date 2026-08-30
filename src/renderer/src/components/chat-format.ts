import type { GitChangedFile } from '../../../shared/ipc/contract'
import { type AgentIssue, type ApprovalStatus, type RunStatus } from './chat-types'

/** 消息 content 既可能是纯字符串,也可能是分段数组;只取 text 段拼起来。 */
export function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDuration(startedAt: string, endedAt?: string): string {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  const total = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function formatAgentElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.round((now - startedAt) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** 工具参数在卡片标题上只有一行位置,优先挑最能说明意图的那个字段。 */
export function summarizeToolArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object') {
    const obj = args as Record<string, unknown>
    const candidate = obj.command ?? obj.path ?? obj.file_path ?? obj.pattern ?? obj.query
    if (typeof candidate === 'string') return candidate
  }
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

export function runStatusLabel(status: RunStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'done') return '已完成'
  if (status === 'error') return '失败'
  return '已停止'
}

export function firstLine(value: string, limit = 220): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit)}...` : line
}

export function approvalStatusLabel(status: ApprovalStatus): string {
  if (status === 'pending') return '等待确认'
  if (status === 'allowed') return '已允许'
  if (status === 'error') return '处理失败'
  return '已拒绝'
}

export function uniqueList(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, limit)
}

export function gitStatusLabel(file: GitChangedFile): string {
  if (file.statusCode === '??') return 'NEW'
  if (file.statusCode.includes('D')) return 'DEL'
  if (file.statusCode.includes('R')) return 'REN'
  if (file.statusCode.includes('A')) return 'ADD'
  if (file.statusCode.includes('M')) return 'MOD'
  return file.statusCode.trim() || 'CHG'
}

export function agentIssueMessage(issue: AgentIssue): string {
  if (issue.status === 'exited') {
    const detail =
      issue.code === null ? `signal ${issue.signal ?? 'unknown'}` : `exit code ${issue.code}`
    return `Agent 进程已退出（${detail}）。当前会话记录仍保留，重启 agent 后可继续。`
  }
  return `Agent 进程异常：${issue.message}`
}

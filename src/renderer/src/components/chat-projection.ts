import type {
  AgentMessage,
  ApprovalProjection,
  SessionProjectionSnapshot,
  ToolExecutionProjection,
} from '../../../shared/ipc/contract'
import type { ToolExecutionState } from './ToolCallCard'
import type { ApprovalStatus, ToolApprovalRequest } from './chat-types'

export function approvalFromProjection(approval: ApprovalProjection): ToolApprovalRequest {
  const status: ApprovalStatus =
    approval.outcome === 'pending'
      ? 'pending'
      : approval.outcome === 'allowed-once'
        ? 'allowed'
        : approval.outcome === 'unavailable'
          ? 'error'
          : 'denied'
  return {
    id: approval.id,
    runId: approval.runId,
    title: approval.title,
    message: approval.message,
    command: approval.command,
    reason: approval.reason,
    createdAt: approval.createdAt,
    status,
    error: approval.error,
  }
}

export function toolsFromProjection(
  tools: Record<string, ToolExecutionProjection>,
): Record<string, ToolExecutionState> {
  return Object.fromEntries(
    Object.entries(tools).map(([id, tool]) => [
      id,
      {
        toolName: tool.toolName,
        args: tool.args,
        status: tool.status,
        result: tool.result,
        details: tool.details,
        artifact: tool.artifact,
      },
    ]),
  )
}

/** 渲染层当前状态里、决定一份 projection 该怎么落地的那两个值。 */
export type ProjectionContext = {
  /** 当前打开的工作区路径;没开工作区时是 undefined。 */
  workspacePath: string | undefined
  /** 上一次真正被采纳的 messagesRevision;冷启动/切工作区后是 null。 */
  appliedMessagesRevision: number | null
}

export type ProjectionPlan =
  /** 不是当前工作区的 projection，整份丢弃。 */
  | { kind: 'ignore' }
  | {
      kind: 'apply'
      /**
       * 只有 messagesRevision 变过才给出替换计划;为 null 表示**不要碰**本地消息列表
       * —— 本地那份是 message_start/update 流式拼出来的,比 projection 新。
       */
      messages: { list: AgentMessage[]; revision: number } | null
      /** 工具和审批是实时的,每份 projection 都要落地。 */
      tools: Record<string, ToolExecutionState>
      approvals: ToolApprovalRequest[]
    }

/**
 * 把一份 projection 折算成"该改什么"。
 *
 * 2026-08-23 的 bug:提一个问题画面刷一下,刚打的字就没了。工具和审批是实时的,
 * 消息不是 —— snapshot.messages 只在落库读取后才更新,而运行途中每个工具事件
 * 都会广播一份 projection,那时它带的还是上一轮的旧消息。无条件 setMessages
 * 会把刚发出的用户消息和正在流式输出的回复一起抹掉,顺带清空 streamingIndex,
 * 让后续 message_update 追加出一条重复的回复。
 */
export function planProjectionApply(
  projection: SessionProjectionSnapshot,
  context: ProjectionContext,
): ProjectionPlan {
  if (projection.workspacePath !== context.workspacePath) return { kind: 'ignore' }
  return {
    kind: 'apply',
    messages:
      projection.messagesRevision !== context.appliedMessagesRevision
        ? { list: projection.messages, revision: projection.messagesRevision }
        : null,
    tools: toolsFromProjection(projection.tools),
    approvals: projection.approvals.map(approvalFromProjection),
  }
}

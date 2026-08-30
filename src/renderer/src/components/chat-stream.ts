import type { AgentMessage, AssistantMessage } from '../../../shared/ipc/contract'

/**
 * 流式拼装的结果:消息列表 + 下一条 message_update 该写到哪一格。
 * streamingIndex 为 null 表示"没有正在流的消息"。
 */
export type StreamState = {
  messages: AgentMessage[]
  streamingIndex: number | null
}

/** message_start:新开一条,并把游标指向它。 */
export function beginStreamingMessage(
  messages: AgentMessage[],
  message: AgentMessage,
): StreamState {
  return { messages: [...messages, { ...message }], streamingIndex: messages.length }
}

/**
 * message_update / message_end:改写游标那一格。
 *
 * 游标为空或越界时退化成追加并重新指向 —— 越界是真会发生的:projection 覆盖过
 * 消息列表之后,旧游标就指到列表外面去了。不做这个兜底,同一条回复会在界面上出现两次。
 */
export function applyStreamingMessage(
  messages: AgentMessage[],
  streamingIndex: number | null,
  message: AgentMessage,
): StreamState {
  if (streamingIndex === null || streamingIndex >= messages.length) {
    return { messages: [...messages, { ...message }], streamingIndex: messages.length }
  }
  const next = messages.slice()
  next[streamingIndex] = { ...message }
  return { messages: next, streamingIndex }
}

/**
 * 失败的一轮同样以 agent_end 收尾,区别只在最后一条 assistant 消息的 stopReason。
 * 不记下来,收尾时就会把报错的一轮当成"任务完成":弹完成通知、弹 diff 审阅、
 * 运行记录标 done —— 用户唯一看得到的线索就是"没有回复"。
 *
 * 三态是有意的,别塌成两态:
 * - `string` 这条 assistant 消息失败了
 * - `null`   这条 assistant 消息正常,清掉之前记下的失败
 * - `undefined` 不是 assistant 消息 —— **别动**已记下的失败。塌成 null 的话,
 *   报错之后紧跟的一条工具结果 message_end 就会把失败抹掉,这一轮又被当成完成。
 */
export function assistantErrorOf(message: AgentMessage): string | null | undefined {
  if ((message as { role?: string }).role !== 'assistant') return undefined
  const assistant = message as AssistantMessage
  return assistant.stopReason === 'error' ? (assistant.errorMessage ?? '模型调用失败') : null
}

/**
 * pi 会话消息的两种读法:「这一步说了什么」和「这一步为什么什么都没说」。
 * 抽成纯函数是为了能脱离 routines.ts(它拉整个 electron 主进程)单测。
 */

export type AgentMessage = {
  role?: string
  content?: Array<{ type?: string; text?: string }> | string
  stopReason?: string
  errorMessage?: string
}

/** 最后一条有正文的 assistant 消息,就是这一步的产出。 */
export function latestAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
      : typeof message.content === 'string'
        ? message.content
        : ''
    if (text.trim()) return text.trim()
  }
  return ''
}

/**
 * 上游调用失败时 pi 记下的是一条 content 为空、stopReason 为 'error' 的 assistant
 * 消息,真正的原因在 errorMessage 里(网关 502、鉴权失败、模型不存在……)。只判断
 * 有没有文本会把这些统统归成「没有产出」,把人往错的方向指 —— 所以没文本时要把
 * 这句话捞出来一起报。
 */
export function latestAssistantFailure(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (message.stopReason !== 'error') continue
    const reason = message.errorMessage?.trim()
    if (reason) return reason
  }
  return ''
}

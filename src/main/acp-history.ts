import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai'
import type { AcpSessionUpdate } from './acp-event-mapper'

/**
 * 把 `session/load` 回放的 session/update 流投影成 pi 的对话记录。
 *
 * 这和 {@link AcpTurnProjector} 是两件事:那个投的是「正在发生的一轮」,产出事件流;
 * 这个投的是「已经发生过的历史」,产出消息数组。回放没有轮次边界 ——
 * 它就是把整段对话重放一遍,所以不能emit agent_start / agent_settled,
 * 否则界面会以为有一轮正在跑。
 */

type PendingAssistant = {
  content: (TextContent | ThinkingContent | ToolCall)[]
  open: { kind: 'text' | 'thinking'; index: number } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function chunkText(update: AcpSessionUpdate): string | null {
  const content = update.content
  if (!isRecord(content)) return null
  return typeof content.text === 'string' ? content.text : null
}

function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function toolNameOf(update: AcpSessionUpdate): string | undefined {
  const meta = update._meta
  if (isRecord(meta)) {
    for (const scope of Object.values(meta)) {
      const name = readString(scope, 'toolName')
      if (name) return name
    }
  }
  return readString(update, 'name') ?? readString(update, 'kind') ?? readString(update, 'title')
}

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'error', 'cancelled'])

function resultText(update: AcpSessionUpdate): string {
  const raw = update.rawOutput
  if (typeof raw === 'string') return raw
  if (raw !== undefined) return JSON.stringify(raw)
  const content = update.content
  if (Array.isArray(content)) {
    return content
      .map((item) => readString(isRecord(item) ? item.content : undefined, 'text') ?? '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export type AcpHistoryOptions = {
  modelId: string
  now?: () => number
}

/**
 * 回放投影。
 *
 * 顺序按 pi 的口径来:用户消息 → 助手消息(里面带 toolCall 块)→ 工具结果 →
 * 助手继续。所以工具结果到达时要先把当前那条助手消息收掉 —— 那条里装着对应的
 * 调用,后面的正文属于下一条助手消息。多个并行调用会攒在一起一次性刷出。
 */
export function projectAcpHistory(
  updates: readonly AcpSessionUpdate[],
  options: AcpHistoryOptions,
): AgentMessage[] {
  const messages: AgentMessage[] = []
  let clock = options.now?.() ?? Date.now()
  const stamp = () => clock++

  let userText = ''
  let assistant: PendingAssistant | null = null
  const toolNames = new Map<string, string>()
  let pendingResults: Omit<ToolResultMessage, 'timestamp'>[] = []

  const flushUser = (): void => {
    if (!userText) return
    const message: UserMessage = { role: 'user', content: userText, timestamp: stamp() }
    messages.push(message)
    userText = ''
  }

  const flushAssistant = (): void => {
    if (assistant && assistant.content.length > 0) {
      const message: AssistantMessage = {
        role: 'assistant',
        content: assistant.content,
        api: 'acp',
        provider: 'acp',
        model: options.modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: stamp(),
      }
      messages.push(message)
    }
    assistant = null
    if (pendingResults.length > 0) {
      // 时间戳在入数组时才盖:结果是在 tool_call_update 时构造的,但要排在
      // 带着那次调用的助手消息之后 —— 构造时盖戳会让时间戳和顺序对不上。
      for (const result of pendingResults) messages.push({ ...result, timestamp: stamp() })
      pendingResults = []
    }
  }

  const appendStream = (kind: 'text' | 'thinking', text: string): void => {
    flushUser()
    assistant ??= { content: [], open: null }
    if (assistant.open && assistant.open.kind !== kind) assistant.open = null
    if (!assistant.open) {
      const index = assistant.content.length
      assistant.content.push(
        kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      )
      assistant.open = { kind, index }
    }
    const block = assistant.content[assistant.open.index]!
    if (block.type === 'text') block.text += text
    else if (block.type === 'thinking') block.thinking += text
  }

  for (const update of updates) {
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        // 用户又开口了,说明上一段助手的话已经结束。
        flushAssistant()
        const text = chunkText(update)
        if (text) userText += text
        break
      }
      case 'agent_message_chunk': {
        const text = chunkText(update)
        if (text) appendStream('text', text)
        break
      }
      case 'agent_thought_chunk': {
        const text = chunkText(update)
        if (text) appendStream('thinking', text)
        break
      }
      case 'tool_call': {
        const toolCallId = readString(update, 'toolCallId')
        if (!toolCallId) break
        flushUser()
        const name = toolNameOf(update) ?? 'tool'
        toolNames.set(toolCallId, name)
        assistant ??= { content: [], open: null }
        assistant.open = null
        assistant.content.push({
          type: 'toolCall',
          id: toolCallId,
          name,
          arguments: isRecord(update.rawInput) ? { ...update.rawInput } : {},
        })
        break
      }
      case 'tool_call_update': {
        const toolCallId = readString(update, 'toolCallId')
        if (!toolCallId) break
        // 参数是分片来的:pending 时常常是 {},补全后回填到那个调用块上。
        if (isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0 && assistant) {
          const block = assistant.content.find(
            (item): item is ToolCall => item.type === 'toolCall' && item.id === toolCallId,
          )
          if (block) block.arguments = { ...block.arguments, ...update.rawInput }
        }
        const status = readString(update, 'status')
        if (!status || !TERMINAL_TOOL_STATUS.has(status)) break
        pendingResults.push({
          role: 'toolResult',
          toolCallId,
          toolName: toolNames.get(toolCallId) ?? toolNameOf(update) ?? 'tool',
          content: [{ type: 'text', text: resultText(update) }],
          isError: status !== 'completed',
        })
        toolNames.delete(toolCallId)
        // 结果到了就把带着这次调用的那条助手消息收掉,后面的正文属于下一条。
        flushAssistant()
        break
      }
      // 其余都不是对话内容:available_commands_update 实测一帧 18KB+,
      // plan / mode / usage 是运行时状态,回放里没有意义。
      default:
        break
    }
  }
  flushUser()
  flushAssistant()
  return messages
}

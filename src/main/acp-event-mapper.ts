import type {
  AssistantMessage,
  AssistantMessageEvent,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

/**
 * 把 ACP 的 `session/update` 流投影成 pi 的 AgentSessionEvent 流。
 *
 * 这样外部 agent(Claude Code / Codex)走的是和自家 pi 进程**完全同一条**渲染管线:
 * ChatPane、ToolCallCard、AgentStatusTracker、循环检测、job 记账全都不用改。
 *
 * 事件名和形状取自 2026-08-25 对 codex-acp@1.6.2 与 claude-agent-acp@0.70.0 的实测抓包。
 */

export type AcpSessionUpdate = {
  sessionUpdate: string
  [key: string]: unknown
}

/** ACP 那边一轮的收尾原因。 */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

const ACP_API = 'acp'

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function chunkText(update: AcpSessionUpdate): string | null {
  const content = update.content
  if (!content || typeof content !== 'object') return null
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 工具名,按「越程序化越优先」取:
 *
 * 1. `_meta.<vendor>.toolName` —— Claude 走这条,给的是 Bash / Read / Write
 * 2. `name` —— schema 里标着 UNSTABLE 的程序名字段
 * 3. `kind` —— read / edit / execute 这类固定分类
 * 4. `title` —— 最后才用它
 *
 * `title` 是给人看的一句话,会随参数变:实测 Claude 把整条命令、Codex 把整个文件路径
 * 都塞进 title。拿它当工具名,一轮里的名字会前后不一致,tool_execution_end 配不上 start。
 */
function toolNameOf(update: AcpSessionUpdate): string | undefined {
  const meta = update._meta
  if (meta && typeof meta === 'object') {
    for (const scope of Object.values(meta as Record<string, unknown>)) {
      const name = readString(scope, 'toolName')
      if (name) return name
    }
  }
  return readString(update, 'name') ?? readString(update, 'kind') ?? readString(update, 'title')
}

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'error', 'cancelled'])

/**
 * 一轮的投影器。一个 ACP 会话一轮 prompt 起一个,`begin()` → 若干 `apply()` → `finish()`。
 */
export class AcpTurnProjector {
  private content: (TextContent | ThinkingContent | ToolCall)[] = []
  private usage: Usage = emptyUsage()
  private messageStarted = false
  /** 当前还开着的流式块,决定新 chunk 是续写还是另起一个 contentIndex。 */
  private open: { kind: 'text' | 'thinking'; index: number } | null = null
  private readonly toolNames = new Map<string, string>()
  private settled = false

  constructor(
    private readonly modelId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 一轮开始。 */
  begin(): PiRuntimeEvent[] {
    return [{ type: 'agent_start' }, { type: 'turn_start' }]
  }

  apply(update: AcpSessionUpdate): PiRuntimeEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.appendStream('text', chunkText(update))
      case 'agent_thought_chunk':
        return this.appendStream('thinking', chunkText(update))
      case 'tool_call':
        return this.startTool(update)
      case 'tool_call_update':
        return this.updateTool(update)
      case 'usage_update':
        this.absorbUsage(update)
        return []
      // available_commands_update 实测一帧能有 18KB+(装了多少 skill 就有多长),
      // 而且同一轮里会重复推 —— 它不是对话内容,直接丢掉,别灌进渲染管线。
      case 'available_commands_update':
      case 'session_info_update':
      case 'plan':
      case 'current_mode_update':
        return []
      default:
        return []
    }
  }

  /** 一轮正常收尾。 */
  finish(stopReason: AcpStopReason): PiRuntimeEvent[] {
    if (this.settled) return []
    this.settled = true
    const events: PiRuntimeEvent[] = []
    events.push(...this.closeOpenBlock())
    const message = this.snapshot(this.toPiStopReason(stopReason))
    // 一个字都没吐过就没有 message 可以结束,直接收 turn。
    if (this.messageStarted) events.push({ type: 'message_end', message })
    events.push({ type: 'turn_end', message, toolResults: [] })
    events.push({ type: 'agent_end', messages: [message], willRetry: false })
    events.push({ type: 'agent_settled' })
    return events
  }

  /** 一轮出错收尾。错误要摆到界面上,不能让这一轮凭空消失。 */
  fail(message: string): PiRuntimeEvent[] {
    if (this.settled) return []
    const events: PiRuntimeEvent[] = [{ type: 'run_failed', scope: 'prompt', message }]
    this.settled = true
    events.push(...this.closeOpenBlock())
    const snapshot = this.snapshot('error')
    snapshot.errorMessage = message
    if (this.messageStarted) events.push({ type: 'message_end', message: snapshot })
    events.push({ type: 'turn_end', message: snapshot, toolResults: [] })
    events.push({ type: 'agent_end', messages: [snapshot], willRetry: false })
    events.push({ type: 'agent_settled' })
    return events
  }

  private toPiStopReason(reason: AcpStopReason): StopReason {
    if (reason === 'cancelled') return 'aborted'
    if (reason === 'max_tokens') return 'length'
    if (reason === 'refusal') return 'error'
    return 'stop'
  }

  private appendStream(kind: 'text' | 'thinking', text: string | null): PiRuntimeEvent[] {
    if (!text) return []
    const events: PiRuntimeEvent[] = []
    if (!this.messageStarted) {
      this.messageStarted = true
      events.push({ type: 'message_start', message: this.snapshot() })
    }
    // 换了种类就得另起一个内容块,否则思考和正文会串进同一个 contentIndex。
    if (this.open && this.open.kind !== kind) {
      events.push(...this.closeOpenBlock())
    }
    if (!this.open) {
      const index = this.content.length
      this.content.push(
        kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      )
      this.open = { kind, index }
      events.push(
        this.streamEvent(kind === 'text' ? 'text_start' : 'thinking_start', index),
      )
    }
    const block = this.content[this.open.index]!
    if (block.type === 'text') block.text += text
    else if (block.type === 'thinking') block.thinking += text
    events.push(
      this.streamEvent(kind === 'text' ? 'text_delta' : 'thinking_delta', this.open.index, text),
    )
    return events
  }

  private closeOpenBlock(): PiRuntimeEvent[] {
    if (!this.open) return []
    const { kind, index } = this.open
    this.open = null
    const block = this.content[index]!
    const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : ''
    return [this.streamEvent(kind === 'text' ? 'text_end' : 'thinking_end', index, undefined, text)]
  }

  private streamEvent(
    type: 'text_start' | 'text_delta' | 'text_end' | 'thinking_start' | 'thinking_delta' | 'thinking_end',
    contentIndex: number,
    delta?: string,
    content?: string,
  ): Extract<PiRuntimeEvent, { type: 'message_update' }> {
    const partial = this.snapshot()
    const base = { contentIndex, partial }
    const assistantMessageEvent = (
      type === 'text_delta' || type === 'thinking_delta'
        ? { type, ...base, delta: delta ?? '' }
        : type === 'text_end' || type === 'thinking_end'
          ? { type, ...base, content: content ?? '' }
          : { type, ...base }
    ) as AssistantMessageEvent
    return { type: 'message_update', message: partial, assistantMessageEvent }
  }

  private startTool(update: AcpSessionUpdate): PiRuntimeEvent[] {
    const toolCallId = readString(update, 'toolCallId')
    if (!toolCallId) return []
    const toolName = toolNameOf(update) ?? 'tool'
    this.toolNames.set(toolCallId, toolName)
    const args = (update.rawInput ?? {}) as Record<string, unknown>
    const events: PiRuntimeEvent[] = []
    // 工具调用打断当前的流式块:先把它收掉,工具结果之后的正文会另起一块。
    events.push(...this.closeOpenBlock())
    this.content.push({ type: 'toolCall', id: toolCallId, name: toolName, arguments: args })
    events.push({ type: 'tool_execution_start', toolCallId, toolName, args })
    return events
  }

  private updateTool(update: AcpSessionUpdate): PiRuntimeEvent[] {
    const toolCallId = readString(update, 'toolCallId')
    if (!toolCallId) return []
    // 名字只在 start 时定下来。update 里的 title 会随参数变化(实测 Claude 会把
    // 整条命令塞进 title),拿它当名字会让 end 和 start 对不上。
    const toolName = this.toolNames.get(toolCallId) ?? toolNameOf(update) ?? 'tool'
    const status = readString(update, 'status')
    // 参数是分片来的:pending 时 rawInput 常常是 {},补全后再推一次。
    if (update.rawInput !== undefined) {
      this.mergeToolArguments(toolCallId, update.rawInput as Record<string, unknown>)
    }
    if (!status || !TERMINAL_TOOL_STATUS.has(status)) {
      if (update.rawOutput === undefined) return []
      return [
        {
          type: 'tool_execution_update',
          toolCallId,
          toolName,
          args: this.toolArguments(toolCallId),
          partialResult: update.rawOutput,
        },
      ]
    }
    this.toolNames.delete(toolCallId)
    return [
      {
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: update.rawOutput ?? update.content ?? null,
        isError: status !== 'completed',
      },
    ]
  }

  private mergeToolArguments(toolCallId: string, args: Record<string, unknown>): void {
    if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return
    const block = this.content.find(
      (item): item is ToolCall => item.type === 'toolCall' && item.id === toolCallId,
    )
    if (block) block.arguments = { ...block.arguments, ...args }
  }

  private toolArguments(toolCallId: string): Record<string, unknown> {
    const block = this.content.find(
      (item): item is ToolCall => item.type === 'toolCall' && item.id === toolCallId,
    )
    return block?.arguments ?? {}
  }

  /**
   * ACP 的 usage_update 只给「用了多少 / 上限多少」,没有 input/output 拆分。
   * 只填 totalTokens,别把 0 当成真实的输入输出数上报。
   */
  private absorbUsage(update: AcpSessionUpdate): void {
    const used = typeof update.used === 'number' ? update.used : null
    if (used !== null) this.usage.totalTokens = used
    const cost = update.cost
    if (cost && typeof cost === 'object') {
      const amount = (cost as { amount?: unknown }).amount
      if (typeof amount === 'number') this.usage.cost.total = amount
    }
  }

  private snapshot(stopReason: StopReason = 'pending'): AssistantMessage {
    return {
      role: 'assistant',
      content: this.content.map((block) => ({ ...block })),
      api: ACP_API,
      provider: ACP_API,
      model: this.modelId,
      usage: { ...this.usage, cost: { ...this.usage.cost } },
      stopReason,
      timestamp: this.now(),
    }
  }
}

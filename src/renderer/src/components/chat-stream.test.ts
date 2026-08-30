import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../shared/ipc/contract'
import { applyStreamingMessage, assistantErrorOf, beginStreamingMessage } from './chat-stream'

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage
}

function assistant(text: string, over: Record<string, unknown> = {}): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], ...over } as unknown as AgentMessage
}

function toolResult(): AgentMessage {
  return { role: 'toolResult', content: [] } as unknown as AgentMessage
}

describe('beginStreamingMessage', () => {
  it('追加一条并把游标指向它', () => {
    const state = beginStreamingMessage([user('问')], assistant(''))
    expect(state.messages).toHaveLength(2)
    expect(state.streamingIndex).toBe(1)
  })

  it('拷贝而不是把事件里的对象直接塞进列表', () => {
    const incoming = assistant('')
    expect(beginStreamingMessage([], incoming).messages[0]).not.toBe(incoming)
  })
})

describe('applyStreamingMessage', () => {
  it('改写游标那一格,不动别的', () => {
    const state = applyStreamingMessage([user('问'), assistant('答')], 1, assistant('答完整'))
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toMatchObject({ content: [{ type: 'text', text: '答完整' }] })
    expect(state.streamingIndex).toBe(1)
  })

  it('游标为空时追加并重新指向', () => {
    const state = applyStreamingMessage([user('问')], null, assistant('答'))
    expect(state.messages).toHaveLength(2)
    expect(state.streamingIndex).toBe(1)
  })

  // projection 覆盖过消息列表之后,旧游标会指到列表外面。不兜底的话
  // next[5] = msg 会在数组里挖出一串空洞,同一条回复也会出现两次。
  it('游标越界时追加并重新指向,而不是写出空洞', () => {
    const state = applyStreamingMessage([user('问')], 5, assistant('答'))
    expect(state.messages).toHaveLength(2)
    expect(state.streamingIndex).toBe(1)
    expect(state.messages.every((m) => m !== undefined)).toBe(true)
  })

  it('连续 update 落在同一格,不会越堆越多', () => {
    let state = beginStreamingMessage([user('问')], assistant('答'))
    for (const text of ['答一', '答一二', '答一二三']) {
      state = applyStreamingMessage(state.messages, state.streamingIndex, assistant(text))
    }
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toMatchObject({ content: [{ type: 'text', text: '答一二三' }] })
  })
})

describe('assistantErrorOf 的三态', () => {
  it('失败的 assistant 消息给出原因', () => {
    expect(assistantErrorOf(assistant('', { stopReason: 'error', errorMessage: '上游 502' }))).toBe('上游 502')
  })

  it('失败但没带原因时有兜底文案', () => {
    expect(assistantErrorOf(assistant('', { stopReason: 'error' }))).toBe('模型调用失败')
  })

  it('正常的 assistant 消息返回 null —— 清掉之前记下的失败', () => {
    expect(assistantErrorOf(assistant('答', { stopReason: 'endTurn' }))).toBeNull()
  })

  // 塌成两态就会重现那个 bug:报错之后紧跟一条工具结果的 message_end,
  // 失败被抹掉,agent_end 把这一轮当成完成 —— 弹"任务完成"、弹 diff 审阅。
  it('非 assistant 消息返回 undefined,表示别动已记下的失败', () => {
    expect(assistantErrorOf(toolResult())).toBeUndefined()
    expect(assistantErrorOf(user('问'))).toBeUndefined()
  })

  it('串起来:失败之后来一条工具结果,失败不能被冲掉', () => {
    let recorded: string | null = null
    for (const msg of [assistant('', { stopReason: 'error', errorMessage: '上游 502' }), toolResult()]) {
      const failure = assistantErrorOf(msg)
      if (failure !== undefined) recorded = failure
    }
    expect(recorded).toBe('上游 502')
  })
})

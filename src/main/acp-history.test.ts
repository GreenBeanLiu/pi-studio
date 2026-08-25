import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { AcpSessionUpdate } from './acp-event-mapper'
import { projectAcpHistory } from './acp-history'

function project(updates: AcpSessionUpdate[]): AgentMessage[] {
  let clock = 1_000
  return projectAcpHistory(updates, { modelId: 'codex-acp', now: () => clock++ })
}

const user = (text: string): AcpSessionUpdate => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text },
})
const agent = (text: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})
const thought = (text: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
})
const toolStart = (id: string, name: string, args: unknown = {}): AcpSessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  status: 'pending',
  name,
  rawInput: args,
})
const toolDone = (id: string, output: unknown, status = 'completed'): AcpSessionUpdate => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status,
  rawOutput: output,
})

function roles(messages: readonly AgentMessage[]): string[] {
  return messages.map((message) => (message as { role: string }).role)
}

describe('a plain exchange', () => {
  it('projects user then assistant', () => {
    const messages = project([user('你好'), agent('你'), agent('好')])
    expect(roles(messages)).toEqual(['user', 'assistant'])
    expect((messages[0] as UserMessage).content).toBe('你好')
    expect((messages[1] as AssistantMessage).content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('splits several rounds apart', () => {
    const messages = project([user('一'), agent('A'), user('二'), agent('B')])
    expect(roles(messages)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect((messages[2] as UserMessage).content).toBe('二')
  })

  // 思考和正文串成一块的话,界面会把推理过程当回答渲染出来。
  it('keeps thinking in its own content block', () => {
    const messages = project([user('q'), thought('想一下'), agent('答')])
    expect((messages[1] as AssistantMessage).content).toEqual([
      { type: 'thinking', thinking: '想一下' },
      { type: 'text', text: '答' },
    ])
  })

  it('returns nothing for an empty replay', () => {
    expect(project([])).toEqual([])
  })

  it('drops chunks with no usable text', () => {
    expect(project([user('') , { sessionUpdate: 'agent_message_chunk' }])).toEqual([])
  })
})

// pi 的口径:用户 → 助手(带 toolCall 块)→ 工具结果 → 助手继续。
// 结果排在带着那次调用的助手消息之前的话,界面对不上号。
describe('tool calls', () => {
  it('orders the assistant message before its tool result', () => {
    const messages = project([
      user('读一下'),
      agent('我先看看'),
      toolStart('c1', 'read', { path: 'hello.txt' }),
      toolDone('c1', 'hello world'),
      agent('里面写着 hello world'),
    ])
    expect(roles(messages)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    const call = (messages[1] as AssistantMessage).content.at(-1)
    expect(call).toEqual({ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'hello.txt' } })
    expect((messages[2] as ToolResultMessage).toolCallId).toBe('c1')
    expect((messages[3] as AssistantMessage).content).toEqual([
      { type: 'text', text: '里面写着 hello world' },
    ])
  })

  it('puts both parallel calls in one assistant message, results after it', () => {
    const messages = project([
      user('两件事'),
      toolStart('c1', 'read'),
      toolStart('c2', 'grep'),
      toolDone('c1', 'a'),
      toolDone('c2', 'b'),
      agent('都看完了'),
    ])
    // 两次调用在同一条助手消息里,两个结果依次跟在它后面
    expect(roles(messages)).toEqual(['user', 'assistant', 'toolResult', 'toolResult', 'assistant'])
    expect((messages[1] as AssistantMessage).content.map((c) => (c as { id?: string }).id)).toEqual([
      'c1',
      'c2',
    ])
    expect([messages[2], messages[3]].map((m) => (m as ToolResultMessage).toolCallId)).toEqual([
      'c1',
      'c2',
    ])
  })

  it('marks a failed call as an error result', () => {
    const messages = project([user('q'), toolStart('c1', 'bash'), toolDone('c1', 'boom', 'failed')])
    const result = messages.find((m) => (m as { role: string }).role === 'toolResult') as ToolResultMessage
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }])
  })

  // 参数是分片来的:tool_call 时常常是 {},随后的 update 才补上。
  it('back-fills arguments that arrive on a later update', () => {
    const messages = project([
      user('q'),
      toolStart('c1', 'bash', {}),
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { command: 'ls -la' } },
      toolDone('c1', 'total 8'),
    ])
    const call = (messages[1] as AssistantMessage).content[0]
    expect(call).toMatchObject({ arguments: { command: 'ls -la' } })
  })

  it('prefers the vendor tool name over the human title', () => {
    const messages = project([
      user('q'),
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: "Read file '/very/long/path.txt'",
        kind: 'read',
        _meta: { claudeCode: { toolName: 'Read' } },
      },
      toolDone('c1', 'x'),
    ])
    expect((messages[1] as AssistantMessage).content[0]).toMatchObject({ name: 'Read' })
    expect((messages[2] as ToolResultMessage).toolName).toBe('Read')
  })

  it('serialises a structured result instead of dropping it', () => {
    const messages = project([user('q'), toolStart('c1', 't'), toolDone('c1', { rows: 2 })])
    expect((messages[2] as ToolResultMessage).content[0]).toEqual({
      type: 'text',
      text: '{"rows":2}',
    })
  })

  it('reads a content-block result when there is no rawOutput', () => {
    const messages = project([
      user('q'),
      toolStart('c1', 't'),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '从 content 来的' } }],
      },
    ])
    expect((messages[2] as ToolResultMessage).content[0]).toEqual({
      type: 'text',
      text: '从 content 来的',
    })
  })

  it('ignores tool updates without an id', () => {
    expect(project([{ sessionUpdate: 'tool_call' }, { sessionUpdate: 'tool_call_update' }])).toEqual([])
  })

  it('emits nothing for a call that never finished', () => {
    const messages = project([user('q'), toolStart('c1', 'read')])
    expect(roles(messages)).toEqual(['user', 'assistant'])
  })
})

describe('noise', () => {
  // 实测一帧 18KB+,而且不是对话内容。
  it('drops commands, plans, modes and usage', () => {
    const messages = project([
      user('q'),
      { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x' }] },
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'agent' },
      { sessionUpdate: 'usage_update', used: 100, size: 1000 },
      { sessionUpdate: 'something_upstream_added_later' },
      agent('答'),
    ])
    expect(roles(messages)).toEqual(['user', 'assistant'])
  })
})

describe('timestamps', () => {
  it('keeps the transcript order strictly increasing', () => {
    const messages = project([user('q'), toolStart('c1', 't'), toolDone('c1', 'r'), agent('done')])
    const stamps = messages.map((m) => (m as { timestamp: number }).timestamp)
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps)
  })
})

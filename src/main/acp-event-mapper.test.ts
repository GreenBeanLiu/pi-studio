import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import { AcpTurnProjector, type AcpSessionUpdate } from './acp-event-mapper'

function projector() {
  let clock = 1_000
  return new AcpTurnProjector('codex-acp', () => ++clock)
}

function types(events: readonly PiRuntimeEvent[]): string[] {
  return events.map((event) => event.type)
}

function textChunk(text: string): AcpSessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

function thoughtChunk(text: string): AcpSessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
}

function finalMessage(events: readonly PiRuntimeEvent[]): AssistantMessage {
  const end = events.find((event) => event.type === 'turn_end')
  if (!end || end.type !== 'turn_end') throw new Error('no turn_end')
  return end.message as AssistantMessage
}

describe('turn boundaries', () => {
  it('opens with agent_start + turn_start', () => {
    expect(types(projector().begin())).toEqual(['agent_start', 'turn_start'])
  })

  // agent_settled 才是「这一轮真的结束了」的信号 —— nextRunActive 和 AgentStatusTracker
  // 都按它收尾,少了它界面会永远停在运行中。
  it('closes a turn all the way to agent_settled', () => {
    const p = projector()
    p.begin()
    p.apply(textChunk('hi'))
    expect(types(p.finish('end_turn'))).toEqual([
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ])
  })

  it('still settles a turn that produced no text at all', () => {
    const p = projector()
    p.begin()
    const events = p.finish('end_turn')
    expect(types(events)).toEqual(['turn_end', 'agent_end', 'agent_settled'])
  })

  it('settles only once', () => {
    const p = projector()
    p.begin()
    expect(p.finish('end_turn')).not.toHaveLength(0)
    expect(p.finish('end_turn')).toEqual([])
    expect(p.fail('late')).toEqual([])
  })

  it('maps ACP stop reasons onto pi stop reasons', () => {
    const cases: Array<[Parameters<AcpTurnProjector['finish']>[0], string]> = [
      ['end_turn', 'stop'],
      ['cancelled', 'aborted'],
      ['max_tokens', 'length'],
      ['refusal', 'error'],
    ]
    for (const [acp, pi] of cases) {
      const p = projector()
      p.begin()
      expect(finalMessage(p.finish(acp)).stopReason).toBe(pi)
    }
  })

  // 一轮出错要摆到界面上。原来 pi 那边就踩过「异常没有出口,界面永远停在最后一步」。
  it('surfaces a failure and still settles', () => {
    const p = projector()
    p.begin()
    p.apply(textChunk('partial'))
    const events = p.fail('agent crashed')
    expect(types(events)).toEqual([
      'run_failed',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ])
    expect(finalMessage(events).errorMessage).toBe('agent crashed')
  })
})

describe('streaming text and thinking', () => {
  it('emits message_start once, then deltas', () => {
    const p = projector()
    p.begin()
    expect(types(p.apply(textChunk('he')))).toEqual([
      'message_start',
      'message_update',
      'message_update',
    ])
    expect(types(p.apply(textChunk('llo')))).toEqual(['message_update'])
  })

  it('accumulates deltas into the partial message', () => {
    const p = projector()
    p.begin()
    p.apply(textChunk('he'))
    p.apply(textChunk('llo'))
    const message = finalMessage(p.finish('end_turn'))
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  // 思考和正文串进同一个 contentIndex 的话,界面会把推理过程当成回答渲染出来。
  it('gives thinking and text separate content blocks', () => {
    const p = projector()
    p.begin()
    p.apply(thoughtChunk('**Summarizing**'))
    p.apply(textChunk('answer'))
    const message = finalMessage(p.finish('end_turn'))
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '**Summarizing**' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('closes the open block before opening the next one', () => {
    const p = projector()
    p.begin()
    p.apply(thoughtChunk('t'))
    const events = p.apply(textChunk('a'))
    const stream = events
      .filter((event): event is Extract<PiRuntimeEvent, { type: 'message_update' }> => event.type === 'message_update')
      .map((event) => event.assistantMessageEvent.type)
    expect(stream).toEqual(['thinking_end', 'text_start', 'text_delta'])
  })

  it('carries the delta and a rising contentIndex on stream events', () => {
    const p = projector()
    p.begin()
    p.apply(thoughtChunk('t'))
    const events = p.apply(textChunk('abc'))
    const textDelta = events.find(
      (event) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta',
    )
    expect(textDelta?.type === 'message_update' && textDelta.assistantMessageEvent).toMatchObject({
      type: 'text_delta',
      // 思考占了 0,正文另起一块
      contentIndex: 1,
      delta: 'abc',
    })
  })

  it('ignores chunks without usable text', () => {
    const p = projector()
    p.begin()
    expect(p.apply({ sessionUpdate: 'agent_message_chunk' })).toEqual([])
    expect(p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } })).toEqual([])
  })
})

describe('tool calls', () => {
  // Claude 实测:tool_call 时 rawInput 是 {} 且 title 是 "Terminal",
  // 随后的 tool_call_update 才补上命令,并且把整条命令写进 title。
  const START: AcpSessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_01',
    status: 'pending',
    title: 'Terminal',
    kind: 'execute',
    rawInput: {},
    _meta: { claudeCode: { toolName: 'Bash' } },
  }
  const ARGS: AcpSessionUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_01',
    title: 'ls -la /very/long/path',
    rawInput: { command: 'ls -la /very/long/path' },
    _meta: { claudeCode: { toolName: 'Bash' } },
  }
  const DONE: AcpSessionUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_01',
    status: 'completed',
    rawOutput: 'total 8',
    _meta: { claudeCode: { toolName: 'Bash' } },
  }

  it('prefers the stable tool name over the human title', () => {
    const p = projector()
    p.begin()
    const [start] = p.apply(START)
    expect(start).toMatchObject({ type: 'tool_execution_start', toolCallId: 'toolu_01', toolName: 'Bash' })
  })

  // Codex 实测不给 _meta.toolName,title 里塞的是整个文件路径。
  // 落到 kind 上("read")比落到 title 上稳定得多。
  it('falls back to the stable kind, not the human title', () => {
    const p = projector()
    p.begin()
    const [start] = p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      status: 'pending',
      kind: 'read',
      title: "Read file '/var/folders/q6/T/acp-e2e-ZwuJtM/hello.txt'",
      rawInput: {},
    })
    expect(start).toMatchObject({ type: 'tool_execution_start', toolName: 'read' })
  })

  it('prefers the unstable programmatic name over the kind', () => {
    const p = projector()
    p.begin()
    const [start] = p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      status: 'pending',
      name: 'read_file',
      kind: 'read',
      title: 'Read something',
    })
    expect(start).toMatchObject({ toolName: 'read_file' })
  })

  // title 会随参数变。名字在 start 时定下来,之后不再改,否则 end 配不上 start。
  it('keeps the name from the start event even when the title changes', () => {
    const p = projector()
    p.begin()
    p.apply({ ...START, _meta: undefined, kind: undefined, title: 'Terminal' })
    p.apply({ ...ARGS, _meta: undefined })
    const [end] = p.apply({ ...DONE, _meta: undefined })
    expect(end).toMatchObject({ type: 'tool_execution_end', toolName: 'Terminal' })
  })

  it('merges arguments that only arrive on a later update', () => {
    const p = projector()
    p.begin()
    p.apply(START)
    p.apply(ARGS)
    const message = finalMessage(p.finish('end_turn'))
    expect(message.content).toEqual([
      {
        type: 'toolCall',
        id: 'toolu_01',
        name: 'Bash',
        arguments: { command: 'ls -la /very/long/path' },
      },
    ])
  })

  it('emits tool_execution_end only on a terminal status', () => {
    const p = projector()
    p.begin()
    p.apply(START)
    expect(p.apply(ARGS)).toEqual([])
    expect(types(p.apply(DONE))).toEqual(['tool_execution_end'])
  })

  it('marks a failed tool call as an error', () => {
    const p = projector()
    p.begin()
    p.apply(START)
    const [end] = p.apply({ ...DONE, status: 'failed', rawOutput: 'boom' })
    expect(end).toMatchObject({ type: 'tool_execution_end', isError: true, result: 'boom' })
  })

  it('closes an open text block before a tool call', () => {
    const p = projector()
    p.begin()
    p.apply(textChunk('let me look'))
    const events = p.apply(START)
    expect(types(events)).toEqual(['message_update', 'tool_execution_start'])
  })

  it('drops updates without a toolCallId', () => {
    const p = projector()
    p.begin()
    expect(p.apply({ sessionUpdate: 'tool_call' })).toEqual([])
    expect(p.apply({ sessionUpdate: 'tool_call_update', status: 'completed' })).toEqual([])
  })
})

describe('noise that must not reach the UI', () => {
  // 实测一帧 18KB+,而且同一轮里推两次。它不是对话内容。
  it('drops available_commands_update', () => {
    const p = projector()
    p.begin()
    expect(
      p.apply({
        sessionUpdate: 'available_commands_update',
        availableCommands: Array.from({ length: 200 }, (_, i) => ({ name: `cmd${i}`, description: 'x'.repeat(200) })),
      }),
    ).toEqual([])
  })

  it('drops session/plan/mode chatter', () => {
    const p = projector()
    p.begin()
    expect(p.apply({ sessionUpdate: 'session_info_update', title: 'x' })).toEqual([])
    expect(p.apply({ sessionUpdate: 'plan', entries: [] })).toEqual([])
    expect(p.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' })).toEqual([])
    expect(p.apply({ sessionUpdate: 'something_new_upstream_added' })).toEqual([])
  })

  // ACP 只给「用了多少 / 上限多少」,没有 input/output 拆分。
  // 把 0 当成真实输入输出上报会让成本统计看起来是真的。
  it('records only the token total it actually knows', () => {
    const p = projector()
    p.begin()
    p.apply({ sessionUpdate: 'usage_update', used: 18803, size: 258400 })
    p.apply({ sessionUpdate: 'usage_update', used: 35646, size: 1000000, cost: { amount: 0.2527994, currency: 'USD' } })
    const usage = finalMessage(p.finish('end_turn')).usage
    expect(usage.totalTokens).toBe(35646)
    expect(usage.cost.total).toBeCloseTo(0.2527994)
    expect(usage.input).toBe(0)
    expect(usage.output).toBe(0)
  })
})

// 2026-08-25 从 codex-acp@1.6.2 真实抓下来的一轮(为了可读做了裁剪)。
describe('a real codex turn', () => {
  const CAPTURED: AcpSessionUpdate[] = [
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'pending', title: 'Read', kind: 'read', rawInput: {} },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: 'pi-studio ACP 接入探针的测试文件。' },
    { sessionUpdate: 'usage_update', used: 18708, size: 258400 },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Summarizing hello.txt content**' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`hello' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.txt`' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' 写着测试文件' } },
    { sessionUpdate: 'usage_update', used: 18803, size: 258400 },
    { sessionUpdate: 'session_info_update', title: '用一句话说明 hello.txt 里写了什么。' },
  ]

  it('projects into a well-formed pi turn', () => {
    const p = projector()
    const events = [...p.begin(), ...CAPTURED.flatMap((update) => p.apply(update)), ...p.finish('end_turn')]

    expect(types(events).filter((type) => type !== 'message_update')).toEqual([
      'agent_start',
      'turn_start',
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ])

    const message = finalMessage(events)
    expect(message.content).toEqual([
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} },
      { type: 'thinking', thinking: '**Summarizing hello.txt content**' },
      { type: 'text', text: '`hello.txt` 写着测试文件' },
    ])
    expect(message.stopReason).toBe('stop')
    expect(message.usage.totalTokens).toBe(18803)
  })

  // 每个 tool_execution_start 都要有配对的 end,否则 ToolCallCard 永远转圈。
  it('pairs every tool start with an end', () => {
    const p = projector()
    const events = [...p.begin(), ...CAPTURED.flatMap((update) => p.apply(update)), ...p.finish('end_turn')]
    const starts = events.filter((event) => event.type === 'tool_execution_start')
    const ends = events.filter((event) => event.type === 'tool_execution_end')
    expect(starts).toHaveLength(ends.length)
  })
})

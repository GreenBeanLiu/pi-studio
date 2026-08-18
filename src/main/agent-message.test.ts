import { describe, expect, it } from 'vitest'
import { latestAssistantFailure, latestAssistantText } from './agent-message'

describe('reading an agent step product', () => {
  it('takes the last assistant message that actually has text', () => {
    expect(
      latestAssistantText([
        { role: 'assistant', content: [{ type: 'text', text: '旧的一版' }] },
        { role: 'user', content: '再来一版' },
        { role: 'assistant', content: [{ type: 'text', text: '  新的一版  ' }] },
      ]),
    ).toBe('新的一版')
  })

  it('ignores non-text blocks so a tool-only turn counts as no output', () => {
    expect(
      latestAssistantText([
        { role: 'assistant', content: [{ type: 'tool_use' }, { type: 'thinking' }] },
      ]),
    ).toBe('')
  })
})

// 2026-08-18:表情包工作流的策划步骤连报 4 次「没有产出任何文本」,真相是网关对
// gpt-4-turbo 回 502。pi 把它记在消息的 errorMessage 上,当时没人读,于是报错把人
// 指向提示词而不是模型配置。
describe('explaining why a step produced nothing', () => {
  it('surfaces the upstream error behind an empty assistant turn', () => {
    expect(
      latestAssistantFailure([
        { role: 'user', content: '策划一张表情包' },
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'OpenAI API error (502): 502 status code (no body)',
        },
      ]),
    ).toBe('OpenAI API error (502): 502 status code (no body)')
  })

  it('reports the newest failure when the run retried', () => {
    expect(
      latestAssistantFailure([
        { role: 'assistant', content: [], stopReason: 'error', errorMessage: '第一次 502' },
        { role: 'assistant', content: [], stopReason: 'error', errorMessage: '第二次 429' },
      ]),
    ).toBe('第二次 429')
  })

  it('stays quiet when the turn simply said nothing', () => {
    expect(
      latestAssistantFailure([{ role: 'assistant', content: [], stopReason: 'end_turn' }]),
    ).toBe('')
  })
})

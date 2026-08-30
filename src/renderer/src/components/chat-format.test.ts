import { describe, expect, it } from 'vitest'
import type { AgentStatusEvent, GitChangedFile } from '../../../shared/ipc/contract'
import {
  agentIssueMessage,
  approvalStatusLabel,
  firstLine,
  formatAgentElapsed,
  formatDuration,
  gitStatusLabel,
  runStatusLabel,
  summarizeToolArgs,
  textOf,
  uniqueList,
} from './chat-format'

describe('textOf', () => {
  it('字符串原样返回', () => {
    expect(textOf('hi')).toBe('hi')
  })

  it('分段数组只拼 text 段', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('text 缺失的段当空串', () => {
    expect(textOf([{ type: 'text' }, { type: 'text', text: 'x' }])).toBe('x')
  })
})

describe('summarizeToolArgs', () => {
  it('挑最能说明意图的字段,按 command > path > file_path > pattern > query 排', () => {
    expect(summarizeToolArgs({ command: 'ls', path: '/x' })).toBe('ls')
    expect(summarizeToolArgs({ path: '/x', query: 'q' })).toBe('/x')
    expect(summarizeToolArgs({ query: 'q' })).toBe('q')
  })

  it('没有可挑字段时退回 JSON', () => {
    expect(summarizeToolArgs({ depth: 2 })).toBe('{"depth":2}')
  })

  it('循环引用不能把卡片标题炸掉', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => summarizeToolArgs(cyclic)).not.toThrow()
  })

  it('null / undefined 是空串,不是 "null"', () => {
    expect(summarizeToolArgs(null)).toBe('')
    expect(summarizeToolArgs(undefined)).toBe('')
  })
})

describe('firstLine', () => {
  it('折掉换行和连续空白', () => {
    expect(firstLine('a\n\n  b\tc')).toBe('a b c')
  })

  it('超长截断并加省略号', () => {
    expect(firstLine('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}...`)
  })

  it('刚好等于上限时不截断', () => {
    expect(firstLine('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })
})

describe('uniqueList', () => {
  it('去重、去空白项、按上限截断', () => {
    expect(uniqueList([' a ', 'a', '', '  ', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})

describe('时长格式化', () => {
  it('不足一分钟只显示秒', () => {
    expect(formatDuration('2026-08-30T00:00:00Z', '2026-08-30T00:00:09Z')).toBe('9s')
  })

  it('超过一分钟显示 Xm Ys', () => {
    expect(formatDuration('2026-08-30T00:00:00Z', '2026-08-30T00:01:05Z')).toBe('1m 5s')
  })

  it('结束时间早于开始时间时不出负数', () => {
    expect(formatDuration('2026-08-30T00:01:00Z', '2026-08-30T00:00:00Z')).toBe('0s')
    expect(formatAgentElapsed(1000, 0)).toBe('0s')
  })
})

describe('状态文案', () => {
  it('运行状态', () => {
    expect(runStatusLabel('running')).toBe('运行中')
    expect(runStatusLabel('aborted')).toBe('已停止')
  })

  it('审批状态', () => {
    expect(approvalStatusLabel('allowed')).toBe('已允许')
    expect(approvalStatusLabel('denied')).toBe('已拒绝')
  })
})

describe('gitStatusLabel', () => {
  const file = (statusCode: string): GitChangedFile => ({ statusCode, path: 'a.ts' }) as GitChangedFile

  it.each([
    ['??', 'NEW'],
    [' D', 'DEL'],
    ['R ', 'REN'],
    ['A ', 'ADD'],
    ['M ', 'MOD'],
  ])('%s → %s', (code, label) => {
    expect(gitStatusLabel(file(code))).toBe(label)
  })

  it('认不出的状态码兜底成 CHG', () => {
    expect(gitStatusLabel(file('  '))).toBe('CHG')
    expect(gitStatusLabel(file('XY'))).toBe('XY')
  })
})

describe('agentIssueMessage', () => {
  it('带退出码的退出', () => {
    const issue = { status: 'exited', code: 1, signal: null } as unknown as Exclude<AgentStatusEvent, { status: 'started' }>
    expect(agentIssueMessage(issue)).toContain('exit code 1')
  })

  it('被信号杀掉时报信号名', () => {
    const issue = { status: 'exited', code: null, signal: 'SIGKILL' } as unknown as Exclude<AgentStatusEvent, { status: 'started' }>
    expect(agentIssueMessage(issue)).toContain('signal SIGKILL')
  })
})

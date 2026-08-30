import { describe, expect, it } from 'vitest'
import {
  MAX_RUN_RECORDS,
  appendTimelineEvent,
  completeRun,
  endTool,
  failRun,
  resolveRunStatus,
  startRun,
  startTool,
  updateToolResult,
} from './chat-run-records'
import type { RunRecord, RunStatus, RunTimelineItem, RunToolRecord } from './chat-types'

const T = '2026-08-30T00:00:00.000Z'

function tool(over: Partial<RunToolRecord> = {}): RunToolRecord {
  return { id: 't1', toolName: 'bash', status: 'done', startedAt: T, ...over }
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return { id: 'r1', startedAt: T, status: 'running', thinking: 'off', tools: [], timeline: [], ...over }
}

function event(id = 'e1'): RunTimelineItem {
  return { id, type: 'event', label: '事件', timestamp: T }
}

describe('resolveRunStatus', () => {
  it('用户主动停的算 aborted,即使有工具报错', () => {
    expect(resolveRunStatus(run({ status: 'aborted', tools: [tool({ status: 'error' })] }))).toBe('aborted')
  })

  it('任何一个工具报错整轮算 error', () => {
    expect(
      resolveRunStatus(run({ tools: [tool(), tool({ id: 't2', status: 'error' })] })),
    ).toBe('error')
  })

  it('工具全好才算 done', () => {
    expect(resolveRunStatus(run({ tools: [tool(), tool({ id: 't2' })] }))).toBe('done')
    expect(resolveRunStatus(run({ tools: [] }))).toBe('done')
  })
})

describe('appendTimelineEvent', () => {
  it('没有目标 run 时原样返回', () => {
    const runs = [run()]
    expect(appendTimelineEvent(runs, null, event())).toBe(runs)
  })

  it('目标 run 不存在时不新建', () => {
    expect(appendTimelineEvent([run()], 'nope', event())[0].timeline).toHaveLength(0)
  })

  it('只动目标那一条,其余保持同一引用', () => {
    const other = run({ id: 'r2' })
    const next = appendTimelineEvent([run(), other], 'r1', event())
    expect(next[0].timeline).toHaveLength(1)
    expect(next[1]).toBe(other)
  })
})

describe('startRun', () => {
  it('新的一轮排在最前面', () => {
    expect(startRun([run({ id: 'old' })], run({ id: 'new' })).map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('只留最近 MAX_RUN_RECORDS 条', () => {
    const many = Array.from({ length: MAX_RUN_RECORDS }, (_, i) => run({ id: `r${i}` }))
    const next = startRun(many, run({ id: 'newest' }))
    expect(next).toHaveLength(MAX_RUN_RECORDS)
    expect(next[0].id).toBe('newest')
    expect(next.at(-1)!.id).toBe(`r${MAX_RUN_RECORDS - 2}`)
  })
})

describe('completeRun', () => {
  it('结算状态、记结束时间、补收尾时间线,三处状态一致', () => {
    const next = completeRun([run({ tools: [tool({ status: 'error' })] })], 'r1', T)[0]
    expect(next.status).toBe<RunStatus>('error')
    expect(next.endedAt).toBe(T)
    expect(next.timeline.at(-1)).toMatchObject({ id: 'r1:end', label: 'Agent 结束', status: 'error' })
  })

  it('被中止的一轮收尾后仍是 aborted', () => {
    const next = completeRun([run({ status: 'aborted' })], 'r1', T)[0]
    expect(next.status).toBe('aborted')
    expect(next.timeline.at(-1)!.status).toBe('aborted')
  })
})

describe('failRun', () => {
  it('标成 error 并记结束时间', () => {
    expect(failRun([run()], 'r1', T)[0]).toMatchObject({ status: 'error', endedAt: T })
  })

  it('不覆盖用户主动停的那一轮', () => {
    const aborted = run({ status: 'aborted' })
    expect(failRun([aborted], 'r1', T)[0]).toBe(aborted)
  })

  it('已有 endedAt 时保留原值', () => {
    const earlier = '2026-08-29T00:00:00.000Z'
    expect(failRun([run({ endedAt: earlier })], 'r1', T)[0].endedAt).toBe(earlier)
  })
})

describe('工具记录', () => {
  it('同一个 callId 重复上报 start 时替换而不是并存', () => {
    let runs = startTool([run()], 'r1', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }, T)
    runs = startTool(runs, 'r1', { toolCallId: 'c1', toolName: 'bash', args: { command: 'pwd' } }, T)
    expect(runs[0].tools).toHaveLength(1)
    expect(runs[0].tools[0].args).toEqual({ command: 'pwd' })
  })

  it('update 只改 result', () => {
    const runs = updateToolResult(
      startTool([run()], 'r1', { toolCallId: 'c1', toolName: 'bash' }, T),
      'r1',
      'c1',
      'partial',
    )
    expect(runs[0].tools[0]).toMatchObject({ status: 'running', result: 'partial' })
  })

  it('end 落状态和结束时间,isError 决定 error/done', () => {
    const base = startTool([run()], 'r1', { toolCallId: 'c1', toolName: 'bash' }, T)
    expect(endTool(base, 'r1', { toolCallId: 'c1', toolName: 'bash', isError: true }, T)[0].tools[0]).toMatchObject({
      status: 'error',
      endedAt: T,
    })
    expect(endTool(base, 'r1', { toolCallId: 'c1', toolName: 'bash', result: 'ok' }, T)[0].tools[0]).toMatchObject({
      status: 'done',
      result: 'ok',
    })
  })

  it('认不出的 callId 不会凭空造一条工具', () => {
    const base = startTool([run()], 'r1', { toolCallId: 'c1', toolName: 'bash' }, T)
    expect(endTool(base, 'r1', { toolCallId: 'other', toolName: 'read' }, T)[0].tools).toHaveLength(1)
  })

  it('工具报错之后整轮收尾就是 error —— 串起来的那条路径', () => {
    let runs = startTool([run()], 'r1', { toolCallId: 'c1', toolName: 'bash' }, T)
    runs = endTool(runs, 'r1', { toolCallId: 'c1', toolName: 'bash', isError: true }, T)
    expect(completeRun(runs, 'r1', T)[0].status).toBe('error')
  })
})

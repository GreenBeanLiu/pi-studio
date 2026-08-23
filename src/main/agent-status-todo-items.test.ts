import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentStatusTracker, formatAgentStatus } from './agent-status'

const chatPane = readFileSync(
  new URL('../renderer/src/components/ChatPane.tsx', import.meta.url),
  'utf8',
)

const tracker = (): AgentStatusTracker =>
  new AgentStatusTracker(join(mkdtempSync(join(tmpdir(), 'pi-status-')), 'status.json'), '/repo')

const feed = (t: AgentStatusTracker, items: Array<[string, string]>): void => {
  t.observe({
    type: 'tool_execution_start',
    toolName: 'update_agent_todo',
    args: { items: items.map(([status, content], i) => ({ id: `t${i}`, content, status })) },
  })
}

// 2026-08-24: 状态条只显示 "TODO 0/0  工具 0" —— 看不出在做什么、卡在哪一条,
// 也看不出调了哪些工具。计数被算出来之后,清单和工具名就都被丢掉了。
describe('agent status keeps the detail behind the counters', () => {
  it('remembers each todo item, not just how many', () => {
    const t = tracker()
    feed(t, [
      ['completed', '读代码'],
      ['in_progress', '改 ChatPane'],
      ['pending', '跑测试'],
    ])
    const todo = t.snapshot().todo

    expect(todo).toMatchObject({ completed: 1, inProgress: 1, pending: 1 })
    expect(todo.items.map((item) => [item.status, item.content])).toEqual([
      ['completed', '读代码'],
      ['in_progress', '改 ChatPane'],
      ['pending', '跑测试'],
    ])
  })

  it('replaces the checklist wholesale, the way the tool does', () => {
    const t = tracker()
    feed(t, [['pending', '旧任务']])
    feed(t, [['completed', '新任务']])
    const todo = t.snapshot().todo

    expect(todo.items).toHaveLength(1)
    expect(todo.items[0].content).toBe('新任务')
    expect(todo.pending).toBe(0)
  })

  it('hands the model the checklist too, not only the tally', () => {
    // 模型自己也该知道卡在哪一条
    const t = tracker()
    feed(t, [['in_progress', '改 ChatPane']])
    expect(formatAgentStatus(t.snapshot())).toContain('[~] 改 ChatPane')
  })

  it('drops malformed items instead of counting them', () => {
    const t = tracker()
    t.observe({
      type: 'tool_execution_start',
      toolName: 'update_agent_todo',
      args: { items: [{ id: 'a', content: 'ok', status: 'pending' }, { id: 'b', status: 'bogus' }] },
    })
    const todo = t.snapshot().todo
    expect(todo.items).toHaveLength(1)
    expect(todo.pending).toBe(1)
  })

  it('snapshot is a copy — callers must not mutate tracker state', () => {
    const t = tracker()
    feed(t, [['pending', '任务']])
    t.snapshot().todo.items[0].content = 'tampered'
    expect(t.snapshot().todo.items[0].content).toBe('任务')
  })

  it('makes both counters expandable in the UI', () => {
    // 工具名一直都在数据里(Record<string, number>),以前只是被加总掉了
    expect(chatPane).toContain('agentStatus.todo.items.map((item)')
    expect(chatPane).toContain('Object.entries(agentStatus.tools).sort')
    expect(chatPane).toContain('agentStatusClickable')
  })
})

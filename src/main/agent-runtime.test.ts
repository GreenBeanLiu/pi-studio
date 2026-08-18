import { describe, expect, it } from 'vitest'
import { AgentRuntimeTracker, type AgentRuntimeSnapshot } from './agent-runtime'

function tracked(): { t: AgentRuntimeTracker; seen: AgentRuntimeSnapshot[] } {
  const seen: AgentRuntimeSnapshot[] = []
  const t = new AgentRuntimeTracker((s) => seen.push(s))
  return { t, seen }
}

const started = {
  status: 'started',
  cwd: 'D:/ws',
  restoredSession: false,
  sessionId: 'session-a',
  sessionFile: 'D:/sessions/a.jsonl',
  sandbox: 'wsl',
} as const

describe('agent runtime state machine', () => {
  it('walks closed -> starting -> idle -> running -> idle', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    expect(t.snapshot().phase).toBe('starting')
    t.status(started)
    expect(t.snapshot()).toMatchObject({
      phase: 'idle',
      sandbox: 'wsl',
      sessionFile: 'D:/sessions/a.jsonl',
    })
    t.agentEvent('session-a', { type: 'agent_start' })
    expect(t.snapshot().phase).toBe('running')
    expect(t.snapshot().activeRun).not.toBeNull()
    t.agentEvent('session-a', { type: 'agent_settled' })
    expect(t.snapshot()).toMatchObject({ phase: 'idle', activeRun: null })
  })

  it('bumps revision on every transition', () => {
    const { t, seen } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.agentEvent('session-a', { type: 'agent_start' })
    expect(seen.map((s) => s.revision)).toEqual([1, 2, 3])
  })

  it('enters awaiting_approval only for blocking ui requests while running', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.agentEvent('session-a', { type: 'agent_start' })
    // non-blocking request must not flip the phase
    t.agentEvent('session-a', { type: 'extension_ui_request', method: 'setStatus' })
    expect(t.snapshot().phase).toBe('running')
    t.agentEvent('session-a', { type: 'extension_ui_request', method: 'confirm' })
    expect(t.snapshot().phase).toBe('awaiting_approval')
    t.uiResponded('session-a')
    expect(t.snapshot().phase).toBe('running')
    // settled while awaiting approval still lands on idle
    t.agentEvent('session-a', { type: 'extension_ui_request', method: 'confirm' })
    t.agentEvent('session-a', { type: 'agent_settled' })
    expect(t.snapshot().phase).toBe('idle')
  })

  it('records unexpected exits as error, expected ones as closed', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.status({
      status: 'exited',
      cwd: 'D:/ws',
      code: 1,
      signal: null,
      expected: false,
      message: 'agent crashed',
    })
    expect(t.snapshot()).toMatchObject({ phase: 'error', error: { message: 'agent crashed' } })
    t.starting('D:/ws')
    t.status(started)
    t.status({
      status: 'exited',
      cwd: 'D:/ws',
      code: 0,
      signal: null,
      expected: true,
      message: '',
    })
    expect(t.snapshot().phase).toBe('closed')
  })

  // 切工作区时旧子进程的收尾事件曾打翻新工作区的状态 — App.tsx 里
  // 有同样的 cwd 守卫,状态机必须保持这条语义
  it('ignores status events from a different workspace', () => {
    const { t } = tracked()
    t.starting('D:/new')
    t.status({ ...started, cwd: 'D:/old', status: 'exited', expected: false, message: 'old gone' } as never)
    expect(t.snapshot().phase).toBe('starting')
  })

  it('reports start failure and recovers on the next start', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.startFailed('no API key')
    expect(t.snapshot()).toMatchObject({ phase: 'error', error: { message: 'no API key' } })
    t.starting('D:/ws')
    expect(t.snapshot()).toMatchObject({ phase: 'starting', error: null })
  })

  it('snapshot copies do not leak internal state', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.agentEvent('session-a', { type: 'agent_start' })
    const a = t.snapshot()
    a.phase = 'closed'
    if (a.activeRun) a.activeRun.startedAt = 0
    expect(t.snapshot().phase).toBe('running')
    expect(t.snapshot().activeRun?.startedAt).not.toBe(0)
  })

  it('projects the selected session runtime and ignores events from another session', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.agentEvent('session-a', { type: 'agent_start' })

    t.activate('session-b', 'D:/sessions/b.jsonl', 'idle', null)
    t.agentEvent('session-a', { type: 'agent_settled' })

    expect(t.snapshot()).toMatchObject({
      sessionId: 'session-b',
      sessionFile: 'D:/sessions/b.jsonl',
      phase: 'idle',
      activeRun: null,
    })

    t.activate('session-a', 'D:/sessions/a.jsonl', 'running', 123)
    expect(t.snapshot()).toMatchObject({
      sessionId: 'session-a',
      phase: 'running',
      activeRun: { startedAt: 123 },
    })
  })

  it('does not overwrite a restored live approval when startup status arrives', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.activate('session-a', 'D:/sessions/a.jsonl', 'awaiting_approval', 123)

    t.status(started)

    expect(t.snapshot()).toMatchObject({
      sessionId: 'session-a',
      phase: 'awaiting_approval',
      activeRun: { startedAt: 123 },
    })
  })

  it('stays awaiting approval until every blocking UI request is answered', () => {
    const { t } = tracked()
    t.starting('D:/ws')
    t.status(started)
    t.agentEvent('session-a', { type: 'agent_start' })
    t.agentEvent('session-a', { type: 'extension_ui_request', method: 'editor' })

    t.uiResponded('session-a', 1)
    expect(t.snapshot().phase).toBe('awaiting_approval')
    t.uiResponded('session-a', 0)
    expect(t.snapshot().phase).toBe('running')
  })
})

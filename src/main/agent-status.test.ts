import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentStatusTracker } from './agent-status'

describe('agent status tracker', () => {
  it('projects runtime events into a status file', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.prompt('fix the failing test')
    tracker.observe({ type: 'agent_start' })
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: false })
    tracker.observe({
      type: 'tool_execution_start',
      toolName: 'update_agent_todo',
      args: {
        items: [
          { id: '1', content: 'inspect', status: 'completed' },
          { id: '2', content: 'implement', status: 'in_progress' },
          { id: '3', content: 'verify', status: 'pending' },
        ],
      },
    })
    tracker.observe({ type: 'extension_ui_request', method: 'confirm' })
    tracker.approvalResolved()
    const snapshot = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
    expect(snapshot).toMatchObject({
      cwd: 'D:/workspace',
      phase: 'running',
      prompt: 'fix the failing test',
      tools: { read: 1, update_agent_todo: 1 },
      todo: { pending: 1, inProgress: 1, completed: 1 },
      activeApprovals: 0,
    })
    tracker.dispose()
  })

  it('waits for agent_start and rolls back a rejected prompt safely', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-prompt-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    const first = tracker.prompt('first task')
    expect(tracker.snapshot()).toMatchObject({ prompt: 'first task', phase: 'idle', startedAt: null })
    expect(tracker.promptRejected(first)).toBe(true)
    expect(tracker.snapshot()).toMatchObject({ prompt: null, phase: 'idle', startedAt: null })

    const stale = tracker.prompt('older task')
    tracker.prompt('newer task')
    expect(tracker.promptRejected(stale)).toBe(false)
    expect(tracker.snapshot().prompt).toBe('newer task')

    const accepted = tracker.prompt('accepted task')
    tracker.observe({ type: 'agent_start' })
    expect(tracker.promptRejected(accepted)).toBe(false)
    expect(tracker.snapshot()).toMatchObject({ prompt: 'accepted task', phase: 'running' })
    tracker.dispose()
  })

  it('resets run-scoped counters when a new run starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-new-run-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.prompt('first task')
    tracker.observe({ type: 'agent_start' })
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: true, result: { error: 'failed' } })
    tracker.observe({ type: 'extension_ui_request', method: 'confirm' })
    tracker.observe({
      type: 'tool_execution_start',
      toolName: 'update_agent_todo',
      args: { items: [{ id: '1', content: 'inspect', status: 'completed' }] },
    })

    tracker.observe({ type: 'agent_settled' })
    tracker.prompt('second task')
    tracker.observe({ type: 'agent_start' })

    expect(tracker.snapshot()).toMatchObject({
      prompt: 'second task',
      phase: 'running',
      tools: {},
      todo: { pending: 0, inProgress: 0, completed: 0 },
      failures: 0,
      repeatedFailures: 0,
      activeApprovals: 0,
      loopDetected: null,
    })
    tracker.dispose()
  })

  it('does not write the status file for unrelated streaming events', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-streaming-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    const write = vi.spyOn(tracker, 'write')
    tracker.observe({ type: 'message_update' })
    tracker.observe({ type: 'message_update' })
    expect(write).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('returns a detached snapshot for IPC consumers', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-snapshot-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.observe({ type: 'tool_execution_start', toolName: 'read' })
    const snapshot = tracker.snapshot()
    snapshot.tools.read = 99
    snapshot.todo.completed = 99
    expect(tracker.snapshot()).toMatchObject({ tools: { read: 1 }, todo: { completed: 0 } })
    tracker.dispose()
  })

  it('counts only consecutive identical failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-failures-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.observe({ type: 'agent_start' })
    for (let i = 0; i < 2; i += 1) {
      tracker.observe({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { error: 'failed' } })
    }
    expect(tracker.snapshot()).toMatchObject({ failures: 2, repeatedFailures: 1 })
    tracker.observe({ type: 'tool_execution_end', toolName: 'read', isError: false, result: { content: 'ok' } })
    tracker.observe({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { error: 'failed' } })
    expect(tracker.snapshot()).toMatchObject({ failures: 3, repeatedFailures: 1 })
    tracker.dispose()
  })
})

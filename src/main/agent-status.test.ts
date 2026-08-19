import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
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

  it('counts consecutive identical failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-status-failures-'))
    const tracker = new AgentStatusTracker(join(root, 'status.json'), 'D:/workspace')
    tracker.observe({ type: 'agent_start' })
    for (let i = 0; i < 2; i += 1) {
      tracker.observe({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { error: 'failed' } })
    }
    const snapshot = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
    expect(snapshot).toMatchObject({ failures: 2, repeatedFailures: 1 })
    tracker.dispose()
  })
})

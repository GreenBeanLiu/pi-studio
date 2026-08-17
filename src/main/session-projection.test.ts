import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { SessionProjectionTracker } from './session-projection'

describe('SessionProjectionTracker', () => {
  it('publishes durable messages only for the current session load', () => {
    const tracker = new SessionProjectionTracker()
    const oldLoad = tracker.beginLoad('D:\\repo', 'D:\\sessions\\old.jsonl')
    const currentLoad = tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl')

    tracker.commit(oldLoad, [
      { role: 'user', content: [{ type: 'text', text: 'stale' }], timestamp: 1 },
    ])
    const snapshot = tracker.commit(currentLoad, [
      { role: 'user', content: [{ type: 'text', text: 'current' }], timestamp: 2 },
    ])

    expect(snapshot).toMatchObject({
      revision: 3,
      workspacePath: 'D:\\repo',
      sessionFile: 'D:\\sessions\\current.jsonl',
      source: 'durable-session',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'current' }], timestamp: 2 },
      ],
    })
  })

  it('clears the projection when no workspace is active', () => {
    const tracker = new SessionProjectionTracker()
    const load = tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl')
    tracker.commit(load, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 },
    ])

    const beforeClear = tracker.snapshot().asOfSeq
    expect(tracker.clear()).toEqual({
      revision: 3,
      asOfSeq: 3,
      workspacePath: null,
      sessionFile: null,
      sessionId: null,
      source: 'durable-session',
      messages: [],
      tools: {},
      approvals: [],
      updatedAt: null,
    })
    expect(tracker.changes('D:\\sessions\\current.jsonl', beforeClear).events).toMatchObject([
      { type: 'session.cleared' },
    ])
  })

  it('normalizes live events into a monotonic per-session change feed', () => {
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')

    const first = tracker.ingest('session-1', {
      type: 'agent_start',
    })
    const second = tracker.ingest('session-1', {
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 2 },
    })

    expect(second.event.seq).toBe(first.event.seq + 1)
    expect(second.event).toMatchObject({
      sessionId: 'session-1',
      type: 'message.started',
      data: { message: { role: 'assistant' } },
    })
    expect(tracker.changes('session-1', first.event.seq)).toEqual({
      sessionId: 'session-1',
      afterSeq: first.event.seq,
      asOfSeq: second.event.seq,
      resetRequired: false,
      events: [second.event],
    })
    expect(tracker.changes('session-1', second.event.seq + 100).resetRequired).toBe(true)
    expect(tracker.changes('another-session', second.event.seq).resetRequired).toBe(true)
  })

  it('requires a reset when an oversized event is discarded from the retained feed', () => {
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')
    const before = tracker.snapshot().asOfSeq

    tracker.ingest('session-1', {
      type: 'message_update',
      message: { role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
    })

    expect(tracker.changes('session-1', before)).toMatchObject({
      resetRequired: true,
      events: [],
    })
  })

  it('projects tool execution and approval decisions from live events', () => {
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')
    tracker.ingest('session-1', { type: 'agent_start' })
    tracker.ingest('session-1', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'pnpm test' },
    })
    tracker.ingest('session-1', {
      type: 'extension_ui_request',
      id: 'approval-1',
      method: 'confirm',
      title: 'Run command?',
      message: '命令：\n\npnpm test\n\n原因：verify changes',
    })

    expect(tracker.snapshot()).toMatchObject({
      tools: {
        'call-1': {
          callId: 'call-1',
          sessionId: 'session-1',
          toolName: 'bash',
          args: { command: 'pnpm test' },
          status: 'running',
        },
      },
      approvals: [
        {
          id: 'approval-1',
          sessionId: 'session-1',
          callId: 'call-1',
          tool: 'bash',
          action: 'execute',
          policy: { decision: 'ask', reason: 'verify changes' },
          title: 'Run command?',
          command: 'pnpm test',
          reason: 'verify changes',
          outcome: 'pending',
        },
      ],
    })

    tracker.resolveApproval('session-1', 'approval-1', {
      type: 'extension_ui_response',
      id: 'approval-1',
      confirmed: true,
    })
    tracker.ingest('session-1', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: 'passed' },
      isError: false,
    })

    expect(tracker.snapshot()).toMatchObject({
      tools: {
        'call-1': { status: 'done', result: { content: 'passed' } },
      },
      approvals: [{ id: 'approval-1', outcome: 'allowed-once' }],
    })
    const liveToolEvents = tracker
      .changes('session-1', 0)
      .events.filter((event) => event.type === 'tool.started' || event.type === 'tool.finished')
    expect(liveToolEvents).toMatchObject([
      { type: 'tool.started', data: { tool: { callId: 'call-1', status: 'running' } } },
      { type: 'tool.finished', data: { tool: { callId: 'call-1', status: 'done' } } },
    ])
  })

  it('ignores live events from a session that is no longer selected', () => {
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\old.jsonl', 'session-old')
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\new.jsonl', 'session-new')

    const result = tracker.ingest('session-old', { type: 'agent_start' })

    expect(result.accepted).toBe(false)
    expect(tracker.snapshot().sessionId).toBe('session-new')
  })

  it('rebuilds completed tool executions from durable session messages', () => {
    const tracker = new SessionProjectionTracker()
    const load = tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')

    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'README.md' },
          },
        ],
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'hello' }],
        details: { lineCount: 1 },
        isError: false,
        timestamp: 2,
      },
    ] as unknown as AgentMessage[]
    const beforeCommit = tracker.snapshot().asOfSeq
    const snapshot = tracker.commit(load, messages)

    expect(snapshot.tools['call-1']).toMatchObject({
      callId: 'call-1',
      sessionId: 'session-1',
      toolName: 'read',
      args: { path: 'README.md' },
      status: 'done',
      result: [{ type: 'text', text: 'hello' }],
      details: { lineCount: 1 },
    })
    const durableEvents = tracker.changes('session-1', beforeCommit).events
    expect(durableEvents.map((event) => event.type)).toEqual([
      'conversation.replaced',
      'tool.started',
      'tool.finished',
    ])
    expect(durableEvents[1]).toMatchObject({
      type: 'tool.started',
      data: { tool: { callId: 'call-1', status: 'running' } },
    })
    expect(durableEvents[2]).toMatchObject({
      type: 'tool.finished',
      data: { tool: { callId: 'call-1', status: 'done' } },
    })

    const firstAsOfSeq = snapshot.asOfSeq
    const repeatedLoad = tracker.beginLoad(
      'D:\\repo',
      'D:\\sessions\\current.jsonl',
      'session-1',
    )
    expect(tracker.commit(repeatedLoad, messages).asOfSeq).toBe(firstAsOfSeq)
  })

  it('restores durable approval audits only into their matching session load', () => {
    const tracker = new SessionProjectionTracker()
    const stale = tracker.beginLoad('D:\\repo', 'D:\\sessions\\old.jsonl', 'session-old')
    const current = tracker.beginLoad('D:\\repo', 'D:\\sessions\\new.jsonl', 'session-new')

    tracker.restoreApprovals(stale, [
      {
        id: 'stale',
        sessionId: 'session-old',
        runId: null,
        callId: null,
        correlation: { kind: 'extension-request', id: 'stale' },
        tool: 'extension',
        action: 'external-side-effect',
        policy: { decision: 'ask' },
        title: 'Old',
        message: 'Old approval',
        createdAt: '2026-08-17T00:00:00.000Z',
        outcome: 'pending',
      },
    ])
    tracker.restoreApprovals(current, [
      {
        id: 'current',
        sessionId: 'session-new',
        runId: null,
        callId: null,
        correlation: { kind: 'extension-request', id: 'current' },
        tool: 'bash',
        action: 'execute',
        policy: { decision: 'ask' },
        title: 'Current',
        message: 'Current approval',
        createdAt: '2026-08-17T00:00:01.000Z',
        outcome: 'rejected',
      },
      {
        id: 'interrupted',
        sessionId: 'session-new',
        runId: 'run-old',
        callId: null,
        correlation: { kind: 'extension-request', id: 'interrupted' },
        tool: 'bash',
        action: 'execute',
        policy: { decision: 'ask' },
        title: 'Interrupted',
        message: 'Interrupted approval',
        createdAt: '2026-08-17T00:00:02.000Z',
        outcome: 'pending',
      },
    ])

    expect(tracker.snapshot().approvals).toMatchObject([
      { id: 'current', outcome: 'rejected' },
      {
        id: 'interrupted',
        outcome: 'unavailable',
        error: '应用已重启，原审批请求不可再响应',
      },
    ])
  })

  it('keeps a pending audit answerable when the live process still owns it', () => {
    const tracker = new SessionProjectionTracker()
    const load = tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')
    tracker.restoreApprovals(
      load,
      [
        {
          id: 'live-approval',
          sessionId: 'session-1',
          runId: 'run-live',
          callId: 'call-live',
          correlation: { kind: 'tool-call', id: 'call-live' },
          tool: 'bash',
          action: 'execute',
          policy: { decision: 'ask' },
          title: 'Run?',
          message: 'Command: pnpm test',
          createdAt: '2026-08-17T00:00:00.000Z',
          outcome: 'pending',
        },
      ],
      new Set(['live-approval']),
    )

    expect(tracker.snapshot().approvals).toMatchObject([
      { id: 'live-approval', callId: 'call-live', outcome: 'pending' },
    ])
  })

  it('closes pending approvals when their run is cancelled', () => {
    const tracker = new SessionProjectionTracker()
    tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')
    tracker.ingest('session-1', { type: 'agent_start' })
    tracker.ingest('session-1', {
      type: 'extension_ui_request',
      id: 'approval-1',
      method: 'confirm',
      title: 'Run command?',
      message: 'Command: pnpm test',
    })

    const changed = tracker.cancelPendingApprovals('session-1', 'User stopped the run')

    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      id: 'approval-1',
      outcome: 'cancelled',
      error: 'User stopped the run',
    })
  })

  it('does not let an in-flight cold load overwrite newer live tool state', () => {
    const tracker = new SessionProjectionTracker()
    const load = tracker.beginLoad('D:\\repo', 'D:\\sessions\\current.jsonl', 'session-1')
    tracker.ingest('session-1', {
      type: 'tool_execution_start',
      toolCallId: 'call-live',
      toolName: 'write',
      args: { path: 'new.txt' },
    })

    const snapshot = tracker.commit(load, [])

    expect(snapshot.tools['call-live']).toMatchObject({ status: 'running', toolName: 'write' })
  })
})

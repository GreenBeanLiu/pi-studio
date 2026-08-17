import { describe, expect, it } from 'vitest'
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

    expect(tracker.clear()).toEqual({
      revision: 3,
      workspacePath: null,
      sessionFile: null,
      source: 'durable-session',
      messages: [],
      updatedAt: null,
    })
  })
})

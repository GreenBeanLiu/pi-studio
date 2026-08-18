import { describe, expect, it, vi } from 'vitest'
import { AgentJobRegistry, isTerminalJobState } from './agent-job-registry'

const clock = (start = 1_000) => {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('AgentJobRegistry', () => {
  it('reports done only after the resources were actually released', async () => {
    const released: string[] = []
    const registry = new AgentJobRegistry(50)
    const job = registry.register({
      kind: 'chat',
      owner: { sessionFile: 'C:\\sessions\\a.jsonl' },
      resources: {
        dispose: async () => {
          released.push('dispose')
        },
        forceDispose: async () => {
          released.push('force')
        },
        pid: 4321,
      },
    })

    expect(job.currentState()).toBe('starting')
    const snapshot = await job.finish('workspace closed')

    expect(released).toEqual(['dispose'])
    expect(snapshot).toMatchObject({
      state: 'done',
      forced: false,
      cleanupError: null,
      pid: 4321,
      finishReason: 'workspace closed',
      owner: { sessionFile: 'C:\\sessions\\a.jsonl', sessionId: null },
    })
    expect(registry.live()).toEqual([])
  })

  it('force kills a process whose graceful stop never returns, and says so', async () => {
    const registry = new AgentJobRegistry(20)
    const forced: string[] = []
    const job = registry.register({
      kind: 'chat',
      resources: {
        dispose: () => new Promise<void>(() => {}),
        forceDispose: async () => {
          forced.push('force')
        },
      },
    })

    const snapshot = await job.finish('evicted')

    expect(forced).toEqual(['force'])
    expect(snapshot).toMatchObject({ state: 'done', forced: true, cleanupError: null })
    expect(registry.live()).toEqual([])
  })

  it('keeps an unconfirmed cleanup visible as an orphan with its evidence', async () => {
    const registry = new AgentJobRegistry(20)
    const job = registry.register({
      kind: 'routine',
      resources: {
        dispose: async () => {
          throw new Error('stop rejected')
        },
        forceDispose: async () => {
          throw new Error('kill denied')
        },
      },
    })

    const snapshot = await job.finish('routine finished')

    expect(snapshot.state).toBe('orphaned')
    expect(snapshot.cleanupError).toBe('stop rejected; force dispose failed: kill denied')
    // An orphan may still hold its session file, so it must not look reclaimed.
    expect(registry.live().map((item) => item.id)).toEqual([job.id])
    expect(registry.orphaned()).toHaveLength(1)
  })

  it('reaps a job exactly once no matter how many owners ask', async () => {
    const registry = new AgentJobRegistry(50)
    const dispose = vi.fn(async () => {})
    const job = registry.register({
      kind: 'chat',
      resources: { dispose, forceDispose: async () => {} },
    })

    const [first, second] = await Promise.all([job.finish('evicted'), job.finish('workspace closed')])

    expect(dispose).toHaveBeenCalledOnce()
    expect(first.finishReason).toBe('evicted')
    expect(second).toEqual(first)
  })

  it('settles a logical job that owns no process', async () => {
    const registry = new AgentJobRegistry(50)
    const chat = registry.register({ kind: 'chat', resources: { dispose: async () => {}, forceDispose: async () => {} } })
    const subagent = registry.register({ kind: 'subagent', parentId: chat.id })

    const snapshot = await subagent.finish('subagent returned')

    expect(snapshot).toMatchObject({ state: 'done', pid: null, parentId: chat.id })
    expect(registry.children(chat.id).map((job) => job.id)).toEqual([subagent.id])
  })

  it('tracks run liveness through settled and keeps eviction data on the job', () => {
    const time = clock()
    const registry = new AgentJobRegistry(50, time.now)
    const job = registry.register({ kind: 'chat' })

    job.ready()
    expect(job.currentState()).toBe('idle')
    time.advance(10)
    job.observeRun(true)
    expect(job.currentState()).toBe('running')
    expect(job.startedRunAt()).toBe(1_010)
    job.observeRun(false)
    expect(job.currentState()).toBe('idle')
    expect(job.startedRunAt()).toBeNull()

    time.advance(5)
    job.touch()
    expect(job.activatedAt()).toBe(1_015)
  })

  it('does not resurrect a finished job when a late event arrives', async () => {
    const registry = new AgentJobRegistry(50)
    const job = registry.register({ kind: 'chat' })
    await job.finish('workspace closed')

    job.observeRun(true)

    expect(job.currentState()).toBe('done')
    expect(job.isRunActive()).toBe(false)
  })

  it('records a crash as a terminal state with nothing left to release', () => {
    const registry = new AgentJobRegistry(50)
    const job = registry.register({ kind: 'chat' })
    job.observeRun(true)

    const snapshot = job.crashed('Agent process exited with code 1')

    expect(snapshot).toMatchObject({
      state: 'failed',
      runActive: false,
      finishReason: 'Agent process exited with code 1',
    })
    expect(isTerminalJobState(snapshot.state)).toBe(true)
    expect(registry.live()).toEqual([])
  })

  it('prunes finished jobs but never forgets an orphan', async () => {
    const registry = new AgentJobRegistry(20)
    for (let index = 0; index < 3; index++) {
      const job = registry.register({
        kind: 'chat',
        resources: { dispose: async () => {}, forceDispose: async () => {} },
      })
      await job.finish('workspace closed')
    }
    const orphan = registry.register({
      kind: 'chat',
      resources: {
        dispose: async () => {
          throw new Error('stop rejected')
        },
        forceDispose: async () => {
          throw new Error('kill denied')
        },
      },
    })
    await orphan.finish('workspace closed')

    registry.prune(1)

    const states = registry.snapshot().map((job) => job.state)
    expect(states.filter((state) => state === 'done')).toHaveLength(1)
    expect(registry.orphaned()).toHaveLength(1)
  })
})

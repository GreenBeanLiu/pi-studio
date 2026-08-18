import { describe, expect, it } from 'vitest'
import { RoutineScheduler, type SchedulableRoutine } from './routine-scheduler'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RoutineScheduler', () => {
  it('queues every simultaneously due routine above the concurrency limit', async () => {
    const routines: SchedulableRoutine[] = ['first', 'second', 'third'].map((id) => ({
      id,
      enabled: true,
      schedule: { type: 'daily', time: '09:00' },
    }))
    const completions = new Map(routines.map((routine) => [routine.id, deferred()]))
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 2,
      clock: () => new Date(2026, 6, 11, 9, 0),
      forceCleanup: async () => {},
      execute: (routine) => completions.get(routine.id)!.promise,
    })

    scheduler.tick(routines)

    expect(scheduler.getState()).toEqual({
      runningIds: ['first', 'second'],
      waitingIds: [],
      cancellingIds: [],
      queuedIds: ['third'],
    })

    completions.get('first')!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(scheduler.getState()).toEqual({
      runningIds: ['second', 'third'],
      waitingIds: [],
      cancellingIds: [],
      queuedIds: [],
    })
  })

  it('can cancel a queued routine before a slot becomes available', async () => {
    const routines: SchedulableRoutine[] = ['first', 'second', 'third'].map((id) => ({
      id,
      enabled: true,
      schedule: { type: 'daily', time: '09:00' },
    }))
    const completions = new Map(routines.map((routine) => [routine.id, deferred()]))
    const started: string[] = []
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 2,
      clock: () => new Date(2026, 6, 11, 9, 0),
      forceCleanup: async () => {},
      execute: (routine) => {
        started.push(routine.id)
        return completions.get(routine.id)!.promise
      },
    })
    scheduler.tick(routines)

    expect(scheduler.cancel('third')).toBe(true)
    completions.get('first')!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(started).toEqual(['first', 'second'])
    expect(scheduler.getState().queuedIds).toEqual([])
  })

  it('signals cancellation to a running routine', async () => {
    const routine: SchedulableRoutine = {
      id: 'running',
      enabled: true,
      schedule: { type: 'manual' },
    }
    let observedSignal: AbortSignal | null = null
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      clock: () => new Date(),
      forceCleanup: async () => {},
      execute: async (_routine, context) => {
        observedSignal = context.signal
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        )
      },
    })

    scheduler.enqueue(routine)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(scheduler.cancel(routine.id)).toBe(true)
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true)
  })

  it('projects explicit waiting and cancelling states', async () => {
    const routine: SchedulableRoutine = {
      id: 'review',
      enabled: true,
      schedule: { type: 'manual' },
    }
    const gate = deferred()
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      clock: () => new Date(),
      forceCleanup: async () => {},
      execute: async (_routine, context) => {
        context.waiting()
        await gate.promise
        context.resumed()
      },
    })

    scheduler.enqueue(routine)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(scheduler.getState().waitingIds).toEqual(['review'])
    expect(scheduler.cancel('review')).toBe(true)
    expect(scheduler.getState().cancellingIds).toEqual(['review'])
    gate.resolve()
  })

  it('reports failed executions without rejecting the scheduler loop', async () => {
    const routine: SchedulableRoutine = { id: 'failed', enabled: true, schedule: { type: 'manual' } }
    const failures: unknown[] = []
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      clock: () => new Date(),
      forceCleanup: async () => {},
      execute: async () => {
        throw new Error('workflow failed after durable finalization')
      },
      onExecutionError: (error) => failures.push(error),
    })

    scheduler.enqueue(routine)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(failures).toHaveLength(1)
    expect(failures[0]).toEqual(expect.objectContaining({ message: 'workflow failed after durable finalization' }))
    expect(scheduler.getState().runningIds).toEqual([])
  })

  it('releases a slot after the cancellation grace period when execution hangs', async () => {
    const routines: SchedulableRoutine[] = ['hung', 'next'].map((id) => ({
      id,
      enabled: true,
      schedule: { type: 'manual' },
    }))
    const started: string[] = []
    const forced: string[] = []
    const hungCompletion = deferred()
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      cancelGraceMs: 5,
      clock: () => new Date(),
      forceCleanup: async () => {},
      execute: (routine) => {
        started.push(routine.id)
        return routine.id === 'hung' ? hungCompletion.promise : Promise.resolve()
      },
      onCancellationTimeout: (routine) => forced.push(routine.id),
    })

    scheduler.enqueue(routines[0])
    scheduler.enqueue(routines[1])
    await new Promise<void>((resolve) => setImmediate(resolve))
    scheduler.cancel('hung')
    await new Promise<void>((resolve) => setTimeout(resolve, 15))

    expect(started).toEqual(['hung', 'next'])
    expect(forced).toEqual(['hung'])
    expect(scheduler.getState().runningIds).toEqual([])
    expect(scheduler.enqueue(routines[0])).toBe('running')
    hungCompletion.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('projects the forced terminal only after cleanup wins the settlement race', async () => {
    const routine: SchedulableRoutine = { id: 'racing', enabled: true, schedule: { type: 'manual' } }
    const execution = deferred()
    const cleanup = deferred()
    const forced: string[] = []
    const lifecycle: string[] = []
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      cancelGraceMs: 5,
      clock: () => new Date(),
      execute: () => execution.promise,
      forceCleanup: () => cleanup.promise,
      onCancellationTimeout: (candidate) => { forced.push(candidate.id); lifecycle.push('terminal') },
      onExecutionSettled: () => lifecycle.push('settled'),
    })
    scheduler.enqueue(routine)
    await new Promise<void>((resolve) => setImmediate(resolve))

    scheduler.cancel(routine.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    execution.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(forced).toEqual([])
    expect(scheduler.getState().cancellingIds).toEqual([routine.id])
    cleanup.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(forced).toEqual([routine.id])
    expect(lifecycle).toEqual(['terminal', 'settled'])
    expect(scheduler.getState().runningIds).toEqual([])
  })

  it('retains the scheduler slot when forced cleanup fails', async () => {
    const routine: SchedulableRoutine = { id: 'owned', enabled: true, schedule: { type: 'manual' } }
    const execution = deferred()
    const cleanupFailure = new Error('unable to verify process exit')
    const failures: unknown[] = []
    const scheduler = new RoutineScheduler<SchedulableRoutine>({
      maxConcurrent: 1,
      cancelGraceMs: 5,
      clock: () => new Date(),
      execute: () => execution.promise,
      forceCleanup: async () => { throw cleanupFailure },
      onExecutionError: (error) => failures.push(error),
    })
    scheduler.enqueue(routine)
    await new Promise<void>((resolve) => setImmediate(resolve))

    scheduler.cancel(routine.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    execution.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(failures).toEqual([cleanupFailure])
    expect(scheduler.getState().cancellingIds).toEqual([routine.id])
    expect(scheduler.hasCapacity()).toBe(false)
  })
})

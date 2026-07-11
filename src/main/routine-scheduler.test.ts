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
      execute: (routine) => completions.get(routine.id)!.promise,
    })

    scheduler.tick(routines)

    expect(scheduler.getState()).toEqual({
      runningIds: ['first', 'second'],
      queuedIds: ['third'],
    })

    completions.get('first')!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(scheduler.getState()).toEqual({
      runningIds: ['second', 'third'],
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
})

export type SchedulableSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

export type SchedulableRoutine = {
  id: string
  enabled: boolean
  schedule: SchedulableSchedule
  lastRunAt?: number
  lastSlotKey?: string
}

export type RoutineSchedulerState = {
  runningIds: string[]
  queuedIds: string[]
}

type RoutineSchedulerOptions<T extends SchedulableRoutine> = {
  maxConcurrent: number
  clock: () => Date
  execute: (routine: T) => Promise<void>
  onExecutionError?: (error: unknown, routine: T) => void
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function dueSlotKey(routine: Pick<SchedulableRoutine, 'schedule' | 'lastRunAt'>, now: Date): string | null {
  const schedule = routine.schedule
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  switch (schedule.type) {
    case 'manual':
      // 按需触发:永不自动跑,只能手动「运行」
      return null
    case 'interval': {
      const lastRunAt = routine.lastRunAt ?? 0
      return now.getTime() - lastRunAt >= schedule.minutes * 60_000 ? `interval-${now.getTime()}` : null
    }
    case 'hourly': {
      if (now.getMinutes() < schedule.minute) return null
      return `${today} ${pad(now.getHours())}h`
    }
    case 'daily': {
      if (hhmm < schedule.time) return null
      return today
    }
    case 'weekly': {
      if (now.getDay() !== schedule.day || hhmm < schedule.time) return null
      return `${today} w`
    }
  }
}

export class RoutineScheduler<T extends SchedulableRoutine> {
  private readonly maxConcurrent: number
  private readonly clock: () => Date
  private readonly execute: (routine: T) => Promise<void>
  private readonly onExecutionError?: (error: unknown, routine: T) => void
  private readonly running = new Map<string, T>()
  private readonly queue: T[] = []

  constructor(options: RoutineSchedulerOptions<T>) {
    this.maxConcurrent = options.maxConcurrent
    this.clock = options.clock
    this.execute = options.execute
    this.onExecutionError = options.onExecutionError
  }

  tick(routines: readonly T[]): T[] {
    const now = this.clock()
    const scheduled: T[] = []

    for (const routine of routines) {
      if (!routine.enabled || this.has(routine.id)) continue
      const slot = dueSlotKey(routine, now)
      if (!slot) continue
      if (routine.schedule.type !== 'interval' && routine.lastSlotKey === slot) continue

      routine.lastSlotKey = slot
      routine.lastRunAt = now.getTime()
      this.enqueue(routine)
      scheduled.push(routine)
    }

    return scheduled
  }

  enqueue(routine: T): 'running' | 'queued' | 'duplicate' {
    if (this.has(routine.id)) return 'duplicate'

    this.queue.push(routine)
    this.drain()
    return this.running.has(routine.id) ? 'running' : 'queued'
  }

  has(id: string): boolean {
    return this.running.has(id) || this.queue.some((routine) => routine.id === id)
  }

  cancel(id: string): boolean {
    const index = this.queue.findIndex((routine) => routine.id === id)
    if (index === -1) return false
    this.queue.splice(index, 1)
    return true
  }

  hasCapacity(): boolean {
    return this.running.size < this.maxConcurrent
  }

  getState(): RoutineSchedulerState {
    return {
      runningIds: [...this.running.keys()],
      queuedIds: this.queue.map((routine) => routine.id),
    }
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const routine = this.queue.shift()!
      if (!routine.enabled) continue
      this.running.set(routine.id, routine)

      void Promise.resolve()
        .then(() => this.execute(routine))
        .catch((error: unknown) => {
          try {
            this.onExecutionError?.(error, routine)
          } catch {
            // Error reporting must not prevent the next queued routine from starting.
          }
        })
        .finally(() => {
          this.running.delete(routine.id)
          this.drain()
        })
    }
  }
}

/**
 * Ownership bookkeeping for everything that runs an agent on this desktop.
 *
 * The registry owns identity, owner, lineage, state and cancellation; a producer
 * owns the real resources. The rule that makes it worth having: `done` means the
 * resources were released, not that a function returned. A cleanup that cannot be
 * confirmed lands in `orphaned` with its evidence and stays visible, because the
 * OS process may still be alive and holding the session file.
 */

import type {
  AgentJobKind,
  AgentJobOwner,
  AgentJobSnapshot,
  AgentJobState,
} from '../shared/ipc/contract'

export type { AgentJobKind, AgentJobOwner, AgentJobSnapshot, AgentJobState }

/** The real resources a job owns. Subagent runs live inside Pi and own none. */
export type AgentJobResources = {
  dispose: () => Promise<void>
  forceDispose: () => Promise<void>
  pid?: number | null
}

const TERMINAL_STATES: ReadonlySet<AgentJobState> = new Set(['done', 'failed', 'orphaned'])

export function isTerminalJobState(state: AgentJobState): boolean {
  return TERMINAL_STATES.has(state)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class AgentJob {
  private state: AgentJobState = 'starting'
  private owner: AgentJobOwner = { sessionId: null, sessionFile: null }
  private runActive = false
  private runStartedAt: number | null = null
  private lastActivatedAt: number
  private readonly startedAt: number
  private endedAt: number | null = null
  private finishReason: string | null = null
  private forced = false
  private cleanupError: string | null = null
  private finishing: Promise<AgentJobSnapshot> | null = null

  constructor(
    readonly id: string,
    readonly kind: AgentJobKind,
    readonly parentId: string | null,
    private readonly resources: AgentJobResources | null,
    private readonly disposeTimeoutMs: number,
    private readonly clock: () => number,
  ) {
    this.startedAt = clock()
    this.lastActivatedAt = this.startedAt
  }

  snapshot(): AgentJobSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      parentId: this.parentId,
      owner: { ...this.owner },
      state: this.state,
      runActive: this.runActive,
      pid: this.resources?.pid ?? null,
      startedAt: this.startedAt,
      lastActivatedAt: this.lastActivatedAt,
      runStartedAt: this.runStartedAt,
      endedAt: this.endedAt,
      finishReason: this.finishReason,
      forced: this.forced,
      cleanupError: this.cleanupError,
    }
  }

  currentState(): AgentJobState {
    return this.state
  }

  isRunActive(): boolean {
    return this.runActive
  }

  activatedAt(): number {
    return this.lastActivatedAt
  }

  startedRunAt(): number | null {
    return this.runStartedAt
  }

  claim(owner: Partial<AgentJobOwner>): void {
    this.owner = { ...this.owner, ...owner }
  }

  currentOwner(): AgentJobOwner {
    return { ...this.owner }
  }

  touch(): void {
    this.lastActivatedAt = this.clock()
  }

  /** Run liveness follows the settled semantics, not the first `agent_end`. */
  observeRun(active: boolean): void {
    if (isTerminalJobState(this.state)) return
    this.runActive = active
    if (active) {
      this.runStartedAt ??= this.clock()
      this.state = 'running'
      return
    }
    this.runStartedAt = null
    if (this.state !== 'cancelling') this.state = 'idle'
  }

  ready(): void {
    if (this.state === 'starting') this.state = 'idle'
  }

  /** The process ended without anyone asking; there is nothing left to release. */
  crashed(reason: string): AgentJobSnapshot {
    if (isTerminalJobState(this.state)) return this.snapshot()
    this.state = 'failed'
    this.runActive = false
    this.runStartedAt = null
    this.finishReason = reason
    this.endedAt = this.clock()
    return this.snapshot()
  }

  /**
   * Bounded release: a graceful stop, then a force kill, then `orphaned`. Repeat
   * callers share one attempt so an evicting caller and a closing workspace cannot
   * both try to reap the same process.
   */
  finish(reason: string): Promise<AgentJobSnapshot> {
    this.finishing ??= this.release(reason)
    return this.finishing
  }

  private async release(reason: string): Promise<AgentJobSnapshot> {
    if (isTerminalJobState(this.state)) return this.snapshot()
    this.state = 'cancelling'
    this.finishReason = reason
    if (!this.resources) return this.settle('done')
    try {
      await withDeadline(this.resources.dispose(), this.disposeTimeoutMs, 'Agent job dispose')
      return this.settle('done')
    } catch (gracefulError) {
      this.forced = true
      try {
        await withDeadline(
          this.resources.forceDispose(),
          this.disposeTimeoutMs,
          'Agent job force dispose',
        )
        return this.settle('done')
      } catch (forceError) {
        return this.settle(
          'orphaned',
          `${describeError(gracefulError)}; force dispose failed: ${describeError(forceError)}`,
        )
      }
    }
  }

  private settle(state: AgentJobState, cleanupError: string | null = null): AgentJobSnapshot {
    this.state = state
    this.runActive = false
    this.runStartedAt = null
    this.cleanupError = cleanupError
    this.endedAt = this.clock()
    return this.snapshot()
  }
}

export type AgentJobRegistration = {
  kind: AgentJobKind
  parentId?: string | null
  owner?: Partial<AgentJobOwner>
  resources?: AgentJobResources | null
}

export class AgentJobRegistry {
  private readonly jobs = new Map<string, AgentJob>()
  private sequence = 0

  constructor(
    private readonly disposeTimeoutMs = 5_000,
    private readonly clock: () => number = Date.now,
  ) {}

  register(registration: AgentJobRegistration): AgentJob {
    const id = `job-${++this.sequence}`
    const job = new AgentJob(
      id,
      registration.kind,
      registration.parentId ?? null,
      registration.resources ?? null,
      this.disposeTimeoutMs,
      this.clock,
    )
    if (registration.owner) job.claim(registration.owner)
    this.jobs.set(id, job)
    return job
  }

  get(id: string): AgentJob | null {
    return this.jobs.get(id) ?? null
  }

  /** Jobs that still hold something. Orphans count as live: their processes may not be gone. */
  live(): AgentJob[] {
    return [...this.jobs.values()].filter((job) => {
      const state = job.currentState()
      return state !== 'done' && state !== 'failed'
    })
  }

  children(parentId: string): AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.parentId === parentId)
  }

  /** Cleanups that could not be confirmed; kept so diagnostics can still see them. */
  orphaned(): AgentJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => job.currentState() === 'orphaned')
      .map((job) => job.snapshot())
  }

  snapshot(): AgentJobSnapshot[] {
    return [...this.jobs.values()].map((job) => job.snapshot())
  }

  /**
   * Drops the finished jobs, keeping the most recent ones for diagnostics.
   * Orphans are never forgotten: their evidence is the only trace of a leak.
   */
  prune(keepFinished = 20): void {
    const finished = [...this.jobs.values()].filter(
      (job) => isTerminalJobState(job.currentState()) && job.currentState() !== 'orphaned',
    )
    const excess = finished.length - keepFinished
    if (excess <= 0) return
    for (const job of finished
      .sort((a, b) => (a.snapshot().endedAt ?? 0) - (b.snapshot().endedAt ?? 0))
      .slice(0, excess)) {
      this.jobs.delete(job.id)
    }
  }
}

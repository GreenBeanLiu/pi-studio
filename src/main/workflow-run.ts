export type WorkflowRunState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

export type WorkflowRunResult = {
  state: 'completed' | 'failed' | 'cancelled'
  error?: unknown
}

export class WorkflowDisposeTimeoutError extends Error {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Workflow run did not stop within ${timeoutMs}ms`, options)
    this.name = 'WorkflowDisposeTimeoutError'
  }
}

/** One owned workflow execution. Its result is closed and never rejects. */
export class WorkflowRunHandle {
  readonly result: Promise<WorkflowRunResult>
  readonly cleanup: Promise<void>
  private readonly controller = new AbortController()
  private currentState: WorkflowRunState = 'queued'
  private settle!: (result: WorkflowRunResult) => void
  private settleCleanup!: () => void
  private settled = false
  private cleanupSettled = false
  private forceClosing = false
  private cancelTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    execute: (signal: AbortSignal) => Promise<void>,
    private readonly disposeTimeoutMs = 5_000,
    private readonly forceCleanup: () => Promise<void> = () => Promise.resolve(),
    private readonly onForceCleanupError?: (error: unknown) => void,
  ) {
    this.result = new Promise<WorkflowRunResult>((resolve) => {
      this.settle = resolve
    })
    this.cleanup = new Promise<void>((resolve) => {
      this.settleCleanup = resolve
    })
    void Promise.resolve()
      .then(async () => {
        if (this.controller.signal.aborted) return { state: 'cancelled' as const }
        this.currentState = 'running'
        await execute(this.controller.signal)
        return {
          state: this.controller.signal.aborted ? ('cancelled' as const) : ('completed' as const),
        }
      })
      .catch((error: unknown) => ({
        state: this.controller.signal.aborted ? ('cancelled' as const) : ('failed' as const),
        error,
      }))
      .then((result) => {
        if (this.forceClosing) return
        this.completeCleanup()
        this.finish(result)
      })
  }

  state(): WorkflowRunState {
    return this.currentState
  }

  waiting(): void {
    if (this.currentState === 'running') this.currentState = 'waiting'
  }

  resumed(): void {
    if (this.currentState === 'waiting') this.currentState = 'running'
  }

  cancel(reason = 'Workflow run cancelled'): void {
    if (this.currentState === 'completed' || this.currentState === 'failed' || this.currentState === 'cancelled') return
    this.currentState = 'cancelling'
    this.controller.abort(new Error(reason))
    this.cancelTimer ??= setTimeout(() => void this.forceClose(), this.disposeTimeoutMs)
  }

  async dispose(): Promise<void> {
    this.cancel('Workflow run disposed')
    await this.result
    await this.cleanup
  }

  private finish(result: WorkflowRunResult): void {
    if (this.settled) return
    this.settled = true
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.currentState = result.state
    this.settle(result)
  }

  private completeCleanup(): void {
    if (this.cleanupSettled) return
    this.cleanupSettled = true
    this.settleCleanup()
  }

  private async forceClose(): Promise<void> {
    if (this.settled || this.forceClosing) return
    // Own settlement before cleanup can synchronously settle the executor.
    this.forceClosing = true
    try {
      await this.forceCleanup()
    } catch (error) {
      try {
        this.onForceCleanupError?.(error)
      } catch {
        // Cleanup ownership must remain retained even if error reporting fails.
      }
      return
    }
    this.completeCleanup()
    this.finish({
      state: 'cancelled',
      error: new WorkflowDisposeTimeoutError(this.disposeTimeoutMs),
    })
  }
}

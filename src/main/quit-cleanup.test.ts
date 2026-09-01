import { describe, expect, it, vi } from 'vitest'
import { createQuitGuard } from './quit-cleanup'

function harness(overrides: Partial<Parameters<typeof createQuitGuard>[0]> = {}) {
  const quit = vi.fn()
  const outcomes: Array<'done' | 'timeout'> = []
  let release: (() => void) | null = null
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const guard = createQuitGuard({
    cleanup,
    quit,
    timeoutMs: 8_000,
    onOutcome: (outcome) => outcomes.push(outcome),
    ...overrides,
  })
  const event = { preventDefault: vi.fn() }
  return { guard, quit, cleanup, outcomes, event, finishCleanup: () => release?.() }
}

describe('quit guard', () => {
  it('holds the quit open until cleanup lands, then quits exactly once', async () => {
    const h = harness()

    h.guard.handleBeforeQuit(h.event)
    expect(h.event.preventDefault).toHaveBeenCalledTimes(1)
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.quit).not.toHaveBeenCalled()

    h.finishCleanup()
    await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(1))
    expect(h.outcomes).toEqual(['done'])
    expect(h.guard.isSettled()).toBe(true)
  })

  it('lets the second quit through once cleanup has landed', async () => {
    const h = harness()
    h.guard.handleBeforeQuit(h.event)
    h.finishCleanup()
    await vi.waitFor(() => expect(h.guard.isSettled()).toBe(true))

    const second = { preventDefault: vi.fn() }
    h.guard.handleBeforeQuit(second)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(h.cleanup).toHaveBeenCalledTimes(1)
  })

  it('keeps blocking, and does not restart cleanup, when quit is triggered again mid-flight', () => {
    const h = harness()
    h.guard.handleBeforeQuit(h.event)

    const second = { preventDefault: vi.fn() }
    h.guard.handleBeforeQuit(second)

    // 关键:清理没落地时第二次退出也必须被拦住,否则连点两下就绕过了闸门
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('quits anyway when cleanup outlives the timeout, and says so', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.guard.handleBeforeQuit(h.event)
      expect(h.quit).not.toHaveBeenCalled()

      vi.advanceTimersByTime(8_000)
      await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(1))
      expect(h.outcomes).toEqual(['timeout'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still quits when cleanup rejects', async () => {
    const h = harness({ cleanup: vi.fn(() => Promise.reject(new Error('dispose blew up'))) })
    h.guard.handleBeforeQuit(h.event)
    await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(1))
    expect(h.outcomes).toEqual(['done'])
  })

  it('does not report a timeout after cleanup already landed', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.guard.handleBeforeQuit(h.event)
      h.finishCleanup()
      await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(1))

      vi.advanceTimersByTime(60_000)
      expect(h.quit).toHaveBeenCalledTimes(1)
      expect(h.outcomes).toEqual(['done'])
    } finally {
      vi.useRealTimers()
    }
  })
})

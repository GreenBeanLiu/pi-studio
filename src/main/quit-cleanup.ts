/**
 * 退出时的清理闸门。
 *
 * `before-quit` 是同步的,但放掉 agent 进程不是:stopAll 里每个 agent 最坏要
 * 5s 优雅停 + 5s 强杀。不拦住 quit 的话 app 早已退出、清理还在半路上,漏掉的
 * `pi` 和外部 ACP 进程没有任何东西会再去收 —— 它们不是 detached 起的,但退出
 * 时也没有谁给那个进程组发信号。
 *
 * 反过来也不能让一个卡死的 dispose 把退出永久卡住,所以有硬上限;超时走的是
 * 「记一笔能对账的日志然后照样退出」,而不是静默当成收干净了。
 */

export type BeforeQuitEvent = { preventDefault: () => void }

export type QuitGuardOptions = {
  /** 真正的清理动作。抛错也算清理结束 —— 退出不能被它卡住。 */
  cleanup: () => Promise<unknown>
  /** 清理落地后再次发起退出。 */
  quit: () => void
  /** 清理的硬上限,默认 8s。 */
  timeoutMs?: number
  /** 'done' = 清理跑完;'timeout' = 超时放弃,可能有进程没收掉。 */
  onOutcome?: (outcome: 'done' | 'timeout') => void
}

export type QuitGuard = {
  handleBeforeQuit: (event: BeforeQuitEvent) => void
  /** 诊断用:清理是否已经落地。 */
  isSettled: () => boolean
}

export const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 8_000

export function createQuitGuard(options: QuitGuardOptions): QuitGuard {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUIT_CLEANUP_TIMEOUT_MS
  let started = false
  let settled = false

  return {
    isSettled: () => settled,
    handleBeforeQuit(event: BeforeQuitEvent): void {
      // 清理已经落地,这次退出放行。
      if (settled) return
      // 清理还没落地就一律拦住 —— 包括清理正在跑时用户又点了一次退出,
      // 否则第二次点击会绕过闸门,正好把这个修复废掉。
      event.preventDefault()
      if (started) return
      started = true

      let finish: (outcome: 'done' | 'timeout') => void = () => {}
      const settle = new Promise<'done' | 'timeout'>((resolve) => {
        finish = resolve
      })
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      // 清理抛错和清理成功一样算结束:退出不能被一个失败的 dispose 挡住。
      void options.cleanup().then(
        () => finish('done'),
        () => finish('done'),
      )

      void settle.then((outcome) => {
        clearTimeout(timer)
        settled = true
        options.onOutcome?.(outcome)
        options.quit()
      })
    },
  }
}

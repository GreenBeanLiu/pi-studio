import { defineConfig } from 'vitest/config'

/**
 * 这份配置只做一件事:把单条用例的超时从 vitest 默认的 5 秒放宽。
 *
 * 这个测试套里有相当一部分要真起子进程 —— eval driver 的 command grader、
 * RunChangeSet 的 git 操作、pi runtime 的握手。在开发机上它们几十毫秒就回来了,
 * 5 秒绰绰有余;但在 CI 的 Windows runner 上完全不是一回事:
 *
 *   - command grader 走 scripts/eval-command-job.ps1,那个脚本里有 Add-Type
 *     运行时编译 C#(为了建 Job Object),冷启动就是好几秒
 *   - git / PowerShell 每次 spawn 本身也要几百毫秒
 *
 * 2026-08-26 CI 第一次真正跑起来时,Windows 上 7 条用例全是
 * `Test timed out in 5000ms`,一条断言错都没有 —— 纯粹是时间不够。
 * (在那之前 CI 一直挂在 pnpm 版本冲突上,从没跑到测试。)
 *
 * 放宽到 30 秒。对本来就快的用例零成本,真卡死的用例也还有上界。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

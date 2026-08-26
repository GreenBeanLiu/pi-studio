import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { EvalDriver, ProjectionReplayEvalEngine, parseEvalCase, readEvalRecording, type EvalEngine, type EvalRecording } from './eval-driver'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-studio-eval-test-'))
  const workspace = join(root, 'fixture')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'input.txt'), 'before', 'utf8')
  return workspace
}

/**
 * 这个文件的超时统一放宽到 60 秒。
 *
 * 里面凡是跑 command grader 的用例,在 Windows 上都要走 scripts/eval-command-job.ps1,
 * 那个脚本用 Add-Type 运行时编译 C#(为了建 Job Object),而且每 spawn 一次编译一次。
 * 开发机上几百毫秒;GitHub Windows runner 上 2026-08-26 实测每条 ~23 秒
 * (csc 冷启动 + Defender 实时扫描)。全局 testTimeout 是 30 秒 —— 只剩 6 秒余量,
 * 下一次 runner 慢一点就是一片红,而且报出来会是「Test timed out」这种毫无线索的错。
 *
 * 放宽的是这一个文件,不动全局的 30 秒 —— 别的 94 个文件没有这条慢路径,
 * 守卫该留着。
 */
describe('EvalDriver', { timeout: 60_000 }, () => {
  // 全套 grader 都跑一遍(file + command + diff + pi),是这个文件里最重的一条。
  // Windows 上 command grader 要过 eval-command-job.ps1,那个脚本 Add-Type 运行时
  // 编译 C#(为了建 Job Object),冷 runner 上一次就好几秒;diff grader 还要起 git。
  // 2026-08-26 CI 实测这一条在 Windows 上 30 秒不够,单独给它更长的。
  // 超时给得很宽,是因为这条要在 Windows 上真起一次 command grader,而那条路径
  // 走 scripts/eval-command-job.ps1 —— 里面用 Add-Type 运行时编译 C# 来建 Job Object。
  // 开发机上几百毫秒,GitHub Windows runner 上实测 48.6 秒(csc 冷启动 + Defender 实时扫描)。
  // grader 自己的默认上限就是 60 秒,48.6 秒贴着天花板,2026-08-26 已经翻车过一次
  // (60087ms,报出来只是 report.passed 为 false)。所以 grader 显式给 120 秒、
  // 用例给 180 秒 —— 这条测的是 grader 干不干活,不是它多快。
  it('isolates the fixture and grades files, commands, diffs, and artifacts', { timeout: 180_000 }, async () => {
    const source = fixture()
    const engine: EvalEngine = {
      async run(request, emit) {
        writeFileSync(join(request.workspacePath, 'result.txt'), 'done', 'utf8')
        emit({ raw: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: { path: 'result.txt' } }, normalized: { seq: 1, sessionId: request.sessionId, type: 'tool.started', data: { tool: { callId: 'call-1' } } } })
        return { finalResponse: 'finished', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId }
      },
      cleanup: () => Promise.resolve(),
    }
    const evalCase = parseEvalCase({
      version: 1, id: 'write-result', fixture: source, prompt: 'write it', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      artifacts: ['**/*.txt', '*.txt'],
      graders: [
        { type: 'exit-code', expected: 0 },
        { type: 'file', path: 'result.txt', equals: 'done' },
        { type: 'command', executable: process.execPath, args: ['-e', "process.exit(require('fs').existsSync('result.txt') ? 0 : 1)"], timeoutMs: 120_000 },
        { type: 'diff', allow: ['result.txt'], maxChangedFiles: 1 },
      ],
    })

    const report = await new EvalDriver(true).run(evalCase, engine)

    // 先断言「没有失败的 grader」再断言总体通过:report.passed 是个布尔,挂了只会说
    // expected false to be true,看不出是哪个 grader、为什么。把失败的那条整个摊开,
    // stderr 和 kind 都在里面 —— CI 上没法本地复现时,这就是唯一的线索。
    expect(report.graders.filter((grader) => !grader.passed)).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.workspacePath).not.toBe(source)
    expect(readFileSync(join(source, 'input.txt'), 'utf8')).toBe('before')
    expect(report.workspaceDiff).toEqual([expect.objectContaining({ path: 'result.txt', status: 'added' })])
    expect(report.artifacts).toEqual(['result.txt'])
    expect(report.toolCalls).toHaveLength(1)
  })

  it('replays raw events through the real session projector without an API key', async () => {
    const source = fixture()
    const recording: EvalRecording = {
      version: 1,
      caseId: 'replay',
      engineResult: { finalResponse: 'recorded', finishReason: 'settled', exitCode: 0, sessionId: 'session-replay', messages: [] },
      events: [{
        atMs: 0,
        observedAt: '2026-08-17T00:00:00.000Z',
        raw: { type: 'agent_start' },
        normalized: { seq: 2, sessionId: 'session-replay', type: 'agent.started', data: {} },
      }],
    }
    const evalCase = parseEvalCase({
      version: 1, id: 'replay', fixture: source, prompt: 'unused', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 0 }],
    })

    const report = await new EvalDriver().run(evalCase, new ProjectionReplayEvalEngine(recording))

    expect(report.passed).toBe(true)
    expect(report.finishReason).toBe('settled')
    expect(report.events[0].normalized?.type).toBe('agent.started')
  })

  it('rejects grader paths that escape the isolated workspace', () => {
    expect(() => parseEvalCase({
      version: 1, id: 'unsafe', fixture: fixture(), prompt: '', timeoutMs: 1,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'file', path: '../secret.txt' }],
    })).toThrow('must stay within the evaluation workspace')
  })

  it('aborts on deadline and waits for cooperative engine cleanup', async () => {
    const source = fixture()
    let aborted = false
    let cleaned = false
    let resolveCleanup!: () => void
    const cleanupDone = new Promise<void>((resolve) => { resolveCleanup = resolve })
    const engine: EvalEngine = {
      run(request, _emit, signal) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            setTimeout(() => {
              cleaned = true
              resolveCleanup()
              resolve({ finalResponse: '', finishReason: 'cancelled', exitCode: 1, sessionId: request.sessionId })
            }, 10)
          }, { once: true })
        })
      },
      cleanup: () => cleanupDone,
    }
    const evalCase = parseEvalCase({
      version: 1, id: 'timeout', fixture: source, prompt: 'hang', timeoutMs: 5,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 1 }],
    })

    const report = await new EvalDriver().run(evalCase, engine)

    expect(aborted).toBe(true)
    expect(cleaned).toBe(true)
    expect(report.finishReason).toBe('timeout')
    expect(report.passed).toBe(true)
    expect(report.workspacePath).toBe('(removed)')
  })

  it('retains the workspace and skips grading when cleanup cannot be verified', async () => {
    const evalCase = parseEvalCase({
      version: 1, id: 'cleanup-failed', fixture: fixture(), prompt: '', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'exit-code', expected: 0 }],
    })
    const engine: EvalEngine = {
      async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
      cleanup: () => Promise.reject(new Error('owned process still running')),
    }

    let failure: Error | undefined
    try {
      await new EvalDriver().run(evalCase, engine)
    } catch (error) {
      failure = error as Error
    }

    expect(failure?.message).toContain('cleanup could not be verified')
    const retained = failure?.message.match(/retained at (.+)$/)?.[1]
    expect(retained).toBeTruthy()
    expect(existsSync(retained!)).toBe(true)
    rmSync(join(retained!, '..'), { recursive: true, force: true })
  })

  it('does not treat command infrastructure failures as expected exit codes', async () => {
    const evalCase = parseEvalCase({
      version: 1, id: 'missing-command', fixture: fixture(), prompt: '', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'command', executable: 'pi-studio-command-that-does-not-exist', expectedExitCode: 1 }],
    })
    const engine: EvalEngine = {
      async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
      cleanup: () => Promise.resolve(),
    }

    const report = await new EvalDriver().run(evalCase, engine)

    expect(report.passed).toBe(false)
    expect(report.graders[0]).toMatchObject({ passed: false, details: { kind: 'spawn-error' } })
  })

  it('gives command graders a minimal environment unless a variable is explicitly bound', async () => {
    process.env.PI_STUDIO_EVAL_HOST_SECRET = 'must-not-leak'
    try {
      const evalCase = parseEvalCase({
        version: 1, id: 'minimal-env', fixture: fixture(), prompt: '', timeoutMs: 1_000,
        engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
        graders: [{
          type: 'command', executable: process.execPath,
          args: ['-e', "process.exit(process.env.PI_STUDIO_EVAL_HOST_SECRET ? 1 : 0)"],
        }],
      })
      const engine: EvalEngine = {
        async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
        cleanup: () => Promise.resolve(),
      }

      const report = await new EvalDriver().run(evalCase, engine)

      expect(report.passed).toBe(true)
    } finally {
      delete process.env.PI_STUDIO_EVAL_HOST_SECRET
    }
  })

  it('kills the complete command process tree on grader timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-eval-tree-'))
    const sentinel = join(root, 'grandchild-survived.txt')
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'leak'), 300)`
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
    const evalCase = parseEvalCase({
      version: 1, id: 'tree-timeout', fixture: fixture(), prompt: '', timeoutMs: 2_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'command', executable: process.execPath, args: ['-e', parent], timeoutMs: 50 }],
    })
    const engine: EvalEngine = {
      async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
      cleanup: () => Promise.resolve(),
    }

    const report = await new EvalDriver().run(evalCase, engine)
    await new Promise<void>((resolve) => setTimeout(resolve, 400))

    expect(report.graders[0]).toMatchObject({ passed: false, details: { kind: 'timeout' } })
    expect(existsSync(sentinel)).toBe(false)
  })

  // 命令**正常退出**之后残留的子孙,只有操作系统级的容器收得住:Windows 那条路
  // 把命令放进 Job Object(KILL_ON_JOB_CLOSE),子孙怎么跑都在里面。
  //
  // POSIX 上做不到,而且不是实现没写好 —— 2026-08-26 实测(macOS 26.5):
  //     exit  +391ms  组=ESRCH
  //     close +392ms  组=ESRCH
  //     哨兵: true
  // 驱动能动手的最早时机(child 的 exit 事件)已经晚于进程组解散,kill(-pgid)
  // 打在空处;父进程一退出,子孙的 PPID 又被重挂到 1,血缘也断了。
  // macOS 上连靠环境变量标记去认都不行:SIP 下这类进程的 environ 读不到(实测)。
  // Linux 的对等物是 cgroup,普通用户进程用不了。
  //
  // 超时那条路(上面那条用例)在 POSIX 上是过的 —— 那时父进程还活着、组还在,
  // kill(-pgid) 打得到。所以「跑着的时候能收干净」是所有平台都成立的保证,
  // 「正常退出后还能追杀」只有 Job Object 平台成立。
  //
  // 这条断言从 0d99a58(2026-08-17)加进来起就只在 CI 的 Windows 上成立,
  // 在 mac 上一直红着。与其挂一条永远红的测试,不如把契约按平台写清楚。
  it.runIf(process.platform === 'win32')(
    'cleans descendants left behind by a command that exits successfully (job object platforms only)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pi-studio-eval-tree-success-'))
      const sentinel = join(root, 'grandchild-survived.txt')
      const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'leak'), 300)`
      const parent = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}); child.unref()`
      const evalCase = parseEvalCase({
        version: 1, id: 'tree-success', fixture: fixture(), prompt: '', timeoutMs: 2_000,
        engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
        graders: [{ type: 'command', executable: process.execPath, args: ['-e', parent] }],
      })
      const engine: EvalEngine = {
        async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
        cleanup: () => Promise.resolve(),
      }

      const report = await new EvalDriver().run(evalCase, engine)
      await new Promise<void>((resolve) => setTimeout(resolve, 400))

      expect(report.passed).toBe(true)
      expect(existsSync(sentinel)).toBe(false)
    },
  )

  // 正常退出的命令本身仍然要被收掉,只是追不到已经脱离的子孙。
  it('still terminates the command itself when it exits on its own', async () => {
    const evalCase = parseEvalCase({
      version: 1, id: 'tree-self', fixture: fixture(), prompt: '', timeoutMs: 2_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [{ type: 'command', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
    })
    const engine: EvalEngine = {
      async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
      cleanup: () => Promise.resolve(),
    }
    const report = await new EvalDriver().run(evalCase, engine)
    expect(report.passed).toBe(true)
    expect(report.graders[0]).toMatchObject({ passed: true })
  })

  it('does not let command graders create evidence for file or diff graders', async () => {
    const evalCase = parseEvalCase({
      version: 1, id: 'grader-isolation', fixture: fixture(), prompt: '', timeoutMs: 2_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' },
      graders: [
        { type: 'command', executable: process.execPath, args: ['-e', "require('fs').writeFileSync('result.txt','done')"] },
        { type: 'file', path: 'result.txt', equals: 'done' },
        { type: 'diff', maxChangedFiles: 0 },
      ],
    })
    const engine: EvalEngine = {
      async run(request) { return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId } },
      cleanup: () => Promise.resolve(),
    }

    const report = await new EvalDriver().run(evalCase, engine)

    expect(report.graders.map((grader) => grader.passed)).toEqual([true, false, true])
    expect(report.passed).toBe(false)
    expect(report.workspaceDiff).toEqual([])
  })

  it('rejects links created inside an evaluation workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pi-studio-eval-outside-'))
    const source = fixture()
    const engine: EvalEngine = {
      async run(request) {
        symlinkSync(outside, join(request.workspacePath, 'escape'), 'junction')
        return { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: request.sessionId }
      },
      cleanup: () => Promise.resolve(),
    }
    const evalCase = parseEvalCase({
      version: 1, id: 'link', fixture: source, prompt: '', timeoutMs: 1_000,
      engine: { type: 'pi', provider: 'test', security: 'host-full-access' }, graders: [],
    })

    await expect(new EvalDriver().run(evalCase, engine)).rejects.toThrow('symbolic links are not allowed')
  })

  it('rejects malformed recordings at the read boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-recording-test-'))
    const path = join(root, 'invalid.recording.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      caseId: 'invalid',
      engineResult: { finalResponse: '', finishReason: 'settled', exitCode: 0, sessionId: 'session', messages: [null] },
      events: [],
    }), 'utf8')

    await expect(readEvalRecording(path)).rejects.toThrow('must contain valid agent messages')
  })
})

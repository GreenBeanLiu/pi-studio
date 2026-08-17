import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { readFileSync } from 'node:fs'
import { isContextOverflow } from '@earendil-works/pi-ai/compat'
import {
  embeddedNodeEnv,
  loadRpcClient,
  nextRunActive,
  pickEvictableAgent,
  resolveEmbeddedNodePath,
  sessionKey,
} from './pi-client'

// 2026-08-03:pi 的 new_session / switch_session 直接 dispose 当前会话。实测(本地假
// SSE provider)正在跑的一轮会被掐断且一个事件都不发 —— message_end / turn_end /
// agent_end / agent_settled 全没有,界面永远停在最后一步。所以改成一个聊天一个进程,
// 切换只换看哪一个,谁都不用被中断。
describe('one agent process per chat', () => {
  it('treats a run as live from agent_start until agent_settled', () => {
    expect(nextRunActive(false, 'agent_start')).toBe(true)
    // agent_end 之后还可能自动重试或压缩后续跑,不能就此当成结束
    expect(nextRunActive(true, 'agent_end')).toBe(true)
    expect(nextRunActive(true, 'message_end')).toBe(true)
    expect(nextRunActive(true, 'agent_settled')).toBe(false)
    expect(nextRunActive(false, 'tool_execution_end')).toBe(false)
  })

  it('never reclaims the chat being viewed or one that is still running', () => {
    const active = { runActive: false, lastActivatedAt: 300 }
    const running = { runActive: true, lastActivatedAt: 100 }
    const idleOld = { runActive: false, lastActivatedAt: 150 }
    const idleNew = { runActive: false, lastActivatedAt: 200 }
    expect(pickEvictableAgent([active, running, idleOld, idleNew], active)).toBe(idleOld)
    // 只剩当前会话和在跑的会话时宁可超上限,也不能杀掉用户正在跑的一轮
    expect(pickEvictableAgent([active, running], active)).toBeNull()
    expect(pickEvictableAgent([], null)).toBeNull()
  })

  it('recognises the same session file however the caller spelled it', () => {
    // 手机端传来的路径没走桌面的 parseSessionPath;认不出来就会给同一个会话再起一个进程。
    // 这里在 mac 上跑也必须成立:同一个账户下手机可以控制 Windows 那台电脑,
    // 而 mac 的 resolve() 不认反斜杠,会把整条路径当成一个文件名再拼上 cwd。
    const a = sessionKey('C:\\Users\\me\\sessions\\--D--Works--\\s.jsonl')
    const b = sessionKey('C:/Users/me/sessions/--D--Works--/s.jsonl')
    expect(a).toBe(b)
    expect(a).not.toContain('/Users/glanger')
    // 大小写和 .. 也要归一
    expect(sessionKey('c:/USERS/me/x/../sessions/S.JSONL')).toBe(
      sessionKey('C:\\Users\\me\\sessions\\s.jsonl'),
    )
    // POSIX 路径照旧 —— 只在 POSIX 宿主上成立:Windows 的 resolve() 会给它补上
    // 当前盘符(CI 就是 windows-latest),那是宿主的路径规则,不是这个函数的问题。
    if (process.platform !== 'win32') {
      expect(sessionKey('/Users/me/sessions/s.jsonl')).toBe('/Users/me/sessions/s.jsonl')
    }
    expect(sessionKey(null)).toBeNull()
  })

  it('switches by activating another process instead of tearing a session down', () => {
    const source = readFileSync(new URL('./pi-client.ts', import.meta.url), 'utf8')
    // 切换/新建都只是起进程或换激活对象:既不中止当前这轮,也不碰 pi 的 new_session
    // (abort 本身还留着 —— 那是停止按钮用的)
    expect(source).not.toContain('settleActiveRun')
    expect(source).not.toContain('client.newSession()')
    expect(source).toContain('const existing = this.entries.find')
    // 后台会话的审批请求要留到它回到前台再补发,否则没人应答会卡死
    expect(source).toContain('entry.pendingUi.push(event)')
  })
})

describe('context overflow recovery', () => {
  it('retries a length-truncated response that only had room for one output token', () => {
    expect(
      isContextOverflow(
        {
          role: 'assistant',
          content: [{ type: 'text', text: '**' }],
          api: 'openai-completions',
          provider: 'three-a-grok',
          model: 'grok-4.5',
          usage: {
            input: 437,
            output: 1,
            cacheRead: 130_816,
            cacheWrite: 0,
            totalTokens: 131_254,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'length',
          timestamp: Date.now(),
        },
        128_000,
      ),
    ).toBe(true)
  })
})

describe('embeddedNodeEnv', () => {
  it('marks the application executable as a Node-compatible runtime', () => {
    expect(embeddedNodeEnv({ OPENAI_API_KEY: 'test' })).toEqual({
      OPENAI_API_KEY: 'test',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('overrides a stale inherited Electron runtime flag', () => {
    expect(embeddedNodeEnv({ ELECTRON_RUN_AS_NODE: '0' }).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  // Spawns a real RpcClient subprocess, which is slow enough under a loaded suite
  // to exceed the default per-test deadline.
  it('starts RpcClient with the current process runtime instead of node from PATH', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-rpc-runtime-'))
    const fixture = join(dir, 'rpc-fixture.mjs')
    writeFileSync(
      fixture,
      `process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: { runtime: process.execPath } }) + '\\n')
  }
})
`,
      'utf8',
    )
    const RpcClient = await loadRpcClient()
    const client = new RpcClient({ cliPath: fixture, runtimePath: process.execPath })
    try {
      await client.start()
      await expect(client.getState()).resolves.toMatchObject({ runtime: process.execPath })
    } finally {
      await client.stop().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects Electron\'s background-only Helper on macOS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-helper-runtime-'))
    const execPath = join(dir, 'Test.app', 'Contents', 'MacOS', 'Test')
    const helperPath = join(
      dir,
      'Test.app',
      'Contents',
      'Frameworks',
      'Test Helper.app',
      'Contents',
      'MacOS',
      'Test Helper',
    )
    try {
      mkdirSync(dirname(helperPath), { recursive: true })
      writeFileSync(helperPath, '')
      expect(resolveEmbeddedNodePath(execPath, 'darwin')).toBe(helperPath)
      expect(resolveEmbeddedNodePath(execPath, 'win32')).toBe(execPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const electronPath = require('electron') as string
  it.runIf(existsSync(electronPath))('runs the selected Electron runtime as Node', () => {
    const runtimePath = resolveEmbeddedNodePath(electronPath)
    const result = spawnSync(runtimePath, ['-e', 'process.stdout.write(process.version)'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\./)
  })
})

// 后台 agent 和子代理都登记成 job:owner、血缘、终态和"资源真的放掉了"的证据都在
// registry 上,而不是散在 AgentEntry 数组和界面的前后台概念里。
describe('agent processes are owned by jobs', () => {
  const source = readFileSync(new URL('./pi-client.ts', import.meta.url), 'utf8')

  it('releases a process through its job instead of an unbounded dispose', () => {
    // 旧写法 `entry.client.dispose().catch(() => {})` 会把停不下来的进程当成已回收:
    // 收尾要走 job.finish(),停不住就强杀,强杀也失败就留成 orphaned 带证据。
    expect(source).not.toContain('entry.client.dispose()')
    expect(source).toContain('await entry.job.finish(reason)')
  })

  it('counts liveness from the registry so an orphan is not reported as reclaimed', () => {
    expect(source).toContain('return this.jobs.live().length')
  })

  it('gives every subagent run a parent job', () => {
    expect(source).toContain("kind: 'subagent'")
    expect(source).toContain('parentId: entry.job.id')
  })
})

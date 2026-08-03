import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { readFileSync } from 'node:fs'
import {
  embeddedNodeEnv,
  loadRpcClient,
  nextRunActive,
  pickEvictableAgent,
  resolveEmbeddedNodePath,
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

  it('starts RpcClient with the current process runtime instead of node from PATH', async () => {
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

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { embeddedNodeEnv, loadRpcClient, resolveEmbeddedNodePath } from './pi-client'

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

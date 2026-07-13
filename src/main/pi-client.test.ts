import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { embeddedNodeEnv, loadRpcClient } from './pi-client'

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
    const client = new RpcClient({ cliPath: fixture })
    try {
      await client.start()
      await expect(client.getState()).resolves.toMatchObject({ runtime: process.execPath })
    } finally {
      await client.stop().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const electronPath = require('electron') as string
  it.runIf(existsSync(electronPath))('runs Electron itself as the embedded Node runtime', () => {
    const result = spawnSync(electronPath, ['-e', 'process.stdout.write(process.version)'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\./)
  })
})

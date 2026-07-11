import { describe, expect, it } from 'vitest'
import { ComfyRuntime, type ComfyRuntimeConfig, type ComfyRuntimeProcess } from './comfy-runtime'

const config: ComfyRuntimeConfig = {
  baseUrl: 'http://127.0.0.1:8188',
  comfyDir: 'D:\\Works\\ComfyUI',
  pythonPath: 'D:\\Works\\ComfyUI\\.venv\\Scripts\\python.exe',
  checkpoint: 'sd_xl_base_1.0.safetensors',
  startupTimeoutMs: 100,
}

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeProcess(): ComfyRuntimeProcess & {
  emitExit: (code?: number | null) => void
  emitStderr: (message: string) => void
} {
  const listeners = new Set<(code: number | null, signal: string | null) => void>()
  const stderrListeners = new Set<(chunk: Buffer | string) => void>()
  return {
    exitCode: null,
    kill: () => {
      for (const listener of listeners) listener(0, null)
      return true
    },
    on: (event, listener) => {
      if (event === 'exit') listeners.add(listener)
      return undefined
    },
    stderr: {
      on: (_event, listener) => {
        stderrListeners.add(listener)
        return undefined
      },
    },
    emitExit: (code = 1) => {
      for (const listener of listeners) listener(code, null)
    },
    emitStderr: (message) => {
      for (const listener of stderrListeners) listener(message)
    },
  }
}

describe('ComfyRuntime', () => {
  it('reports system details and whether the configured checkpoint exists', async () => {
    const runtime = new ComfyRuntime(() => config, {
      existsSync: () => true,
      fetch: async (url) =>
        url.endsWith('/system_stats')
          ? response({ system: { python_version: '3.11', torch_version: '2.5' }, devices: [{ name: 'cuda:0' }] })
          : response({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[config.checkpoint]] } } } }),
      spawn: () => fakeProcess(),
      sleep: async () => {},
      now: () => 0,
    })

    await expect(runtime.health()).resolves.toMatchObject({
      reachable: true,
      checkpointAvailable: true,
      checkpoints: [config.checkpoint],
      pythonVersion: '3.11',
      torchVersion: '2.5',
      deviceNames: ['cuda:0'],
    })
  })

  it('treats an empty checkpoint as automatic model selection', async () => {
    const runtime = new ComfyRuntime(() => ({ ...config, checkpoint: '' }), {
      fetch: async (url) =>
        url.endsWith('/system_stats')
          ? response({ system: {}, devices: [] })
          : response({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux1-dev.safetensors']] } } } }),
    })

    await expect(runtime.health()).resolves.toMatchObject({
      checkpoint: '',
      checkpointAvailable: true,
      checkpoints: ['flux1-dev.safetensors'],
    })
  })

  it('serializes startup and returns a checkpoint diagnostic when it is missing', async () => {
    let spawnCount = 0
    let spawnedArgs: string[] = []
    let ready = false
    const process = fakeProcess()
    const runtime = new ComfyRuntime(() => ({
      ...config,
      launchArgs: ['main.py', '--port', '{port}', '--listen', '127.0.0.1'],
    }), {
      existsSync: () => true,
      fetch: async (url) =>
        url.endsWith('/system_stats')
          ? ready
            ? response({ system: {}, devices: [] })
            : response({}, false)
          : response({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['other.safetensors']] } } } }),
      spawn: (_command, args) => {
        spawnCount += 1
        spawnedArgs = args
        ready = true
        return process
      },
      sleep: async () => {},
      now: () => 0,
    })

    const [first, second] = await Promise.all([runtime.start(), runtime.start()])

    expect(spawnCount).toBe(1)
    expect(spawnedArgs).toEqual(['main.py', '--port', '8188', '--listen', '127.0.0.1'])
    expect(first.ok).toBe(false)
    expect(second).toEqual(first)
    if (!first.ok) expect(first.error).toContain('checkpoint')
  })

  it('captures stderr and exposes an actionable crash diagnostic', async () => {
    const logs: string[] = []
    const process = fakeProcess()
    const runtime = new ComfyRuntime(() => config, {
      existsSync: () => true,
      fetch: async () => response({}, false),
      spawn: () => {
        queueMicrotask(() => {
          process.emitStderr('CUDA initialization failed')
          process.emitExit(1)
        })
        return process
      },
      sleep: async () => {},
      now: () => 0,
      onLog: (message) => logs.push(message),
    })

    const result = await runtime.start()

    expect(result.ok).toBe(false)
    expect(logs).toContain('CUDA initialization failed')
    if (!result.ok) expect(result.error).toContain('CUDA initialization failed')
  })

  it('rejects an invalid ComfyUI base URL as a diagnostic instead of throwing', async () => {
    const runtime = new ComfyRuntime(() => ({ ...config, baseUrl: 'file:///unsafe' }), {
      existsSync: () => true,
      fetch: async () => response({}, false),
      spawn: () => fakeProcess(),
      sleep: async () => {},
      now: () => 0,
    })

    await expect(runtime.health()).resolves.toMatchObject({
      reachable: false,
      lastError: expect.stringContaining('base URL'),
    })
  })
})

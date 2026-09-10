import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRuntimeSmoke } from './smoke-runtime.mjs'

const temporaryPaths = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function environment() {
  const runtime = mkdtempSync(join(tmpdir(), 'pi-runtime smoke-'))
  temporaryPaths.push(runtime)
  mkdirSync(join(runtime, 'src/personal_harness'), { recursive: true })
  writeFileSync(join(runtime, 'src/personal_harness/remote_smoke.py'), '')
  return {
    PI_STUDIO_RUNTIME_PATH: runtime,
    PI_STUDIO_RUNTIME_PYTHON: join(runtime, 'python with spaces.exe'),
    PI_STUDIO_SMOKE_DEVICE_ID: 'pi-studio:validation-device',
    PI_STUDIO_SMOKE_WORKSPACE: 'D:\\Smoke workspace',
    PYTHONPATH: 'existing-python-path',
  }
}

describe('runtime smoke release gate', () => {
  it('requires an explicit device and workspace before any execution', () => {
    const run = vi.fn()
    expect(() => runRuntimeSmoke({}, run)).toThrow('PI_STUDIO_SMOKE_DEVICE_ID')
    expect(() => runRuntimeSmoke({ PI_STUDIO_SMOKE_DEVICE_ID: 'host' }, run)).toThrow('PI_STUDIO_SMOKE_WORKSPACE')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs from the runtime checkout with literal arguments and a bounded timeout', () => {
    const env = environment()
    const run = vi.fn(() => ({ status: 0 }))
    runRuntimeSmoke(env, run)
    expect(run).toHaveBeenCalledWith(env.PI_STUDIO_RUNTIME_PYTHON, [
      '-m', 'personal_harness.cli', 'smoke-pi-studio',
      '--device-id', env.PI_STUDIO_SMOKE_DEVICE_ID,
      '--workspace', env.PI_STUDIO_SMOKE_WORKSPACE,
      '--command', 'pwd',
    ], expect.objectContaining({
      cwd: env.PI_STUDIO_RUNTIME_PATH,
      shell: false,
      timeout: 180_000,
      env: expect.objectContaining({
        PYTHONPATH: `${join(env.PI_STUDIO_RUNTIME_PATH, 'src')}${delimiter}existing-python-path`,
      }),
    }))
  })

  it('fails when the runtime checkout lacks the smoke module', () => {
    const env = environment()
    const run = vi.fn()
    env.PI_STUDIO_RUNTIME_PATH = join(env.PI_STUDIO_RUNTIME_PATH, 'missing')
    expect(() => runRuntimeSmoke(env, run)).toThrow('Runtime smoke module not found')
    expect(run).not.toHaveBeenCalled()
  })

  it('enables file and durable resume checks only when requested', () => {
    const run = vi.fn(() => ({ status: 0 }))
    runRuntimeSmoke({ ...environment(), PI_STUDIO_SMOKE_FILES: '1' }, run)
    expect(run.mock.calls[0][1]).toContain('--file-roundtrip')
  })

  it.each([
    [{ status: 1 }, 'exit=1'],
    [{ status: null, signal: 'SIGTERM' }, 'signal=SIGTERM'],
    [{ error: new Error('ETIMEDOUT'), status: null }, 'ETIMEDOUT'],
  ])('blocks publication when the smoke process fails: %j', (result, message) => {
    expect(() => runRuntimeSmoke(environment(), () => result)).toThrow(message)
  })
})

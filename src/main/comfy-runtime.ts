import { spawn as nodeSpawn } from 'child_process'
import { existsSync as fsExistsSync } from 'fs'
import { join } from 'path'

export type ComfyRuntimeConfig = {
  baseUrl: string
  comfyDir: string
  pythonPath?: string
  launchArgs?: string[]
  checkpoint: string
  startupTimeoutMs?: number
  startupPollMs?: number
}

export type ComfyRuntimeProcess = {
  exitCode: number | null
  kill: (signal?: NodeJS.Signals | number) => boolean
  on: {
    (event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
  }
  stderr?: {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  }
  stdout?: {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  }
}

export type ComfyRuntimeHealth = {
  reachable: boolean
  managed: boolean
  checkpoint: string
  checkpointAvailable: boolean | null
  pythonVersion?: string
  torchVersion?: string
  deviceNames: string[]
  lastError?: string
}

export type ComfyRuntimeStartResult =
  | { ok: true; alreadyRunning: boolean; health: ComfyRuntimeHealth }
  | { ok: false; error: string; health: ComfyRuntimeHealth }

type RuntimeFetch = (input: string, init?: RequestInit) => Promise<Response>
type RuntimeSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: 'pipe'; windowsHide: boolean },
) => ComfyRuntimeProcess

export type ComfyRuntimeDependencies = {
  fetch: RuntimeFetch
  spawn: RuntimeSpawn
  existsSync: (path: string) => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  onLog?: (message: string) => void
}

const defaultDependencies: ComfyRuntimeDependencies = {
  fetch: (input, init) => fetch(input, init),
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  existsSync: fsExistsSync,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const DEFAULT_STARTUP_POLL_MS = 750
const HEALTH_TIMEOUT_MS = 1_500

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function checkpointNames(value: unknown): string[] | null {
  const names = (
    value as {
      CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } }
    }
  )?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? (names as string[])
    : null
}

function deviceNames(value: unknown): string[] {
  const devices = (value as { devices?: unknown })?.devices
  if (!Array.isArray(devices)) return []
  return devices
    .map((device) => {
      if (typeof device === 'string') return device
      if (device && typeof device === 'object' && 'name' in device) {
        return typeof device.name === 'string' ? device.name : null
      }
      return null
    })
    .filter((name): name is string => !!name)
}

function launchArgs(config: ComfyRuntimeConfig, port: string): string[] {
  const args = config.launchArgs?.length ? config.launchArgs : ['main.py', '--port', '{port}']
  return args.map((arg) => arg.replaceAll('{port}', port))
}

export function parseLaunchArgs(value: string): string[] {
  const tokens = value.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? []
  return tokens.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1)
    }
    return token
  })
}

export function defaultComfyPythonPath(config: Pick<ComfyRuntimeConfig, 'comfyDir' | 'pythonPath'>): string {
  return config.pythonPath?.trim() || join(config.comfyDir, '.venv', 'Scripts', 'python.exe')
}

export class ComfyRuntime {
  private readonly configProvider: () => ComfyRuntimeConfig
  private readonly deps: ComfyRuntimeDependencies
  private process: ComfyRuntimeProcess | null = null
  private startPromise: Promise<ComfyRuntimeStartResult> | null = null
  private lastError: string | undefined

  constructor(
    configProvider: () => ComfyRuntimeConfig,
    dependencies: Partial<ComfyRuntimeDependencies> = {},
  ) {
    this.configProvider = configProvider
    this.deps = { ...defaultDependencies, ...dependencies }
  }

  async health(): Promise<ComfyRuntimeHealth> {
    const config = this.configProvider()
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const managed = this.process?.exitCode === null
    const base: ComfyRuntimeHealth = {
      reachable: false,
      managed,
      checkpoint: config.checkpoint,
      checkpointAvailable: null,
      deviceNames: [],
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
    if (!baseUrl) {
      return { ...base, lastError: 'ComfyUI base URL must be an HTTP(S) URL without credentials or query parameters' }
    }

    const stats = await this.getJson(`${baseUrl}/system_stats`)
    if (!stats) return base

    const system = (stats as { system?: Record<string, unknown> }).system ?? {}
    const checkpointInfo = await this.getJson(`${baseUrl}/object_info/CheckpointLoaderSimple`)
    const names = checkpointInfo ? checkpointNames(checkpointInfo) : null
    this.lastError = undefined
    return {
      reachable: true,
      managed,
      checkpoint: config.checkpoint,
      checkpointAvailable: names ? names.includes(config.checkpoint) : null,
      pythonVersion: typeof system.python_version === 'string' ? system.python_version : undefined,
      torchVersion: typeof system.torch_version === 'string' ? system.torch_version : undefined,
      deviceNames: deviceNames(stats),
    }
  }

  async start(): Promise<ComfyRuntimeStartResult> {
    if (this.startPromise) return this.startPromise
    const promise = this.startInternal()
    this.startPromise = promise
    return promise.finally(() => {
      if (this.startPromise === promise) this.startPromise = null
    })
  }

  async stop(): Promise<{ ok: boolean; owned: boolean }> {
    const process = this.process
    if (!process) return { ok: false, owned: false }

    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        if (this.process === process) this.process = null
        resolve({ ok: true, owned: true })
      }
      process.on('exit', finish)
      process.kill('SIGTERM')
      setTimeout(finish, 1_500)
    })
  }

  private async startInternal(): Promise<ComfyRuntimeStartResult> {
    const config = this.configProvider()
    const initialHealth = await this.health()
    if (initialHealth.reachable) {
      if (initialHealth.checkpointAvailable === false) {
        return {
          ok: false,
          error: `找不到 checkpoint: ${config.checkpoint}`,
          health: initialHealth,
        }
      }
      return { ok: true, alreadyRunning: true, health: initialHealth }
    }

    const pythonPath = defaultComfyPythonPath(config)
    if (!this.deps.existsSync(pythonPath)) {
      return {
        ok: false,
        error: `找不到 ComfyUI Python 环境: ${pythonPath}`,
        health: initialHealth,
      }
    }

    const baseUrl = normalizeBaseUrl(config.baseUrl)
    if (!baseUrl) {
      return { ok: false, error: initialHealth.lastError ?? 'ComfyUI base URL is invalid', health: initialHealth }
    }
    const port = new URL(baseUrl).port || '8188'
    const process = this.deps.spawn(pythonPath, launchArgs(config, port), {
      cwd: config.comfyDir,
      stdio: 'pipe',
      windowsHide: true,
    })
    this.process = process
    this.lastError = undefined
    // Drain stdout so ComfyUI's verbose startup/runtime logs cannot fill the pipe
    // and block the managed process. Stderr remains attached for diagnostics.
    process.stdout?.on('data', () => undefined)
    process.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (!message) return
      this.lastError = message.slice(-2_000)
      this.deps.onLog?.(this.lastError)
    })
    process.on('error', (error) => {
      this.lastError = error.message
      this.deps.onLog?.(error.message)
    })
    process.on('exit', (code, signal) => {
      if (this.process === process) this.process = null
      if (code !== 0 && !this.lastError) {
        this.lastError = `ComfyUI 进程退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        this.deps.onLog?.(this.lastError)
      }
    })

    const deadline = this.deps.now() + (config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    while (this.deps.now() < deadline) {
      if (!this.process) {
        const health = await this.health()
        return {
          ok: false,
          error: this.lastError ?? 'ComfyUI 进程启动后立即退出',
          health,
        }
      }
      if (await this.isReachable(baseUrl)) {
        const health = await this.health()
        if (health.checkpointAvailable === false) {
          await this.stop()
          return {
            ok: false,
            error: `找不到 checkpoint: ${config.checkpoint}`,
            health: { ...health, managed: false },
          }
        }
        return { ok: true, alreadyRunning: false, health }
      }
      await this.deps.sleep(config.startupPollMs ?? DEFAULT_STARTUP_POLL_MS)
    }

    await this.stop()
    const health = await this.health()
    return {
      ok: false,
      error: `ComfyUI 启动超时(${Math.round((config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS) / 1000)}s)${
        this.lastError ? `: ${this.lastError}` : ''
      }`,
      health,
    }
  }

  private async isReachable(baseUrl: string): Promise<boolean> {
    return !!(await this.getJson(`${baseUrl}/system_stats`))
  }

  private async getJson(url: string): Promise<unknown | null> {
    try {
      const response = await this.deps.fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }
}

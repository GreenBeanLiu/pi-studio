import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { CompiledRunProfile } from './run-profile'

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024
const DEFAULT_TRIM_TO_BYTES = 5 * 1024 * 1024

type RuntimeProfileSummary = {
  kind: CompiledRunProfile['kind']
  cwd: string
  provider: string
  model: string | null
  sandboxMode: CompiledRunProfile['sandboxMode']
  security: CompiledRunProfile['security']
  profileDigest: string
}

export type RuntimeEventRecord =
  | {
      type: 'run.started'
      runId: string
      at: string
      profile: RuntimeProfileSummary
      audit?: Record<string, unknown>
    }
  | {
      type: 'runtime.event'
      runId: string
      at: string
      event: unknown
    }
  | {
      type: 'run.settled'
      runId: string
      at: string
      reason: 'agent_settled'
    }
  | {
      type: 'cleanup'
      runId: string
      at: string
      mode: 'dispose' | 'forceDispose'
      status: 'ok' | 'error'
      error?: string
    }

export type RuntimeEventRecorder = {
  append(record: RuntimeEventRecord): void | Promise<void>
}

export type JsonlRuntimeEventRecorderOptions = {
  maxBytes?: number
  trimToBytes?: number
}

export class JsonlRuntimeEventRecorder implements RuntimeEventRecorder {
  private readonly maxBytes: number
  private readonly trimToBytes: number

  constructor(
    private readonly filePath: string,
    options: JsonlRuntimeEventRecorderOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES
    this.trimToBytes = Math.min(options.trimToBytes ?? DEFAULT_TRIM_TO_BYTES, this.maxBytes)
  }

  append(record: RuntimeEventRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
    this.trimIfNeeded()
  }

  private trimIfNeeded(): void {
    let size = 0
    try {
      size = statSync(this.filePath).size
    } catch {
      return
    }
    if (size <= this.maxBytes) return

    const bytesToRead = Math.min(this.trimToBytes, size)
    const buffer = Buffer.alloc(bytesToRead)
    const fd = openSync(this.filePath, 'r')
    try {
      readSync(fd, buffer, 0, bytesToRead, size - bytesToRead)
    } finally {
      closeSync(fd)
    }
    const tail = buffer.toString('utf8').replace(/^[^\r\n]*(?:\r?\n|$)/, '')
    writeFileSync(this.filePath, tail, 'utf8')
  }
}

export function runtimeEventLogPath(userDataPath: string): string {
  return join(userDataPath, 'runtime-events.jsonl')
}

export function summarizeRuntimeProfile(profile: CompiledRunProfile): RuntimeProfileSummary {
  return {
    kind: profile.kind,
    cwd: profile.cwd,
    provider: profile.provider,
    model: profile.model ?? null,
    sandboxMode: profile.sandboxMode,
    security: profile.security,
    profileDigest: profile.profileDigest,
  }
}

export function runtimeEventTimestamp(): string {
  return new Date().toISOString()
}

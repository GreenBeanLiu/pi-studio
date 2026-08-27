import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { CompiledRunProfile } from './run-profile'

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

export class JsonlRuntimeEventRecorder implements RuntimeEventRecorder {
  constructor(private readonly filePath: string) {}

  append(record: RuntimeEventRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
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

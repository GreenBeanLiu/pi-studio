import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'
import type { RuntimeEventRecord } from './runtime-event-recorder'
import type { RuntimeEventLogSnapshot, RuntimeRunSummary } from '../shared/ipc/contract'

const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_MAX_RUNS = 20
const DEFAULT_MAX_EVENTS_PER_RUN = 20

export type RuntimeEventLogReadOptions = {
  maxBytes?: number
  maxRuns?: number
  maxEventsPerRun?: number
}

function readTail(filePath: string, maxBytes: number): { content: string; truncated: boolean } {
  const size = statSync(filePath).size
  const bytesToRead = Math.min(maxBytes, size)
  const buffer = Buffer.alloc(bytesToRead)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead)
  } finally {
    closeSync(fd)
  }
  return {
    content: buffer.toString('utf8'),
    truncated: size > bytesToRead,
  }
}

function recordType(value: unknown): RuntimeEventRecord['type'] | null {
  if (!value || typeof value !== 'object') return null
  const type = (value as { type?: unknown }).type
  return type === 'run.started' ||
    type === 'runtime.event' ||
    type === 'run.settled' ||
    type === 'cleanup'
    ? type
    : null
}

function eventType(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

function ensureRun(runs: Map<string, RuntimeRunSummary>, runId: string): RuntimeRunSummary {
  let run = runs.get(runId)
  if (run) return run
  run = {
    runId,
    kind: null,
    cwd: null,
    provider: null,
    model: null,
    sandboxMode: null,
    profileDigest: null,
    audit: null,
    startedAt: null,
    lastEventAt: null,
    settledAt: null,
    cleanup: null,
    eventCount: 0,
    lastEventType: null,
    recentEvents: [],
  }
  runs.set(runId, run)
  return run
}

function applyRecord(
  runs: Map<string, RuntimeRunSummary>,
  record: RuntimeEventRecord,
  maxEventsPerRun: number,
): void {
  const run = ensureRun(runs, record.runId)
  if (record.type === 'run.started') {
    run.kind = record.profile.kind
    run.cwd = record.profile.cwd
    run.provider = record.profile.provider
    run.model = record.profile.model
    run.sandboxMode = record.profile.sandboxMode
    run.profileDigest = record.profile.profileDigest
    run.audit = record.audit ?? null
    run.startedAt = record.at
    run.lastEventAt = record.at
    return
  }
  if (record.type === 'runtime.event') {
    const type = eventType(record.event)
    run.eventCount += 1
    run.lastEventAt = record.at
    run.lastEventType = type
    run.recentEvents.push({ at: record.at, type, event: record.event })
    if (run.recentEvents.length > maxEventsPerRun) run.recentEvents.shift()
    return
  }
  if (record.type === 'run.settled') {
    run.settledAt = record.at
    run.lastEventAt = record.at
    return
  }
  run.cleanup = {
    at: record.at,
    mode: record.mode,
    status: record.status,
    error: record.error ?? null,
  }
  run.lastEventAt = record.at
}

function parseRecord(line: string): RuntimeEventRecord | null {
  const parsed = JSON.parse(line) as unknown
  const type = recordType(parsed)
  if (!type) return null
  const record = parsed as { runId?: unknown; at?: unknown }
  if (typeof record.runId !== 'string' || typeof record.at !== 'string') return null
  return parsed as RuntimeEventRecord
}

export function readRuntimeEventLog(
  filePath: string,
  options: RuntimeEventLogReadOptions = {},
): RuntimeEventLogSnapshot {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
  const maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN
  if (!existsSync(filePath)) {
    return { path: filePath, runs: [], invalidLines: 0, truncated: false }
  }

  const runs = new Map<string, RuntimeRunSummary>()
  let invalidLines = 0
  let tail: { content: string; truncated: boolean }
  try {
    tail = readTail(filePath, maxBytes)
  } catch (error) {
    return {
      path: filePath,
      runs: [],
      invalidLines: 0,
      truncated: false,
      readError: error instanceof Error ? error.message : String(error),
    }
  }

  const content = tail.truncated ? tail.content.replace(/^[^\r\n]*(?:\r?\n|$)/, '') : tail.content
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = parseRecord(line)
      if (!record) {
        invalidLines += 1
        continue
      }
      applyRecord(runs, record, maxEventsPerRun)
    } catch {
      invalidLines += 1
    }
  }

  return {
    path: filePath,
    runs: [...runs.values()]
      .sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))
      .slice(0, maxRuns),
    invalidLines,
    truncated: tail.truncated,
  }
}

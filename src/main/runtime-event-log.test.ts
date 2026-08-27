import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRuntimeEventLog } from './runtime-event-log'
import type { RuntimeEventRecord } from './runtime-event-recorder'

let directory = ''

const started = {
  type: 'run.started',
  runId: 'run-1',
  at: '2026-08-27T00:00:00.000Z',
  profile: {
    kind: 'routine',
    cwd: 'D:\\repo',
    provider: 'openai',
    model: 'gpt-test',
    sandboxMode: null,
    security: {
      requested: 'full-access',
      filesystemMode: 'danger-full-access',
      networkMode: 'unrestricted',
      backend: 'host',
      enforcement: 'none',
      hostCodeExecution: false,
      reason: 'test',
    },
    profileDigest: 'digest',
  },
  audit: { routineId: 'routine-1' },
} satisfies RuntimeEventRecord

describe('readRuntimeEventLog', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'runtime-event-log-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('projects JSONL records into recent run summaries', () => {
    const filePath = join(directory, 'runtime-events.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify(started),
        JSON.stringify({
          type: 'runtime.event',
          runId: 'run-1',
          at: '2026-08-27T00:00:01.000Z',
          event: { type: 'agent_start' },
        } satisfies RuntimeEventRecord),
        JSON.stringify({
          type: 'runtime.event',
          runId: 'run-1',
          at: '2026-08-27T00:00:02.000Z',
          event: { type: 'agent_settled' },
        } satisfies RuntimeEventRecord),
        JSON.stringify({
          type: 'run.settled',
          runId: 'run-1',
          at: '2026-08-27T00:00:03.000Z',
          reason: 'agent_settled',
        } satisfies RuntimeEventRecord),
        JSON.stringify({
          type: 'cleanup',
          runId: 'run-1',
          at: '2026-08-27T00:00:04.000Z',
          mode: 'dispose',
          status: 'ok',
        } satisfies RuntimeEventRecord),
      ].join('\n') + '\n',
      'utf8',
    )

    expect(readRuntimeEventLog(filePath, { maxEventsPerRun: 1 })).toMatchObject({
      path: filePath,
      invalidLines: 0,
      truncated: false,
      runs: [
        {
          runId: 'run-1',
          kind: 'routine',
          cwd: 'D:\\repo',
          provider: 'openai',
          model: 'gpt-test',
          profileDigest: 'digest',
          audit: { routineId: 'routine-1' },
          startedAt: '2026-08-27T00:00:00.000Z',
          lastEventAt: '2026-08-27T00:00:04.000Z',
          settledAt: '2026-08-27T00:00:03.000Z',
          eventCount: 2,
          lastEventType: 'agent_settled',
          recentEvents: [
            {
              at: '2026-08-27T00:00:02.000Z',
              type: 'agent_settled',
              event: { type: 'agent_settled' },
            },
          ],
          cleanup: {
            at: '2026-08-27T00:00:04.000Z',
            mode: 'dispose',
            status: 'ok',
            error: null,
          },
        },
      ],
    })
  })

  it('counts invalid lines and keeps useful later records', () => {
    const filePath = join(directory, 'runtime-events.jsonl')
    writeFileSync(
      filePath,
      [
        '{broken',
        JSON.stringify({ type: 'unknown', runId: 'run-1', at: '2026-08-27T00:00:00.000Z' }),
        JSON.stringify({
          type: 'runtime.event',
          runId: 'run-1',
          at: '2026-08-27T00:00:01.000Z',
          event: { type: 'run_failed' },
        } satisfies RuntimeEventRecord),
      ].join('\n') + '\n',
      'utf8',
    )

    const snapshot = readRuntimeEventLog(filePath)

    expect(snapshot.invalidLines).toBe(2)
    expect(snapshot.runs).toMatchObject([
      {
        runId: 'run-1',
        kind: null,
        eventCount: 1,
        lastEventType: 'run_failed',
      },
    ])
  })

  it('returns an empty snapshot for a missing file', () => {
    const filePath = join(directory, 'missing.jsonl')

    expect(readRuntimeEventLog(filePath)).toEqual({
      path: filePath,
      runs: [],
      invalidLines: 0,
      truncated: false,
    })
  })
})

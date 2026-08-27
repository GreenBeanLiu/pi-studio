import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlRuntimeEventRecorder, type RuntimeEventRecord } from './runtime-event-recorder'

let directory = ''

const startedRecord: RuntimeEventRecord = {
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
}

describe('JsonlRuntimeEventRecorder', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'runtime-events-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates parent directories and appends one JSON record per line', () => {
    const filePath = join(directory, 'nested', 'runtime-events.jsonl')
    const recorder = new JsonlRuntimeEventRecorder(filePath)

    recorder.append(startedRecord)
    recorder.append({
      type: 'runtime.event',
      runId: 'run-1',
      at: '2026-08-27T00:00:01.000Z',
      event: { type: 'agent_settled' },
    })

    const lines = readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown)
    expect(lines).toEqual([
      startedRecord,
      {
        type: 'runtime.event',
        runId: 'run-1',
        at: '2026-08-27T00:00:01.000Z',
        event: { type: 'agent_settled' },
      },
    ])
  })
})

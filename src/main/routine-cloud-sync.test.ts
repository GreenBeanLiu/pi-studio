import { describe, expect, it } from 'vitest'
import {
  cloudStepId,
  pendingDeletesForCredential,
  routineRunPayload,
  routineWorkflowPayload,
} from './routine-cloud-sync'
import type { Routine, RoutineRun } from './routines'

const routine: Routine = {
  id: '8d0063db-6528-4f77-90a0-fb861a4f05e0',
  name: 'Article',
  input: 'AI topic',
  workspacePath: 'D:\\Works',
  schedule: { type: 'daily', time: '09:00' },
  enabled: true,
  notify: 'error',
  pushEachStep: true,
  createdAt: Date.UTC(2026, 6, 13),
  steps: [
    {
      id: 'e0840b63-1087-48d9-a99d-7a3224f854b4',
      name: 'Write',
      type: 'agent',
      prompt: 'draft',
    },
  ],
}

describe('routine cloud payloads', () => {
  it('maps legacy non-UUID step ids to stable UUIDs', () => {
    const first = cloudStepId(routine.id, '1783900277067-8zwuc3jc9hc')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(cloudStepId(routine.id, '1783900277067-8zwuc3jc9hc')).toBe(first)
    expect(cloudStepId(routine.id, routine.steps[0].id)).toBe(routine.steps[0].id)
  })

  it('maps the current routine shape without secrets', () => {
    expect(routineWorkflowPayload(routine)).toMatchObject({
      name: 'Article',
      input: 'AI topic',
      workspace_path: 'D:\\Works',
      notify_mode: 'error',
      push_each_step: true,
      steps: [{ id: routine.steps[0].id, type: 'agent', prompt: 'draft' }],
    })
  })

  it('maps completed runs and links step definitions', () => {
    const run: RoutineRun = {
      id: '58ce991c-f0b4-41f9-86e3-786cd643977a',
      routineId: routine.id,
      routineName: routine.name,
      startedAt: Date.UTC(2026, 6, 13, 1),
      endedAt: Date.UTC(2026, 6, 13, 1, 1),
      status: 'ok',
      triggerSource: 'schedule',
      summary: 'done',
      steps: [{ id: routine.steps[0].id, name: 'Write', status: 'ok', summary: 'done', durationMs: 1000 }],
    }
    expect(routineRunPayload(run, new Map([[routine.id, routine]]))).toMatchObject({
      workflow_id: routine.id,
      workflow_name: 'Article',
      status: 'ok',
      trigger_source: 'schedule',
      input_snapshot: 'AI topic',
      steps: [{ workflow_step_id: routine.steps[0].id, type: 'agent', duration_ms: 1000 }],
    })
  })
})

describe('delete outbox scoping', () => {
  it('only consumes intents for the active origin and installation', () => {
    const entries = [
      { origin: 'https://a.example', installationId: 'one', workflowId: 'a' },
      { origin: 'https://b.example', installationId: 'one', workflowId: 'b' },
      { origin: 'https://a.example', installationId: 'two', workflowId: 'c' },
      { origin: 'https://a.example', installationId: null, workflowId: 'pending' },
    ]
    expect(
      pendingDeletesForCredential(entries, { installationId: 'one', token: 'secret' }, 'https://a.example'),
    ).toEqual([entries[0]])
  })
})

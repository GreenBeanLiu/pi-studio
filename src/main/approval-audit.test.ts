import { appendFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalProjection } from '../shared/ipc/contract'
import { ApprovalAuditJournal } from './approval-audit'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ApprovalAuditJournal', () => {
  it('folds append-only approval records to their latest durable outcome', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-approval-'))
    tempRoots.push(root)
    const sessionFile = join(root, 'session.jsonl')
    const journal = new ApprovalAuditJournal()
    const pending = {
      id: 'approval-1',
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      correlation: { kind: 'tool-call', id: 'call-1' },
      tool: 'bash',
      action: 'execute',
      policy: { decision: 'ask', reason: 'verify changes' },
      title: 'Run command?',
      message: 'Command: pnpm test',
      command: 'pnpm test',
      createdAt: '2026-08-17T00:00:00.000Z',
      outcome: 'pending',
    } satisfies ApprovalProjection

    journal.append(sessionFile, pending)
    journal.append(sessionFile, {
      ...pending,
      outcome: 'allowed-once',
      resolvedAt: '2026-08-17T00:00:01.000Z',
    })

    expect(journal.load(sessionFile)).toEqual([
      {
        ...pending,
        outcome: 'allowed-once',
        resolvedAt: '2026-08-17T00:00:01.000Z',
      },
    ])
    expect(journal.pathFor(sessionFile).endsWith('.pi-studio-approval-audit')).toBe(true)

    journal.remove(sessionFile)
    expect(journal.load(sessionFile)).toEqual([])
  })

  it('loads legacy null call ids without dropping their audit history', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-approval-legacy-'))
    tempRoots.push(root)
    const sessionFile = join(root, 'session.jsonl')
    const journal = new ApprovalAuditJournal()
    appendFileSync(
      journal.pathFor(sessionFile),
      `${JSON.stringify({
        version: 1,
        approval: {
          id: 'legacy-approval',
          sessionId: 'session-1',
          runId: null,
          callId: null,
          tool: 'extension',
          action: 'external-side-effect',
          policy: { decision: 'ask' },
          title: 'Legacy',
          message: 'Old request',
          createdAt: '2026-08-17T00:00:00.000Z',
          outcome: 'pending',
        },
      })}\n`,
      'utf8',
    )

    expect(journal.load(sessionFile)).toMatchObject([
      {
        id: 'legacy-approval',
        callId: null,
        correlation: { kind: 'extension-request', id: 'legacy-approval' },
      },
    ])
  })
})

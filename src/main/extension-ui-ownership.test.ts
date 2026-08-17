import { describe, expect, it } from 'vitest'
import type { ApprovalProjection } from '../shared/ipc/contract'
import { canRespondToOwnedUiRequest, isBlockingExtensionUiMethod } from './extension-ui-ownership'

const pendingApproval = {
  id: 'approval-1',
  sessionId: 'session-1',
  runId: null,
  callId: null,
  correlation: { kind: 'extension-request', id: 'approval-1' },
  tool: 'extension',
  action: 'external-side-effect',
  policy: { decision: 'ask' },
  title: 'Confirm',
  message: 'Confirm?',
  createdAt: '2026-08-17T00:00:00.000Z',
  outcome: 'pending',
} satisfies ApprovalProjection

describe('extension UI ownership', () => {
  it('allows owned non-confirm requests without requiring an approval projection', () => {
    for (const method of ['select', 'input', 'editor'] as const) {
      expect(canRespondToOwnedUiRequest('session-1', method, undefined)).toBe(true)
    }
  })

  it('requires confirm requests to match a pending approval in the active session', () => {
    expect(canRespondToOwnedUiRequest('session-1', 'confirm', pendingApproval)).toBe(true)
    expect(canRespondToOwnedUiRequest('session-2', 'confirm', pendingApproval)).toBe(false)
    expect(
      canRespondToOwnedUiRequest('session-1', 'confirm', {
        ...pendingApproval,
        outcome: 'cancelled',
      }),
    ).toBe(false)
  })

  it('classifies every blocking method handled by the renderer', () => {
    expect(['confirm', 'select', 'input', 'editor'].every(isBlockingExtensionUiMethod)).toBe(true)
    expect(isBlockingExtensionUiMethod('notify')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  answerabilityFor,
  approvalPasses,
  describeDeniedApprovals,
  mergeApprovalPolicy,
  policyForRun,
  UnattendedApprovalGate,
} from './approval-gateway'

describe('approval policy', () => {
  it('treats every run without a user in front of it as unanswerable', () => {
    expect(answerabilityFor('chat')).toBe('interactive')
    expect(answerabilityFor('routine')).toBe('unattended')
    expect(answerabilityFor('code-model')).toBe('unattended')
    expect(answerabilityFor('blender-model')).toBe('unattended')
    expect(policyForRun('routine')).toMatchObject({ decision: 'deny' })
    expect(policyForRun('chat')).toEqual({ decision: 'ask' })
  })

  it('does not let a later allow re-open a gate an earlier rule closed', () => {
    expect(
      mergeApprovalPolicy([
        { decision: 'deny', reason: 'sandbox unavailable' },
        { decision: 'ask' },
      ]),
    ).toEqual({ decision: 'deny', reason: 'sandbox unavailable' })
  })

  it('keeps every denial reason when several rules refuse', () => {
    expect(
      mergeApprovalPolicy([
        { decision: 'deny', reason: 'unattended run' },
        { decision: 'deny', reason: 'network is not allowlisted' },
      ]),
    ).toEqual({ decision: 'deny', reason: 'unattended run network is not allowlisted' })
  })

  it('fails closed when no rule applied at all', () => {
    expect(mergeApprovalPolicy([])).toMatchObject({ decision: 'deny' })
  })

  it('opens only for an explicit allowed-once', () => {
    expect(approvalPasses('allowed-once')).toBe(true)
    for (const outcome of ['pending', 'rejected', 'cancelled', 'unavailable'] as const) {
      expect(approvalPasses(outcome)).toBe(false)
    }
  })
})

describe('UnattendedApprovalGate', () => {
  it('answers every blocking dialog method so the run cannot hang', () => {
    const gate = new UnattendedApprovalGate()
    for (const method of ['confirm', 'select', 'input', 'editor'] as const) {
      const answer = gate.answer({
        type: 'extension_ui_request',
        id: `${method}-1`,
        method,
        title: `${method} title`,
        message: 'please decide',
      })
      expect(answer?.response).toEqual({
        type: 'extension_ui_response',
        id: `${method}-1`,
        cancelled: true,
      })
      expect(answer?.denied).toMatchObject({ method, outcome: 'unavailable' })
    }
    expect(gate.denied()).toHaveLength(4)
  })

  it('leaves fire-and-forget requests and unrelated events alone', () => {
    const gate = new UnattendedApprovalGate()
    expect(
      gate.answer({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi' }),
    ).toBeNull()
    expect(
      gate.answer({ type: 'extension_ui_request', id: 's1', method: 'setStatus' }),
    ).toBeNull()
    expect(gate.answer({ type: 'agent_end', willRetry: false })).toBeNull()
    expect(gate.answer(null)).toBeNull()
    expect(gate.denied()).toHaveLength(0)
  })

  it('refuses to answer a request it cannot address', () => {
    const gate = new UnattendedApprovalGate()
    expect(gate.answer({ type: 'extension_ui_request', method: 'confirm', title: 'x' })).toBeNull()
    expect(gate.denied()).toHaveLength(0)
  })

  it('summarizes denials for the run report', () => {
    const gate = new UnattendedApprovalGate()
    gate.answer({
      type: 'extension_ui_request',
      id: 'c1',
      method: 'confirm',
      title: '运行命令 rm -rf build',
      message: 'Command: rm -rf build',
    })
    const summary = describeDeniedApprovals(gate.denied())
    expect(summary).toContain('已自动拒绝 1 个审批请求')
    expect(summary).toContain('运行命令 rm -rf build')
    expect(describeDeniedApprovals([])).toBe('')
  })
})

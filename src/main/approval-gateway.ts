import type { ExtensionUiResponse } from '../shared/ipc/contract'
import { isBlockingExtensionUiMethod, type BlockingExtensionUiMethod } from './extension-ui-ownership'
import type { RunProfileKind } from './run-profile'

/** Who, if anyone, can answer a blocking approval for a given run. */
export type ApprovalAnswerability = 'interactive' | 'unattended'

export type ApprovalPolicy = { decision: 'ask' } | { decision: 'deny'; reason: string }

export type ApprovalOutcome = 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export type DeniedApproval = {
  id: string
  method: BlockingExtensionUiMethod
  title: string
  message: string
  reason: string
  outcome: Extract<ApprovalOutcome, 'unavailable'>
  deniedAt: string
  /** Set when the denial could not be delivered, which leaves the run blocked. */
  deliveryError?: string
}

const UNATTENDED_KINDS = new Set<RunProfileKind>(['routine', 'code-model', 'blender-model'])

const UNATTENDED_REASON =
  'Unattended run: no one can answer this approval, so it is denied instead of blocking the run.'

/**
 * Only a chat has a user in front of it. Every other run profile is started by a
 * schedule or a generator, so it must never wait on a dialog nobody will see.
 */
export function answerabilityFor(kind: RunProfileKind): ApprovalAnswerability {
  return UNATTENDED_KINDS.has(kind) ? 'unattended' : 'interactive'
}

/**
 * Monotonic merge: a deny is a guard, not a vote. Later rules may add reasons but
 * can never re-open a gate an earlier rule closed, and an empty rule set stays closed.
 */
export function mergeApprovalPolicy(policies: readonly ApprovalPolicy[]): ApprovalPolicy {
  if (policies.length === 0) {
    return { decision: 'deny', reason: 'No approval policy applied to this request.' }
  }
  const denials = policies.filter(
    (policy): policy is Extract<ApprovalPolicy, { decision: 'deny' }> => policy.decision === 'deny',
  )
  if (denials.length === 0) return { decision: 'ask' }
  return { decision: 'deny', reason: denials.map((policy) => policy.reason).join(' ') }
}

/** Only an explicit allowed-once opens the gate; absent, failed and unknown answers stay closed. */
export function approvalPasses(outcome: ApprovalOutcome): boolean {
  return outcome === 'allowed-once'
}

export function policyForRun(kind: RunProfileKind): ApprovalPolicy {
  return answerabilityFor(kind) === 'unattended'
    ? { decision: 'deny', reason: UNATTENDED_REASON }
    : { decision: 'ask' }
}

function stringField(event: Record<string, unknown>, name: string): string {
  return typeof event[name] === 'string' ? event[name] : ''
}

/**
 * Answers the blocking extension dialogs of an unattended run.
 *
 * Pi's RPC `confirm`/`select`/`input`/`editor` dialogs stay pending until the host
 * writes a response — `editor` has no timeout or abort path at all. Without an
 * answerer the whole run hangs until its outer deadline and then reports a timeout
 * that says nothing about the real cause, so the gate denies each request as soon
 * as it arrives and keeps the record for the run report.
 */
export class UnattendedApprovalGate {
  private readonly denials: DeniedApproval[] = []

  constructor(private readonly reason = UNATTENDED_REASON) {}

  /** The response to write back, or null when the request needs no answer. */
  answer(
    event: unknown,
    now = new Date().toISOString(),
  ): { response: ExtensionUiResponse; denied: DeniedApproval } | null {
    if (!event || typeof event !== 'object') return null
    const candidate = event as Record<string, unknown>
    if (candidate.type !== 'extension_ui_request') return null
    if (!isBlockingExtensionUiMethod(candidate.method)) return null
    const id = stringField(candidate, 'id')
    if (!id) return null
    const denied: DeniedApproval = {
      id,
      method: candidate.method,
      title: stringField(candidate, 'title'),
      message: stringField(candidate, 'message'),
      reason: this.reason,
      outcome: 'unavailable',
      deniedAt: now,
    }
    this.denials.push(denied)
    // `cancelled` is the one response every blocking method understands: confirm
    // resolves false, and select/input/editor resolve undefined.
    return { response: { type: 'extension_ui_response', id, cancelled: true }, denied }
  }

  /** A denial that never reached Pi still leaves the run blocked, so it stays visible. */
  recordDeliveryFailure(id: string, error: string): void {
    const denial = this.denials.find((item) => item.id === id)
    if (denial) denial.deliveryError = error
  }

  denied(): readonly DeniedApproval[] {
    return this.denials
  }
}

export function describeDeniedApprovals(denials: readonly DeniedApproval[]): string {
  if (denials.length === 0) return ''
  const lines = denials.map((denial) => {
    const label = denial.title || denial.message || denial.id
    return denial.deliveryError
      ? `- ${denial.method}: ${label}(拒绝未送达:${denial.deliveryError})`
      : `- ${denial.method}: ${label}`
  })
  return [`已自动拒绝 ${denials.length} 个审批请求(无人值守运行无法应答):`, ...lines].join('\n')
}

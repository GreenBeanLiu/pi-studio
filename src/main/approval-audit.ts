import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs'
import type { ApprovalProjection } from '../shared/ipc/contract'

type ApprovalAuditEntry = {
  version: 2
  approval: ApprovalProjection
}

function normalizeApproval(value: unknown): ApprovalProjection | null {
  if (!value || typeof value !== 'object') return null
  const approval = value as Partial<ApprovalProjection>
  const valid =
    typeof approval.id === 'string' &&
    typeof approval.sessionId === 'string' &&
    (approval.callId === null || typeof approval.callId === 'string') &&
    typeof approval.tool === 'string' &&
    typeof approval.action === 'string' &&
    !!approval.policy &&
    approval.policy.decision === 'ask' &&
    typeof approval.title === 'string' &&
    typeof approval.message === 'string' &&
    typeof approval.createdAt === 'string' &&
    typeof approval.outcome === 'string'
  if (!valid) return null
  const correlation = approval.correlation
  const normalizedCorrelation =
    correlation &&
    (correlation.kind === 'tool-call' || correlation.kind === 'extension-request') &&
    typeof correlation.id === 'string'
      ? correlation
      : approval.callId
        ? { kind: 'tool-call' as const, id: approval.callId }
        : { kind: 'extension-request' as const, id: approval.id }
  return { ...approval, correlation: normalizedCorrelation } as ApprovalProjection
}

/** Append-only host audit for extension approvals that Pi's message history does not persist. */
export class ApprovalAuditJournal {
  pathFor(sessionFile: string): string {
    return `${sessionFile}.pi-studio-approval-audit`
  }

  append(sessionFile: string, approval: ApprovalProjection): void {
    const entry: ApprovalAuditEntry = { version: 2, approval }
    appendFileSync(this.pathFor(sessionFile), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  remove(sessionFile: string): void {
    rmSync(this.pathFor(sessionFile), { force: true })
  }

  load(sessionFile: string): ApprovalProjection[] {
    const path = this.pathFor(sessionFile)
    if (!existsSync(path)) return []
    const latest = new Map<string, ApprovalProjection>()
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as { version?: unknown; approval?: unknown }
        if (entry.version !== 1 && entry.version !== 2) continue
        const approval = normalizeApproval(entry.approval)
        if (!approval) continue
        latest.delete(approval.id)
        latest.set(approval.id, approval)
      } catch {
        // A truncated final line must not hide the earlier valid audit trail.
      }
    }
    return [...latest.values()].reverse()
  }
}

export const approvalAuditJournal = new ApprovalAuditJournal()

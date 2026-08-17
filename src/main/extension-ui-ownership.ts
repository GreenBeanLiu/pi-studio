import type { ApprovalProjection } from '../shared/ipc/contract'

export type BlockingExtensionUiMethod = 'confirm' | 'select' | 'input' | 'editor'

const BLOCKING_METHODS = new Set<BlockingExtensionUiMethod>([
  'confirm',
  'select',
  'input',
  'editor',
])

export function isBlockingExtensionUiMethod(
  value: unknown,
): value is BlockingExtensionUiMethod {
  return typeof value === 'string' && BLOCKING_METHODS.has(value as BlockingExtensionUiMethod)
}

export function canRespondToOwnedUiRequest(
  sessionId: string | null,
  requestMethod: BlockingExtensionUiMethod | null,
  approval: ApprovalProjection | undefined,
): boolean {
  if (!sessionId || !requestMethod) return false
  if (requestMethod !== 'confirm') return true
  return approval?.sessionId === sessionId && approval.outcome === 'pending'
}

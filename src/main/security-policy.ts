import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

export type SecurityPolicy = {
  commandAllowlist: string[]
  commandBlocklist: string[]
  writeAllowlist: string[]
  writeBlocklist: string[]
  requireConfirmationForDangerousCommands: boolean
  blockProtectedPaths: boolean
  blockOutsideWorkspace: boolean
}

type SecurityPolicyStore = {
  default: SecurityPolicy
  workspaces: Record<string, SecurityPolicy>
}

export type SecurityPolicyLoadResult = {
  scope: 'default' | 'workspace'
  workspacePath?: string
  policy: SecurityPolicy
}

export type SecurityPolicyRuleTarget =
  | 'commandAllowlist'
  | 'commandBlocklist'
  | 'writeAllowlist'
  | 'writeBlocklist'

const SECURITY_POLICY_RULE_TARGETS = new Set<SecurityPolicyRuleTarget>([
  'commandAllowlist',
  'commandBlocklist',
  'writeAllowlist',
  'writeBlocklist',
])

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  commandAllowlist: [],
  commandBlocklist: [],
  writeAllowlist: [],
  writeBlocklist: [],
  requireConfirmationForDangerousCommands: true,
  blockProtectedPaths: true,
  blockOutsideWorkspace: true,
}

export function securityPolicyStorePath(): string {
  return join(app.getPath('userData'), 'security-policies.json')
}

function normalizePolicy(value: unknown): SecurityPolicy {
  const raw = value && typeof value === 'object' ? (value as Partial<SecurityPolicy>) : {}
  return {
    commandAllowlist: Array.isArray(raw.commandAllowlist)
      ? raw.commandAllowlist.filter((item): item is string => typeof item === 'string')
      : DEFAULT_SECURITY_POLICY.commandAllowlist,
    commandBlocklist: Array.isArray(raw.commandBlocklist)
      ? raw.commandBlocklist.filter((item): item is string => typeof item === 'string')
      : DEFAULT_SECURITY_POLICY.commandBlocklist,
    writeAllowlist: Array.isArray(raw.writeAllowlist)
      ? raw.writeAllowlist.filter((item): item is string => typeof item === 'string')
      : DEFAULT_SECURITY_POLICY.writeAllowlist,
    writeBlocklist: Array.isArray(raw.writeBlocklist)
      ? raw.writeBlocklist.filter((item): item is string => typeof item === 'string')
      : DEFAULT_SECURITY_POLICY.writeBlocklist,
    requireConfirmationForDangerousCommands:
      typeof raw.requireConfirmationForDangerousCommands === 'boolean'
        ? raw.requireConfirmationForDangerousCommands
        : DEFAULT_SECURITY_POLICY.requireConfirmationForDangerousCommands,
    blockProtectedPaths:
      typeof raw.blockProtectedPaths === 'boolean'
        ? raw.blockProtectedPaths
        : DEFAULT_SECURITY_POLICY.blockProtectedPaths,
    blockOutsideWorkspace:
      typeof raw.blockOutsideWorkspace === 'boolean'
        ? raw.blockOutsideWorkspace
        : DEFAULT_SECURITY_POLICY.blockOutsideWorkspace,
  }
}

function loadStore(): SecurityPolicyStore {
  const file = securityPolicyStorePath()
  if (!existsSync(file)) return { default: DEFAULT_SECURITY_POLICY, workspaces: {} }

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SecurityPolicyStore>
    const workspaces: Record<string, SecurityPolicy> = {}
    for (const [path, policy] of Object.entries(raw.workspaces ?? {})) {
      workspaces[path] = normalizePolicy(policy)
    }
    return {
      default: normalizePolicy(raw.default),
      workspaces,
    }
  } catch {
    return { default: DEFAULT_SECURITY_POLICY, workspaces: {} }
  }
}

function saveStore(store: SecurityPolicyStore): void {
  const file = securityPolicyStorePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8')
}

export function loadSecurityPolicy(workspacePath?: string | null): SecurityPolicyLoadResult {
  const store = loadStore()
  if (workspacePath) {
    return {
      scope: 'workspace',
      workspacePath,
      policy: store.workspaces[workspacePath] ?? store.default,
    }
  }

  return {
    scope: 'default',
    policy: store.default,
  }
}

export function saveSecurityPolicy(
  policy: SecurityPolicy,
  workspacePath?: string | null,
): SecurityPolicyLoadResult {
  const store = loadStore()
  const normalized = normalizePolicy(policy)

  if (workspacePath) {
    store.workspaces[workspacePath] = normalized
    saveStore(store)
    return { scope: 'workspace', workspacePath, policy: normalized }
  }

  store.default = normalized
  saveStore(store)
  return { scope: 'default', policy: normalized }
}

export function appendSecurityPolicyRule(
  target: SecurityPolicyRuleTarget,
  rule: string,
  workspacePath?: string | null,
): SecurityPolicyLoadResult {
  const cleanRule = rule.trim()
  if (!cleanRule) throw new Error('Security policy rule cannot be empty')
  if (!SECURITY_POLICY_RULE_TARGETS.has(target)) {
    throw new Error(`Invalid security policy rule target: ${String(target)}`)
  }

  const store = loadStore()
  const current = workspacePath ? store.workspaces[workspacePath] ?? store.default : store.default
  const next = normalizePolicy(current)
  if (!next[target].some((item) => item.toLowerCase() === cleanRule.toLowerCase())) {
    next[target] = [...next[target], cleanRule]
  }

  if (workspacePath) {
    store.workspaces[workspacePath] = next
    saveStore(store)
    return { scope: 'workspace', workspacePath, policy: next }
  }

  store.default = next
  saveStore(store)
  return { scope: 'default', policy: next }
}

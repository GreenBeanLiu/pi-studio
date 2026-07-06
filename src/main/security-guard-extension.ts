import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { agentConfigDir } from './settings'
import { securityPolicyStorePath } from './security-policy'

function buildExtensionSource(policyFile: string): string {
  return `import * as fs from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const POLICY_FILE = ${JSON.stringify(policyFile)}

type SecurityPolicy = {
  commandAllowlist: string[]
  commandBlocklist: string[]
  writeAllowlist: string[]
  writeBlocklist: string[]
  requireConfirmationForDangerousCommands: boolean
  blockProtectedPaths: boolean
  blockOutsideWorkspace: boolean
}

const DEFAULT_POLICY: SecurityPolicy = {
  commandAllowlist: [],
  commandBlocklist: [],
  writeAllowlist: [],
  writeBlocklist: [],
  requireConfirmationForDangerousCommands: true,
  blockProtectedPaths: true,
  blockOutsideWorkspace: true,
}

function normalize(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = normalize(path.resolve(parent))
  const normalizedChild = normalize(path.resolve(child))
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep)
}

function getToolPath(input: Record<string, unknown>): string {
  return String(input.path ?? input.file_path ?? '')
}

function cleanRules(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : []
}

function normalizePolicy(value: unknown): SecurityPolicy {
  const raw = value && typeof value === 'object' ? value as Partial<SecurityPolicy> : {}
  return {
    commandAllowlist: cleanRules(raw.commandAllowlist),
    commandBlocklist: cleanRules(raw.commandBlocklist),
    writeAllowlist: cleanRules(raw.writeAllowlist),
    writeBlocklist: cleanRules(raw.writeBlocklist),
    requireConfirmationForDangerousCommands:
      typeof raw.requireConfirmationForDangerousCommands === 'boolean'
        ? raw.requireConfirmationForDangerousCommands
        : DEFAULT_POLICY.requireConfirmationForDangerousCommands,
    blockProtectedPaths:
      typeof raw.blockProtectedPaths === 'boolean'
        ? raw.blockProtectedPaths
        : DEFAULT_POLICY.blockProtectedPaths,
    blockOutsideWorkspace:
      typeof raw.blockOutsideWorkspace === 'boolean'
        ? raw.blockOutsideWorkspace
        : DEFAULT_POLICY.blockOutsideWorkspace,
  }
}

function loadPolicy(cwd: string): SecurityPolicy {
  try {
    if (!fs.existsSync(POLICY_FILE)) return DEFAULT_POLICY
    const store = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf-8')) as {
      default?: unknown
      workspaces?: Record<string, unknown>
    }
    return normalizePolicy(store.workspaces?.[cwd] ?? store.default)
  } catch {
    return DEFAULT_POLICY
  }
}

function ruleTextMatches(value: string, rules: string[]): string | undefined {
  const normalized = value.toLowerCase()
  return rules.find((rule) => normalized.includes(rule.toLowerCase()))
}

function commandAllowed(command: string, rules: string[]): boolean {
  const normalized = command.trim().toLowerCase()
  return rules.some((rule) => normalized.startsWith(rule.toLowerCase()))
}

function resolvePolicyPath(cwd: string, rule: string): string {
  return path.isAbsolute(rule) ? path.resolve(rule) : path.resolve(cwd, rule)
}

function pathRuleMatches(cwd: string, filePath: string, rules: string[]): string | undefined {
  return rules.find((rule) => {
    const resolvedRule = resolvePolicyPath(cwd, rule)
    return isInside(resolvedRule, filePath)
  })
}

function isProtectedPath(filePath: string): boolean {
  const normalized = normalize(filePath).replace(/\\\\/g, '/')
  const base = path.basename(normalized)
  const segments = normalized.split('/').filter(Boolean)

  if (segments.includes('.git')) return true
  if (segments.includes('node_modules')) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.pfx')) return true
  if (base === 'id_rsa' || base === 'id_ed25519') return true
  if (base.includes('secret') || base.includes('token')) return true

  return false
}

const dangerousCommandPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\\brm\\s+(?:-[^\\n\\r]*[rf][^\\n\\r]*|--recursive|--force)/i, reason: 'recursive/force rm is blocked' },
  { pattern: /\\bRemove-Item\\b[^\\n\\r]*(?:-Recurse|-Force)/i, reason: 'recursive/force Remove-Item is blocked' },
  { pattern: /\\brmdir\\b[^\\n\\r]*(?:\\/s|\\/q)/i, reason: 'recursive rmdir is blocked' },
  { pattern: /\\bdel\\b[^\\n\\r]*(?:\\/s|\\/q)/i, reason: 'recursive/quiet del is blocked' },
  { pattern: /\\bsudo\\b|\\bsu\\s+-/i, reason: 'privilege escalation is blocked' },
  { pattern: /\\b(chmod|chown)\\b[^\\n\\r]*(?:777|-R|--recursive)/i, reason: 'broad chmod/chown is blocked' },
  { pattern: /\\bSet-ExecutionPolicy\\b/i, reason: 'changing PowerShell execution policy is blocked' },
  { pattern: /\\breg\\s+delete\\b/i, reason: 'registry deletion is blocked' },
  { pattern: /\\bformat\\s+[A-Z]:/i, reason: 'format command is blocked' },
  { pattern: /\\btaskkill\\b[^\\n\\r]*\\/f/i, reason: 'forced taskkill is blocked' },
]

export default function piStudioGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const policy = loadPolicy(ctx.cwd)

    if (event.toolName === 'write' || event.toolName === 'edit') {
      const rawPath = getToolPath(event.input as Record<string, unknown>)
      if (!rawPath) return undefined

      const resolved = path.resolve(ctx.cwd, rawPath)
      if (policy.blockOutsideWorkspace && !isInside(ctx.cwd, resolved)) {
        return {
          block: true,
          reason: 'pi-studio guard: file write outside the current workspace is blocked',
        }
      }

      const blockedRule = pathRuleMatches(ctx.cwd, resolved, policy.writeBlocklist)
      if (blockedRule) {
        return {
          block: true,
          reason: 'pi-studio guard: file write blocked by policy rule: ' + blockedRule,
        }
      }

      const allowedRule = pathRuleMatches(ctx.cwd, resolved, policy.writeAllowlist)
      if (allowedRule) return undefined

      if (policy.blockProtectedPaths && isProtectedPath(resolved)) {
        return {
          block: true,
          reason: 'pi-studio guard: writes to protected paths or secret-like files are blocked',
        }
      }
    }

    if (event.toolName === 'bash') {
      const command = String((event.input as Record<string, unknown>).command ?? '')
      const blockedRule = ruleTextMatches(command, policy.commandBlocklist)
      if (blockedRule) {
        return {
          block: true,
          reason: 'pi-studio guard: command blocked by policy rule: ' + blockedRule,
        }
      }

      if (commandAllowed(command, policy.commandAllowlist)) return undefined
      if (!policy.requireConfirmationForDangerousCommands) return undefined

      for (const rule of dangerousCommandPatterns) {
        if (rule.pattern.test(command)) {
          const approved = await ctx.ui.confirm(
            '确认危险命令',
            'Pi Studio 识别到高风险命令：\\n\\n' +
              command +
              '\\n\\n原因：' +
              rule.reason +
              '\\n\\n只有确认后才会继续执行。',
            { timeout: 120000 },
          )

          if (approved) return undefined

          return { block: true, reason: 'pi-studio guard: dangerous command rejected by user' }
        }
      }
    }

    return undefined
  })
}
`
}

export function syncSecurityGuardExtension(enabled: boolean): void {
  const dir = join(agentConfigDir(), 'extensions')
  const file = join(dir, 'pi-studio-guard.ts')

  if (!enabled) {
    if (existsSync(file)) rmSync(file)
    return
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, buildExtensionSource(securityPolicyStorePath()), 'utf-8')
}

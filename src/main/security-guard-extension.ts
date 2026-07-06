import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { agentConfigDir } from './settings'

const EXTENSION_SOURCE = `import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

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
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const rawPath = getToolPath(event.input as Record<string, unknown>)
      if (!rawPath) return undefined

      const resolved = path.resolve(ctx.cwd, rawPath)
      if (!isInside(ctx.cwd, resolved)) {
        return {
          block: true,
          reason: 'pi-studio guard: file write outside the current workspace is blocked',
        }
      }

      if (isProtectedPath(resolved)) {
        return {
          block: true,
          reason: 'pi-studio guard: writes to protected paths or secret-like files are blocked',
        }
      }
    }

    if (event.toolName === 'bash') {
      const command = String((event.input as Record<string, unknown>).command ?? '')
      for (const rule of dangerousCommandPatterns) {
        if (rule.pattern.test(command)) {
          return { block: true, reason: 'pi-studio guard: ' + rule.reason }
        }
      }
    }

    return undefined
  })
}
`

export function syncSecurityGuardExtension(enabled: boolean): void {
  const dir = join(agentConfigDir(), 'extensions')
  const file = join(dir, 'pi-studio-guard.ts')

  if (!enabled) {
    if (existsSync(file)) rmSync(file)
    return
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, EXTENSION_SOURCE, 'utf-8')
}

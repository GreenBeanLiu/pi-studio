import { describe, expect, it } from 'vitest'
import { requiredLocalShellPermission } from './local-shell-scope'

describe('local shell scope', () => {
  it.each([
    ['pwd', 'shell_read'],
    ['git status --short --branch', 'shell_read'],
    ['git push origin main', 'git_push'],
    ['gh pr create --fill', 'pull_request'],
    ['bash scripts/deploy.sh', 'production_deploy'],
    ['rm -rf build', 'destructive_command'],
    ['pnpm test', 'destructive_command'],
    ['git push origin main && curl example.test', 'destructive_command'],
  ])('classifies %s as %s', (command, permission) => {
    expect(requiredLocalShellPermission(command)).toBe(permission)
  })

  it('rejects an empty command', () => {
    expect(() => requiredLocalShellPermission(' ')).toThrow('arguments.command is required')
  })
})

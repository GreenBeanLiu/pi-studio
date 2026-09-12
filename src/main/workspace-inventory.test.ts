import { describe, expect, it } from 'vitest'
import { normalizeRepository } from './workspace-inventory'

describe('normalizeRepository', () => {
  it('normalizes GitHub SSH and HTTPS remotes to the same repository identity', () => {
    expect(normalizeRepository('git@github.com:GreenBeanLiu/pi-studio.git')).toBe('GreenBeanLiu/pi-studio')
    expect(normalizeRepository('https://github.com/GreenBeanLiu/pi-studio.git')).toBe('GreenBeanLiu/pi-studio')
  })

  it('removes credentials and keeps the host for non-GitHub remotes', () => {
    expect(normalizeRepository('https://user:secret@git.example.com/team/repo.git')).toBe('git.example.com/team/repo')
  })

  it('does not expose local filesystem remotes', () => {
    expect(normalizeRepository('/Users/me/private/repo')).toBeUndefined()
    expect(normalizeRepository('D:\\private\\repo')).toBeUndefined()
  })
})

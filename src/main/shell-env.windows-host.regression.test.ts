import { describe, expect, it } from 'vitest'
import { commonBinDirs, computeUserPath } from './shell-env'

describe('macOS shell environment on a Windows development host', () => {
  it('keeps POSIX PATH separators and home-relative paths', () => {
    const path = computeUserPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      home: '/Users/me',
      readLoginShellPath: () => '/Users/me/.volta/bin:/usr/bin',
    })

    expect(path.split(':')).toEqual(
      expect.arrayContaining(['/Users/me/.volta/bin', '/usr/bin', '/opt/homebrew/bin']),
    )
    expect(commonBinDirs('/Users/me')).toContain('/Users/me/.local/bin')
    expect(path).not.toContain(';')
    expect(path).not.toContain('\\Users\\me')
  })
})

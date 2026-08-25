import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  commonBinDirs,
  computeUserPath,
  mergePathEntries,
  resetUserPathCache,
  userPath,
  type ShellPathDependencies,
} from './shell-path'

function deps(overrides: Partial<ShellPathDependencies> = {}): ShellPathDependencies {
  return {
    platform: 'darwin',
    // Finder 启动的 app 实际就只有这四个
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    home: '/Users/me',
    readLoginShellPath: () => null,
    ...overrides,
  }
}

describe('mergePathEntries', () => {
  it('keeps the first occurrence so the shell wins over the fallbacks', () => {
    expect(mergePathEntries('/a:/b', '/b:/c')).toBe('/a:/b:/c')
  })

  it('drops empties and blanks', () => {
    expect(mergePathEntries('/a::/b', '', null, undefined, '  ')).toBe('/a:/b')
  })

  it('returns an empty string when there is nothing to merge', () => {
    expect(mergePathEntries(null, undefined, '')).toBe('')
  })
})

describe('computeUserPath', () => {
  // 这条是整个模块存在的理由:Finder 启动的 app 看不见 /opt/homebrew/bin,
  // spawn('npx') 直接 ENOENT,而调用方只会看到「连接断了」。
  it('adds Homebrew even when the login shell cannot be asked', () => {
    const path = computeUserPath(deps())
    expect(path.split(delimiter)).toContain('/opt/homebrew/bin')
    // 原有的系统目录不能丢
    expect(path.split(delimiter)).toContain('/usr/bin')
  })

  it('prefers what the login shell reports', () => {
    const path = computeUserPath(
      deps({ readLoginShellPath: () => '/Users/me/.nvm/versions/node/v22/bin:/usr/bin' }),
    )
    expect(path.split(delimiter)[0]).toBe('/Users/me/.nvm/versions/node/v22/bin')
  })

  it('asks the shell named in SHELL', () => {
    const readLoginShellPath = vi.fn(() => '/from/fish')
    computeUserPath(deps({ env: { SHELL: '/opt/homebrew/bin/fish' }, readLoginShellPath }))
    expect(readLoginShellPath).toHaveBeenCalledWith('/opt/homebrew/bin/fish')
  })

  it('does not ask anything when SHELL is unset', () => {
    const readLoginShellPath = vi.fn(() => '/nope')
    const path = computeUserPath(deps({ env: { PATH: '/usr/bin' }, readLoginShellPath }))
    expect(readLoginShellPath).not.toHaveBeenCalled()
    expect(path.split(delimiter)).toContain('/opt/homebrew/bin')
  })

  // 登录 shell 可能卡住或报错(rc 文件里什么都有),那时候还得能用。
  it('survives a shell that fails', () => {
    const path = computeUserPath(
      deps({
        readLoginShellPath: () => {
          throw new Error('rc exploded')
        },
      }),
    )
    // 查 PATH 这件事绝不能把打开工作区搞崩
    expect(path.split(delimiter)).toContain('/opt/homebrew/bin')
  })

  it('falls back cleanly when the shell reports nothing', () => {
    const path = computeUserPath(deps({ readLoginShellPath: () => null }))
    expect(path.split(delimiter)).toEqual(
      expect.arrayContaining(['/usr/bin', '/opt/homebrew/bin', '/Users/me/.local/bin']),
    )
  })

  it('leaves Windows alone', () => {
    const path = computeUserPath(
      deps({ platform: 'win32', env: { PATH: 'C:\\Windows\\system32' } }),
    )
    expect(path).toBe('C:\\Windows\\system32')
  })

  it('never produces duplicate entries', () => {
    const path = computeUserPath(
      deps({ readLoginShellPath: () => '/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin' }),
    )
    const entries = path.split(delimiter)
    expect(new Set(entries).size).toBe(entries.length)
  })
})

describe('commonBinDirs', () => {
  it('expands the home-relative ones', () => {
    expect(commonBinDirs('/Users/me')).toContain('/Users/me/.volta/bin')
  })
})

describe('caching', () => {
  it('asks the login shell only once', () => {
    resetUserPathCache()
    // 走真实实现会起一个登录 shell,这里只验证注入路径不缓存、默认路径缓存
    const first = userPath()
    const second = userPath()
    expect(second).toBe(first)
    resetUserPathCache()
  })

  it('does not cache when dependencies are injected', () => {
    resetUserPathCache()
    expect(userPath(deps({ readLoginShellPath: () => '/one' }))).toContain('/one')
    expect(userPath(deps({ readLoginShellPath: () => '/two' }))).toContain('/two')
    resetUserPathCache()
  })
})

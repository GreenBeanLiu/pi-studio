import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  INHERITED_ENV_KEYS,
  commonBinDirs,
  computeInheritedEnv,
  computeUserPath,
  parseScutilProxy,
  systemProxyEnv,
  userShellEnv,
  mergePathEntries,
  resetUserPathCache,
  userPath,
  type ShellPathDependencies,
} from './shell-env'

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

  // launchd 的 GUI 域里 SHELL 可能是空的,而那正是我们要救的场景 ——
  // 跳过探测的话代理变量永远补不回来。退到 macOS 默认 shell。
  it('falls back to the default shell when SHELL is unset', () => {
    const readLoginShellPath = vi.fn(() => '/from/default/shell')
    const path = computeUserPath(deps({ env: { PATH: '/usr/bin' }, readLoginShellPath }))
    expect(readLoginShellPath).toHaveBeenCalledWith('/bin/zsh')
    expect(path.split(delimiter)[0]).toBe('/from/default/shell')
  })

  it('also recovers the proxy when SHELL is unset', () => {
    const vars = computeInheritedEnv(
      deps({ env: {}, readLoginShellVars: () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }) }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
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

// 2026-08-25:从 Finder 启动的 app 里选 Claude,报
//   Failed to authenticate. API Error: 403 Request not allowed
// 同一台机器在终端里跑同一个命令完全正常。差别是代理变量 —— 靠本地代理访问
// Anthropic 的话,直连出去会被按地区拒掉。和 PATH 是同一类问题:
// GUI 进程拿不到用户 shell 的环境。
describe('computeInheritedEnv', () => {
  it('picks the proxy up from the login shell', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { SHELL: '/bin/zsh' },
        readLoginShellVars: () => ({ HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      }),
    )
    expect(vars).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    })
  })

  it('falls back to whatever the current process already has', () => {
    const vars = computeInheritedEnv(
      deps({ env: { SHELL: '/bin/zsh', HTTPS_PROXY: 'http://proxy:8080' }, readLoginShellVars: () => ({}) }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://proxy:8080')
  })

  it('lets the login shell win over a stale process value', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { SHELL: '/bin/zsh', HTTPS_PROXY: 'http://old:1' },
        readLoginShellVars: () => ({ HTTPS_PROXY: 'http://new:2' }),
      }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://new:2')
  })

  // 只取白名单里的。登录 shell 里什么都有,无差别灌给子进程是给自己找麻烦。
  it('only takes the allowlisted keys', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { SHELL: '/bin/zsh' },
        readLoginShellVars: () => ({ HTTPS_PROXY: 'http://p', AWS_SECRET_ACCESS_KEY: 'nope' } as never),
      }),
    )
    expect(Object.keys(vars)).toEqual(['HTTPS_PROXY'])
  })

  it('drops empty values instead of setting a blank proxy', () => {
    const vars = computeInheritedEnv(
      deps({ env: { SHELL: '/bin/zsh', HTTP_PROXY: '' }, readLoginShellVars: () => ({ HTTPS_PROXY: '' }) }),
    )
    expect(vars).toEqual({})
  })

  it('survives a shell that throws', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { SHELL: '/bin/zsh' },
        readLoginShellVars: () => {
          throw new Error('rc exploded')
        },
      }),
    )
    expect(vars).toEqual({})
  })

  it('leaves Windows alone', () => {
    expect(computeInheritedEnv(deps({ platform: 'win32', env: { HTTPS_PROXY: 'x' } }))).toEqual({})
  })

  it('covers both cases of the proxy variable names', () => {
    expect(INHERITED_ENV_KEYS).toContain('HTTPS_PROXY')
    expect(INHERITED_ENV_KEYS).toContain('https_proxy')
  })
})

describe('userShellEnv', () => {
  it('hands back one env patch with both PATH and the proxy', () => {
    const patch = userShellEnv(
      deps({
        env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
        readLoginShellPath: () => '/opt/homebrew/bin:/usr/bin',
        readLoginShellVars: () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      }),
    )
    expect(patch.PATH.split(delimiter)).toContain('/opt/homebrew/bin')
    expect(patch.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })
})

// 2026-08-25 这台机器上 `scutil --proxy` 的真实输出。代理是 ClashX 那类 GUI
// 软件设的系统代理,shell 配置里一个字都没有 —— 登录 shell 探测拿不到它。
const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : 10.0.0.0/8
    2 : 127.0.0.1
    3 : localhost
    4 : *.local
  }
  ExcludeSimpleHostnames : 0
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`

describe('parseScutilProxy', () => {
  it('reads the real output from this machine', () => {
    expect(parseScutilProxy(SCUTIL)).toEqual({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      socksProxy: 'socks5://127.0.0.1:7890',
      exceptions: ['192.168.0.0/16', '10.0.0.0/8', '127.0.0.1', 'localhost', '*.local'],
    })
  })

  // Enable 是 0 就等于没配,不能因为 Proxy 字段还留着就用它。
  it('ignores a proxy that is configured but switched off', () => {
    const off = SCUTIL.replace('HTTPEnable : 1', 'HTTPEnable : 0').replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
    const parsed = parseScutilProxy(off)
    expect(parsed.httpProxy).toBeUndefined()
    expect(parsed.httpsProxy).toBeUndefined()
  })

  it('returns nothing for a machine with no proxy at all', () => {
    expect(parseScutilProxy('<dictionary> {\n  ExcludeSimpleHostnames : 0\n}')).toEqual({})
    expect(parseScutilProxy('')).toEqual({})
  })
})

describe('systemProxyEnv', () => {
  it('projects http/https and the exception list', () => {
    expect(systemProxyEnv(parseScutilProxy(SCUTIL))).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '192.168.0.0/16,10.0.0.0/8,127.0.0.1,localhost,*.local',
    })
  })

  // 不是所有客户端都认 ALL_PROXY,只在没有 http/https 时才拿 SOCKS 兜底。
  it('only falls back to SOCKS when there is no http proxy', () => {
    expect(systemProxyEnv({ socksProxy: 'socks5://127.0.0.1:7890' })).toEqual({
      ALL_PROXY: 'socks5://127.0.0.1:7890',
    })
    expect(systemProxyEnv(parseScutilProxy(SCUTIL)).ALL_PROXY).toBeUndefined()
  })
})

describe('系统代理垫底', () => {
  it('rescues a GUI process that has neither shell vars nor its own', () => {
    const vars = computeInheritedEnv(
      deps({
        env: {},
        readLoginShellVars: () => ({}),
        readSystemProxy: () => parseScutilProxy(SCUTIL),
      }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('lets an explicitly set variable win over the system proxy', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { HTTPS_PROXY: 'http://explicit:1' },
        readLoginShellVars: () => ({}),
        readSystemProxy: () => parseScutilProxy(SCUTIL),
      }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://explicit:1')
  })

  // 环境里一个空的 HTTPS_PROXY= 就会把系统代理那层挡掉:?? 认为空字符串是有效值,
  // 挡完之后它自己又被判空丢弃 —— 代理悄无声息地没了,表现成上游 403。
  it('an empty env var must not shadow the system proxy', () => {
    const vars = computeInheritedEnv(
      deps({
        env: { HTTPS_PROXY: '', HTTP_PROXY: '   ' },
        readLoginShellVars: () => ({}),
        readSystemProxy: () => parseScutilProxy(SCUTIL),
      }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(vars.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('an empty login-shell value must not shadow the rest either', () => {
    const vars = computeInheritedEnv(
      deps({
        env: {},
        readLoginShellVars: () => ({ HTTPS_PROXY: '' }),
        readSystemProxy: () => parseScutilProxy(SCUTIL),
      }),
    )
    expect(vars.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('survives scutil throwing', () => {
    const vars = computeInheritedEnv(
      deps({
        env: {},
        readLoginShellVars: () => ({}),
        readSystemProxy: () => {
          throw new Error('no scutil')
        },
      }),
    )
    expect(vars).toEqual({})
  })
})

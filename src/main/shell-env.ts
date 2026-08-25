import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { delimiter } from 'path'

/**
 * 从用户登录 shell 里捞回来的那部分环境。
 *
 * 从 Finder / Dock 启动的 Mac app 不经过登录 shell,环境是极简的。两处会咬人:
 *
 * 1. PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— Homebrew 的 /opt/homebrew/bin、
 *    nvm、fnm、volta 装的东西一个都看不见,`spawn('npx')` 直接 ENOENT。
 * 2. 代理变量全丢 —— 靠本地代理访问上游的用户,请求会直连出去。
 *    2026-08-25 实测:claude-agent-acp 因此拿到
 *    `403 Request not allowed`(Anthropic 对不支持地区的返回),
 *    而同一台机器在终端里跑同一个命令完全正常。
 *    注意代理**未必在 shell 配置里** —— ClashX 那类 GUI 软件设的是 macOS
 *    系统代理,终端里的 HTTPS_PROXY 往往是别的工具替你读出来注进去的。
 *    所以这里除了问登录 shell,还要直接读 `scutil --proxy`。
 *
 * pi 自己两条都不受影响:它用内嵌 Electron 当 Node、从 node_modules 定位 CLI,
 * 且只跟自家网关说话。但外部 ACP agent 两条都需要。
 */

/** 装东西的常见位置。登录 shell 问不出来时至少还能兜住 Homebrew 这一类。 */
export function commonBinDirs(home = homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/local/bin',
  ]
}

/**
 * 合并成一条 PATH:登录 shell 问到的优先,然后是当前进程的,最后兜底目录。
 * 去重并保序 —— 前面的赢,这样用户 shell 里选的版本不会被兜底目录盖掉。
 */
export function mergePathEntries(...sources: (string | undefined | null)[]): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const source of sources) {
    if (!source) continue
    for (const entry of source.split(delimiter)) {
      const trimmed = entry.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      merged.push(trimmed)
    }
  }
  return merged.join(delimiter)
}

/**
 * 要从登录 shell 捞回来的变量。只取这些,不整份继承 ——
 * 登录 shell 里什么都有,无差别灌给子进程是给自己找麻烦。
 */
export const INHERITED_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

export type SystemProxy = {
  httpProxy?: string
  httpsProxy?: string
  socksProxy?: string
  exceptions?: string[]
}

/**
 * 解析 `scutil --proxy`。macOS 的系统代理是 GUI 代理软件写的地方,
 * 也是 GUI app 唯一能可靠拿到代理配置的来源。
 */
export function parseScutilProxy(output: string): SystemProxy {
  const read = (key: string): string | undefined => {
    const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))
    return match?.[1]?.trim()
  }
  const enabled = (key: string): boolean => read(key) === '1'
  const url = (host?: string, port?: string): string | undefined =>
    host && port ? `http://${host}:${port}` : undefined

  const proxy: SystemProxy = {}
  if (enabled('HTTPEnable')) proxy.httpProxy = url(read('HTTPProxy'), read('HTTPPort'))
  if (enabled('HTTPSEnable')) proxy.httpsProxy = url(read('HTTPSProxy'), read('HTTPSPort'))
  if (enabled('SOCKSEnable')) {
    const host = read('SOCKSProxy')
    const port = read('SOCKSPort')
    if (host && port) proxy.socksProxy = `socks5://${host}:${port}`
  }
  // ExceptionsList 是一个数组块,取里面 `N : value` 的那些行。
  const block = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)
  if (block) {
    const items = [...block[1].matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map((m) => m[1].trim())
    if (items.length) proxy.exceptions = items
  }
  return proxy
}

/** 系统代理投影成子进程认得的环境变量。 */
export function systemProxyEnv(proxy: SystemProxy): Record<string, string> {
  const env: Record<string, string> = {}
  if (proxy.httpProxy) env.HTTP_PROXY = proxy.httpProxy
  if (proxy.httpsProxy) env.HTTPS_PROXY = proxy.httpsProxy
  // 只有 SOCKS 时才拿它兜底 —— 不是所有客户端都认 ALL_PROXY。
  if (proxy.socksProxy && !proxy.httpProxy && !proxy.httpsProxy) env.ALL_PROXY = proxy.socksProxy
  if (proxy.exceptions?.length) env.NO_PROXY = proxy.exceptions.join(',')
  return env
}

export type ShellPathDependencies = {
  platform: string
  env: Record<string, string | undefined>
  home: string
  /** 问登录 shell 要 PATH;问不到就返回 null。 */
  readLoginShellPath: (shell: string) => string | null
  /** 问登录 shell 要那几个变量;问不到就返回空对象。 */
  readLoginShellVars?: (shell: string, keys: readonly string[]) => Record<string, string>
  /** 读 macOS 系统代理;读不到就返回空对象。 */
  readSystemProxy?: () => SystemProxy
}

export function defaultShellPathDependencies(): ShellPathDependencies {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    readLoginShellPath: (shell) => {
      try {
        // -i 会让某些 rc 文件走交互分支甚至卡住,所以只用 -l(登录),并且给超时。
        const out = execFileSync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
          encoding: 'utf8',
          timeout: 3_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        return out.trim() || null
      } catch {
        return null
      }
    },
    readLoginShellVars: (shell, keys) => {
      try {
        // 一行一个,顺序固定。代理 URL 和 PATH 里不会有换行。
        const script = keys.map((key) => `printf '%s\n' "$${key}"`).join('; ')
        const out = execFileSync(shell, ['-l', '-c', script], {
          encoding: 'utf8',
          timeout: 3_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        const lines = out.split('\n')
        const vars: Record<string, string> = {}
        keys.forEach((key, index) => {
          const value = (lines[index] ?? '').trim()
          if (value) vars[key] = value
        })
        return vars
      } catch {
        return {}
      }
    },
    readSystemProxy: () => {
      try {
        return parseScutilProxy(
          execFileSync('scutil', ['--proxy'], {
            encoding: 'utf8',
            timeout: 3_000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }),
        )
      } catch {
        return {}
      }
    },
  }
}

/**
 * 问哪个 shell。
 *
 * 不能赌 SHELL 一定在:launchd 的 GUI 域里它可能是空的,而那正是我们要救的场景 ——
 * 没有 SHELL 就跳过探测的话,代理变量永远补不回来。退到 macOS 的默认 shell。
 */
export function resolveShell(env: Record<string, string | undefined>): string {
  return env.SHELL?.trim() || '/bin/zsh'
}

export function computeUserPath(deps: ShellPathDependencies): string {
  // Windows 的 GUI 进程本来就继承完整环境,不用折腾。
  if (deps.platform === 'win32') return deps.env.PATH ?? ''
  const shell = resolveShell(deps.env)
  let fromShell: string | null = null
  if (shell) {
    try {
      fromShell = deps.readLoginShellPath(shell)
    } catch {
      // rc 文件里什么都可能有。问不出来就退回兜底目录,
      // 绝不能让「查 PATH」这件事把打开工作区搞崩。
      fromShell = null
    }
  }
  return mergePathEntries(fromShell, deps.env.PATH, commonBinDirs(deps.home).join(delimiter))
}

/** 代理这类变量:登录 shell 里有就用它,否则看当前进程还有没有。 */
export function computeInheritedEnv(deps: ShellPathDependencies): Record<string, string> {
  if (deps.platform === 'win32') return {}
  const shell = resolveShell(deps.env)
  let fromShell: Record<string, string> = {}
  if (deps.readLoginShellVars) {
    try {
      fromShell = deps.readLoginShellVars(shell, INHERITED_ENV_KEYS)
    } catch {
      fromShell = {}
    }
  }
  // 系统代理垫底:显式设过的环境变量和登录 shell 都优先于它。
  let fromSystem: Record<string, string> = {}
  if (deps.readSystemProxy) {
    try {
      fromSystem = systemProxyEnv(deps.readSystemProxy())
    } catch {
      fromSystem = {}
    }
  }
  const result: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = fromShell[key] ?? deps.env[key] ?? fromSystem[key]
    if (value) result[key] = value
  }
  return result
}

export type UserShellEnv = { PATH: string } & Record<string, string>

let cached: UserShellEnv | null = null

/**
 * 给外部子进程用的环境增量。启动一次登录 shell 要几百毫秒,只问一次。
 */
export function userShellEnv(deps?: ShellPathDependencies): UserShellEnv {
  const compute = (d: ShellPathDependencies): UserShellEnv => ({
    ...computeInheritedEnv(d),
    PATH: computeUserPath(d),
  })
  if (deps) return compute(deps)
  cached ??= compute(defaultShellPathDependencies())
  return cached
}

/** 只要 PATH 的便捷入口。 */
export function userPath(deps?: ShellPathDependencies): string {
  return userShellEnv(deps).PATH
}

/** 仅供测试:清掉缓存。 */
export function resetUserPathCache(): void {
  cached = null
}

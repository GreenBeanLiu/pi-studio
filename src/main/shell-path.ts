import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { delimiter } from 'path'

/**
 * 用户 shell 里的 PATH。
 *
 * 从 Finder / Dock 启动的 Mac app 不经过登录 shell,拿到的 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin` —— Homebrew 的 /opt/homebrew/bin、nvm、fnm、
 * volta 装的东西一个都看不见。`spawn('npx')` 于是 ENOENT,而调用方看到的往往
 * 只是「连接断了」这种毫无线索的错。
 *
 * pi 自己不受影响:它用内嵌的 Electron 当 Node、从 node_modules 里定位 CLI,
 * 从不依赖 PATH。但外部 ACP agent 是 `npx -y <package>` 起的,必须解决。
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

export type ShellPathDependencies = {
  platform: string
  env: Record<string, string | undefined>
  home: string
  /** 问登录 shell 要 PATH;问不到就返回 null。 */
  readLoginShellPath: (shell: string) => string | null
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
  }
}

export function computeUserPath(deps: ShellPathDependencies): string {
  // Windows 的 GUI 进程本来就继承完整环境,不用折腾。
  if (deps.platform === 'win32') return deps.env.PATH ?? ''
  const shell = deps.env.SHELL
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

let cached: string | null = null

/** 缓存的用户 PATH。启动一次登录 shell 要几百毫秒,只问一次。 */
export function userPath(deps?: ShellPathDependencies): string {
  if (deps) return computeUserPath(deps)
  cached ??= computeUserPath(defaultShellPathDependencies())
  return cached
}

/** 仅供测试:清掉缓存。 */
export function resetUserPathCache(): void {
  cached = null
}

import { existsSync, readFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { createRequire } from 'module'
import type { RpcClient as RpcClientType } from '@earendil-works/pi-coding-agent'

export async function loadRpcClient(): Promise<typeof RpcClientType> {
  const mod = await import('@earendil-works/pi-coding-agent')
  return mod.RpcClient
}

export function resolvePiCliPath(): string {
  const cjsRequire = createRequire(import.meta.url)
  const searchPaths = cjsRequire.resolve.paths('@earendil-works/pi-coding-agent') ?? []
  for (const base of searchPaths) {
    const candidate = join(base, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent/dist/cli.js')
}

export function resolvePiEngineVersion(): string {
  try {
    const packagePath = join(dirname(dirname(resolvePiCliPath())), 'package.json')
    const value = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function embeddedNodeEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, ELECTRON_RUN_AS_NODE: '1' }
}

export function resolveEmbeddedNodePath(
  execPath = process.execPath,
  platform = process.platform,
): string {
  if (platform !== 'darwin') return execPath
  const executableName = basename(execPath)
  const helperPath = resolve(
    dirname(execPath),
    '..',
    'Frameworks',
    `${executableName} Helper.app`,
    'Contents',
    'MacOS',
    `${executableName} Helper`,
  )
  return existsSync(helperPath) ? helperPath : execPath
}

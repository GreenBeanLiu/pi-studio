import { execFile } from 'child_process'
import { basename } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type WorkspaceInventoryItem = {
  path: string
  name: string
  lastOpenedAt?: string
  kind: 'git' | 'local'
  repository?: string
  defaultRef?: string
}

type WorkspaceCandidate = {
  path: string
  name: string
  lastOpenedAt?: string
}

async function git(path: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, ...args], {
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Normalize common remotes without ever returning embedded user info or credentials. */
export function normalizeRepository(remote: string | null): string | undefined {
  if (!remote) return undefined
  if (/^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|\/)/.test(remote)) return undefined
  const scp = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scp && !remote.includes('://')) {
    const host = scp[1].toLowerCase()
    const path = scp[2].replace(/^\/+|\/?\.git$/g, '')
    return host === 'github.com' ? path : `${host}/${path}`
  }
  try {
    const parsed = new URL(remote)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined
    const path = parsed.pathname.replace(/^\/+|\/?\.git$/g, '')
    if (!path) return undefined
    return parsed.hostname.toLowerCase() === 'github.com' ? path : `${parsed.hostname.toLowerCase()}/${path}`
  } catch {
    return undefined
  }
}

async function inspectWorkspace(workspace: WorkspaceCandidate): Promise<WorkspaceInventoryItem> {
  const [root, remote, remoteHead] = await Promise.all([
    git(workspace.path, ['rev-parse', '--show-toplevel']),
    git(workspace.path, ['config', '--get', 'remote.origin.url']),
    git(workspace.path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ])
  const repository = normalizeRepository(remote)
  return {
    path: root ?? workspace.path,
    name: workspace.name || basename(root ?? workspace.path),
    ...(workspace.lastOpenedAt ? { lastOpenedAt: workspace.lastOpenedAt } : {}),
    kind: root ? 'git' : 'local',
    ...(repository ? { repository } : {}),
    ...(remoteHead ? { defaultRef: remoteHead.replace(/^origin\//, '') } : {}),
  }
}

export async function workspaceInventory(
  current: string | null,
  recent: WorkspaceCandidate[],
): Promise<WorkspaceInventoryItem[]> {
  const byPath = new Map<string, WorkspaceCandidate>()
  if (current) byPath.set(current.toLowerCase(), { path: current, name: basename(current) })
  for (const workspace of recent) {
    const key = workspace.path.toLowerCase()
    if (!byPath.has(key)) byPath.set(key, workspace)
  }
  return Promise.all([...byPath.values()].map(inspectWorkspace))
}

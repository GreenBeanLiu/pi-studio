import { execFile } from 'child_process'
import { resolve } from 'path'
import { promisify } from 'util'
import {
  RunChangeSet,
  type RunChangedFile,
  type RunChangeReview,
} from './run-change-set'

const execFileAsync = promisify(execFile)
const OUTPUT_LIMIT = 300_000
const activeRunChanges = new Map<string, RunChangeSet>()

const workspaceKey = (cwd: string): string => resolve(cwd).toLowerCase()

export class PendingGitRunChangesError extends Error {
  constructor() {
    super('Previous agent run changes must be accepted or reverted before starting again')
    this.name = 'PendingGitRunChangesError'
  }
}

export type GitDiffSnapshot = RunChangeReview
export type GitChangedFile = RunChangedFile

export function emptyGitDiffSnapshot(): GitDiffSnapshot {
  return {
    status: '',
    files: [],
    unstagedStat: '',
    unstagedDiff: '',
    stagedStat: '',
    stagedDiff: '',
    truncated: false,
  }
}

function trimOutput(value: string): { value: string; truncated: boolean } {
  if (value.length <= OUTPUT_LIMIT) return { value, truncated: false }
  return {
    value: `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated ${value.length - OUTPUT_LIMIT} chars]`,
    truncated: true,
  }
}

function parseStatusFiles(status: string): GitChangedFile[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const stagedCode = line[0] ?? ' '
      const unstagedCode = line[1] ?? ' '
      const rawPath = line.slice(3)
      const renameSep = rawPath.indexOf(' -> ')
      const originalPath = renameSep === -1 ? undefined : rawPath.slice(0, renameSep)
      const path = renameSep === -1 ? rawPath : rawPath.slice(renameSep + 4)

      return {
        path,
        originalPath,
        statusCode: `${stagedCode}${unstagedCode}`,
        staged: stagedCode !== ' ' && stagedCode !== '?',
        unstaged: unstagedCode !== ' ' || stagedCode === '?',
      }
    })
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: OUTPUT_LIMIT * 2,
      windowsHide: true,
    })
    return stdout || stderr
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string }
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
    throw new Error(output || `git ${args.join(' ')} failed`)
  }
}

export async function getGitDiffSnapshot(cwd: string): Promise<GitDiffSnapshot> {
  const runChanges = activeRunChanges.get(workspaceKey(cwd))
  if (runChanges?.isActive()) return runChanges.diff()

  const [status, unstagedStat, unstagedDiff, stagedStat, stagedDiff] = await Promise.all([
    git(cwd, ['status', '--short']),
    git(cwd, ['diff', '--stat']),
    git(cwd, ['diff']),
    git(cwd, ['diff', '--cached', '--stat']),
    git(cwd, ['diff', '--cached']),
  ])

  const parts = {
    status: trimOutput(status),
    unstagedStat: trimOutput(unstagedStat),
    unstagedDiff: trimOutput(unstagedDiff),
    stagedStat: trimOutput(stagedStat),
    stagedDiff: trimOutput(stagedDiff),
  }

  return {
    status: parts.status.value,
    files: parseStatusFiles(status),
    unstagedStat: parts.unstagedStat.value,
    unstagedDiff: parts.unstagedDiff.value,
    stagedStat: parts.stagedStat.value,
    stagedDiff: parts.stagedDiff.value,
    truncated: Object.values(parts).some((part) => part.truncated),
  }
}

export async function isGitWorkspace(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    return false
  }
}

export async function beginGitRunChanges(cwd: string): Promise<void> {
  const key = workspaceKey(cwd)
  const active = activeRunChanges.get(key)
  if (active?.isActive()) {
    if (!active.isSealed()) {
      throw new Error('The agent run is still running; wait for it to finish before starting again')
    }
    const pending = await active.diff()
    if (pending.status.trim()) {
      throw new PendingGitRunChangesError()
    }
    active.accept()
    activeRunChanges.delete(key)
  }
  const changes = new RunChangeSet(cwd)
  await changes.begin()
  activeRunChanges.set(key, changes)
}

export function acceptGitRunChanges(cwd: string): void {
  const key = workspaceKey(cwd)
  const changes = activeRunChanges.get(key)
  if (changes?.isActive() && !changes.isSealed()) {
    throw new Error('The agent run is still running; wait for it to finish before reviewing changes')
  }
  changes?.accept()
  activeRunChanges.delete(key)
}

export function clearAllGitRunChanges(): number {
  const count = activeRunChanges.size
  for (const changes of activeRunChanges.values()) changes.accept()
  activeRunChanges.clear()
  return count
}

export async function sealGitRunChanges(cwd: string): Promise<void> {
  const key = workspaceKey(cwd)
  const changes = activeRunChanges.get(key)
  if (!changes?.isActive()) return
  try {
    await changes.seal()
  } catch (err) {
    // A live baseline is unsafe after a failed seal because later user edits
    // could otherwise be mistaken for agent changes during rollback.
    changes.accept()
    activeRunChanges.delete(key)
    throw err
  }
}

export async function discardGitChanges(cwd: string): Promise<void> {
  const key = workspaceKey(cwd)
  const changes = activeRunChanges.get(key)
  if (!changes?.isActive()) {
    throw new Error('No agent run change baseline is available; refusing to modify the workspace')
  }
  if (!changes.isSealed()) {
    throw new Error('The agent run is still running; wait for it to finish before reviewing changes')
  }
  await changes.revert()
  activeRunChanges.delete(key)
}

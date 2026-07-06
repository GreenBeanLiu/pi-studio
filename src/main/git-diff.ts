import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const OUTPUT_LIMIT = 300_000

export type GitDiffSnapshot = {
  status: string
  unstagedStat: string
  unstagedDiff: string
  stagedStat: string
  stagedDiff: string
  truncated: boolean
}

function trimOutput(value: string): { value: string; truncated: boolean } {
  if (value.length <= OUTPUT_LIMIT) return { value, truncated: false }
  return {
    value: `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated ${value.length - OUTPUT_LIMIT} chars]`,
    truncated: true,
  }
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
    unstagedStat: parts.unstagedStat.value,
    unstagedDiff: parts.unstagedDiff.value,
    stagedStat: parts.stagedStat.value,
    stagedDiff: parts.stagedDiff.value,
    truncated: Object.values(parts).some((part) => part.truncated),
  }
}

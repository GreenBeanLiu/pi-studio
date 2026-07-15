import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptGitRunChanges,
  beginGitRunChanges,
  discardGitChanges,
  sealGitRunChanges,
} from './git-diff'
import { cleanupStaleRunChangeTempDirs, RunChangeSet } from './run-change-set'

const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim()
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-studio-run-change-set-'))
  repos.push(cwd)
  git(cwd, 'init')
  git(cwd, 'config', 'user.email', 'pi-studio@example.test')
  git(cwd, 'config', 'user.name', 'pi-studio tests')
  git(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, 'tracked.txt'), 'committed\n', 'utf-8')
  git(cwd, 'add', 'tracked.txt')
  git(cwd, 'commit', '-m', 'initial')
  return cwd
}

afterEach(() => {
  // On Windows a git snapshot subprocess can briefly keep a handle to the temp
  // repo (e.g. the "cannot be sealed" case deletes .git mid-run), so an
  // immediate recursive delete races the handle release and throws EPERM.
  // Retry to let the handle drain; if it still fails, leave the temp dir for
  // the OS — leftover temp files are not what these tests assert on, and the
  // EPERM was intermittently failing otherwise-green suites (and releases).
  for (const cwd of repos.splice(0)) {
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      /* leaked temp dir on Windows; harmless */
    }
  }
})

describe('RunChangeSet', () => {
  it('cleans only temporary Git directories owned by dead processes', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'pi-studio-temp-cleanup-'))
    repos.push(tempRoot)
    const staleSnapshot = join(tempRoot, 'pi-studio-run-snapshot-1001-stale')
    const staleIndex = join(tempRoot, 'pi-studio-git-index-1001-stale')
    const livePatch = join(tempRoot, 'pi-studio-git-patch-1002-live')
    const unrelated = join(tempRoot, 'pi-studio-unrelated-1001-keep')
    for (const path of [staleSnapshot, staleIndex, livePatch, unrelated]) {
      mkdirSync(path)
    }

    expect(
      cleanupStaleRunChangeTempDirs({
        tempRoot,
        isProcessAlive: (pid) => pid === 1002,
      }),
    ).toBe(2)

    expect(existsSync(staleSnapshot)).toBe(false)
    expect(existsSync(staleIndex)).toBe(false)
    expect(existsSync(livePatch)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('reverts only changes made after the run baseline', async () => {
    const cwd = createRepo()
    writeFileSync(join(cwd, 'tracked.txt'), 'user change before run\n', 'utf-8')
    writeFileSync(join(cwd, 'user-note.txt'), 'keep me\n', 'utf-8')

    const changes = new RunChangeSet(cwd)
    await changes.begin()

    writeFileSync(join(cwd, 'tracked.txt'), 'agent change\n', 'utf-8')
    writeFileSync(join(cwd, 'agent-file.txt'), 'created by agent\n', 'utf-8')

    const review = await changes.diff()
    expect(review.files.map((file) => file.path).sort()).toEqual(['agent-file.txt', 'tracked.txt'])
    expect(review.unstagedDiff).toContain('created by agent')
    expect(review.unstagedDiff).not.toContain('user-note.txt')

    await changes.revert()

    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('user change before run\n')
    expect(readFileSync(join(cwd, 'user-note.txt'), 'utf-8')).toBe('keep me\n')
    expect(() => readFileSync(join(cwd, 'agent-file.txt'), 'utf-8')).toThrow()
  })

  it('refuses automatic revert after HEAD changes', async () => {
    const cwd = createRepo()
    const changes = new RunChangeSet(cwd)
    await changes.begin()

    writeFileSync(join(cwd, 'tracked.txt'), 'committed by agent\n', 'utf-8')
    git(cwd, 'add', 'tracked.txt')
    git(cwd, 'commit', '-m', 'agent commit')

    await expect(changes.revert()).rejects.toThrow('HEAD changed')
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('committed by agent\n')
    changes.accept()
  })

  it('does not persist pre-run untracked content in the repository object database', async () => {
    const cwd = createRepo()
    writeFileSync(join(cwd, 'private-note.txt'), 'local-only secret\n', 'utf-8')
    const objectsBefore = git(cwd, 'count-objects', '-v')

    const changes = new RunChangeSet(cwd)
    await changes.begin()
    changes.accept()

    expect(git(cwd, 'count-objects', '-v')).toBe(objectsBefore)
  })

  it('does not include user edits made after the agent run is sealed', async () => {
    const cwd = createRepo()
    const changes = new RunChangeSet(cwd)
    await changes.begin()
    writeFileSync(join(cwd, 'tracked.txt'), 'agent change\n', 'utf-8')
    await changes.seal()

    writeFileSync(join(cwd, 'after-run.txt'), 'user edit after completion\n', 'utf-8')

    const review = await changes.diff()
    expect(review.files.map((file) => file.path)).toEqual(['tracked.txt'])

    await changes.revert()
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('committed\n')
    expect(readFileSync(join(cwd, 'after-run.txt'), 'utf-8')).toBe('user edit after completion\n')
  })

  it('requires a pending run change review before starting another baseline', async () => {
    const cwd = createRepo()
    await beginGitRunChanges(cwd)
    writeFileSync(join(cwd, 'tracked.txt'), 'first run change\n', 'utf-8')
    await sealGitRunChanges(cwd)

    await expect(beginGitRunChanges(cwd)).rejects.toThrow('accepted or reverted')
    acceptGitRunChanges(cwd)
  })

  it('refuses review actions until the agent run is sealed', async () => {
    const cwd = createRepo()
    await beginGitRunChanges(cwd)
    await expect(beginGitRunChanges(cwd)).rejects.toThrow('still running')
    writeFileSync(join(cwd, 'tracked.txt'), 'agent still writing\n', 'utf-8')

    await expect(discardGitChanges(cwd)).rejects.toThrow('still running')
    expect(() => acceptGitRunChanges(cwd)).toThrow('still running')

    await sealGitRunChanges(cwd)
    acceptGitRunChanges(cwd)
  })

  it('disables rollback if the end snapshot cannot be sealed', async () => {
    const cwd = createRepo()
    await beginGitRunChanges(cwd)
    writeFileSync(join(cwd, 'tracked.txt'), 'partial agent change\n', 'utf-8')
    rmSync(join(cwd, '.git'), { recursive: true, force: true })

    await expect(sealGitRunChanges(cwd)).rejects.toThrow()
    await expect(discardGitChanges(cwd)).rejects.toThrow('No agent run change baseline')
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('partial agent change\n')
  })

  it('preserves staging performed by the user after the run is sealed', async () => {
    const cwd = createRepo()
    writeFileSync(join(cwd, 'other.txt'), 'other committed\n', 'utf-8')
    git(cwd, 'add', 'other.txt')
    git(cwd, 'commit', '-m', 'add other')

    const changes = new RunChangeSet(cwd)
    await changes.begin()
    writeFileSync(join(cwd, 'tracked.txt'), 'agent staged change\n', 'utf-8')
    git(cwd, 'add', 'tracked.txt')
    await changes.seal()

    writeFileSync(join(cwd, 'other.txt'), 'user staged after run\n', 'utf-8')
    git(cwd, 'add', 'other.txt')

    await changes.revert()

    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('committed\n')
    expect(readFileSync(join(cwd, 'other.txt'), 'utf-8')).toBe('user staged after run\n')
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('other.txt')
  })

  it('refuses to delete a pre-run ignored file that becomes visible during the run', async () => {
    const cwd = createRepo()
    writeFileSync(join(cwd, '.gitignore'), '.env\n', 'utf-8')
    git(cwd, 'add', '.gitignore')
    git(cwd, 'commit', '-m', 'ignore env')
    writeFileSync(join(cwd, '.env'), 'user secret before run\n', 'utf-8')

    const changes = new RunChangeSet(cwd)
    await changes.begin()
    writeFileSync(join(cwd, '.gitignore'), '', 'utf-8')
    writeFileSync(join(cwd, '.env'), 'agent touched secret\n', 'utf-8')
    await changes.seal()

    await expect(changes.revert()).rejects.toThrow('ignored before the run')
    expect(readFileSync(join(cwd, '.env'), 'utf-8')).toBe('agent touched secret\n')
    changes.accept()
  })
})

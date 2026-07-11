import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const OUTPUT_LIMIT = 300_000
const GIT_BUFFER_LIMIT = 20 * 1024 * 1024
const RUN_TEMP_DIR_PATTERN = /^pi-studio-(?:run-snapshot|git-index|git-patch)-(\d+)-/

type TempCleanupOptions = {
  tempRoot?: string
  isProcessAlive?: (pid: number) => boolean
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function cleanupStaleRunChangeTempDirs({
  tempRoot = tmpdir(),
  isProcessAlive: processIsAlive = isProcessAlive,
}: TempCleanupOptions = {}): number {
  let entries
  try {
    entries = readdirSync(tempRoot, { withFileTypes: true })
  } catch {
    return 0
  }

  let cleaned = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const ownerPid = Number(RUN_TEMP_DIR_PATTERN.exec(entry.name)?.[1])
    if (!Number.isSafeInteger(ownerPid) || processIsAlive(ownerPid)) continue
    try {
      rmSync(join(tempRoot, entry.name), { recursive: true, force: true })
      cleaned += 1
    } catch {
      // Best-effort startup cleanup must never prevent the app from opening.
    }
  }
  return cleaned
}

function createRunTempDir(kind: 'run-snapshot' | 'git-index' | 'git-patch'): string {
  return mkdtempSync(join(tmpdir(), `pi-studio-${kind}-${process.pid}-`))
}

export type RunChangedFile = {
  path: string
  originalPath?: string
  statusCode: string
  staged: boolean
  unstaged: boolean
}

export type RunChangeReview = {
  status: string
  files: RunChangedFile[]
  unstagedStat: string
  unstagedDiff: string
  stagedStat: string
  stagedDiff: string
  truncated: boolean
}

type Baseline = {
  head: string
  indexTree: string
  worktreeTree: string
  ignoredPaths: string[]
  endIndexTree?: string
  endWorktreeTree?: string
}

function trimOutput(value: string): { value: string; truncated: boolean } {
  if (value.length <= OUTPUT_LIMIT) return { value, truncated: false }
  return {
    value: `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated ${value.length - OUTPUT_LIMIT} chars]`,
    truncated: true,
  }
}

/**
 * Captures the complete Git-visible working tree at the start of one agent run.
 * The snapshot lives in a private temporary Git object store, so it includes
 * pre-existing tracked and untracked files without mutating the real index or
 * leaving local-only content in the repository object database.
 */
export class RunChangeSet {
  private readonly cwd: string
  private baseline: Baseline | null = null
  private snapshotDir: string | null = null
  private snapshotEnv: NodeJS.ProcessEnv | null = null

  constructor(cwd: string) {
    this.cwd = resolve(cwd)
  }

  async begin(): Promise<void> {
    this.baseline = null
    this.cleanupSnapshot()
    const objectsPath = await this.git(['rev-parse', '--git-path', 'objects'])
    const repositoryObjects = isAbsolute(objectsPath) ? objectsPath : resolve(this.cwd, objectsPath)
    this.snapshotDir = createRunTempDir('run-snapshot')
    const privateObjects = join(this.snapshotDir, 'objects')
    mkdirSync(privateObjects, { recursive: true })
    this.snapshotEnv = {
      ...process.env,
      GIT_OBJECT_DIRECTORY: privateObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        repositoryObjects,
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(delimiter),
    }

    try {
      const env = this.requireSnapshotEnv()
      const [head, indexTree, worktreeTree, ignoredPathsRaw] = await Promise.all([
        this.git(['rev-parse', 'HEAD'], env),
        this.git(['write-tree'], env),
        this.snapshotWorktree(),
        this.git(
          ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
          env,
          false,
        ),
      ])
      this.baseline = {
        head,
        indexTree,
        worktreeTree,
        ignoredPaths: ignoredPathsRaw.split('\0').filter(Boolean),
      }
    } catch (err) {
      this.cleanupSnapshot()
      throw err
    }
  }

  async diff(): Promise<RunChangeReview> {
    const baseline = this.requireBaseline()
    const currentTree = baseline.endWorktreeTree ?? (await this.snapshotWorktree())
    const env = this.requireSnapshotEnv()
    const [nameStatus, stat, patch] = await Promise.all([
      this.git(
        ['diff', '--no-renames', '--name-status', '-z', baseline.worktreeTree, currentTree],
        env,
      ),
      this.git(['diff', '--stat', baseline.worktreeTree, currentTree], env),
      this.git(['diff', '--binary', baseline.worktreeTree, currentTree], env, false),
    ])

    const files = this.parseNameStatus(nameStatus)
    const status = files.map((file) => `${file.statusCode.padEnd(2)} ${file.path}`).join('\n')
    const statusPart = trimOutput(status)
    const statPart = trimOutput(stat)
    const patchPart = trimOutput(patch)

    return {
      status: statusPart.value,
      files,
      unstagedStat: statPart.value,
      unstagedDiff: patchPart.value,
      stagedStat: '',
      stagedDiff: '',
      truncated: statusPart.truncated || statPart.truncated || patchPart.truncated,
    }
  }

  async revert(): Promise<void> {
    const baseline = this.requireBaseline()
    const env = this.requireSnapshotEnv()
    const currentHead = await this.git(['rev-parse', 'HEAD'], env)
    if (currentHead !== baseline.head) {
      throw new Error('Cannot safely revert this run because HEAD changed after it started')
    }

    const currentTree = baseline.endWorktreeTree ?? (await this.snapshotWorktree())
    const endIndexTree = baseline.endIndexTree ?? (await this.git(['write-tree'], env))
    const changedFiles = this.parseNameStatus(
      await this.git(
        ['diff', '--no-renames', '--name-status', '-z', baseline.worktreeTree, currentTree],
        env,
        false,
      ),
    )
    const exposedIgnoredPaths = changedFiles
      .filter((file) => file.statusCode === 'A')
      .map((file) => file.path)
      .filter((path) => this.wasIgnoredAtStart(path, baseline.ignoredPaths))
    if (exposedIgnoredPaths.length > 0) {
      throw new Error(
        `Cannot safely revert because these paths existed but were ignored before the run: ${exposedIgnoredPaths.join(', ')}`,
      )
    }
    const [worktreePatch, indexPatch] = await Promise.all([
      this.git(['diff', '--binary', baseline.worktreeTree, currentTree], env, false),
      this.git(['diff', '--binary', baseline.indexTree, endIndexTree], env, false),
    ])
    await this.applyReversePatches(worktreePatch, indexPatch)

    this.baseline = null
    this.cleanupSnapshot()
  }

  accept(): void {
    this.baseline = null
    this.cleanupSnapshot()
  }

  async seal(): Promise<void> {
    const baseline = this.requireBaseline()
    if (baseline.endWorktreeTree && baseline.endIndexTree) return
    const env = this.requireSnapshotEnv()
    const [endWorktreeTree, endIndexTree] = await Promise.all([
      this.snapshotWorktree(),
      this.git(['write-tree'], env),
    ])
    baseline.endWorktreeTree = endWorktreeTree
    baseline.endIndexTree = endIndexTree
  }

  isActive(): boolean {
    return this.baseline !== null
  }

  isSealed(): boolean {
    return !!(this.baseline?.endWorktreeTree && this.baseline.endIndexTree)
  }

  private requireBaseline(): Baseline {
    if (!this.baseline) throw new Error('No agent run change baseline is active')
    return this.baseline
  }

  private async snapshotWorktree(): Promise<string> {
    const dir = createRunTempDir('git-index')
    const indexFile = join(dir, 'index')
    const env = { ...this.requireSnapshotEnv(), GIT_INDEX_FILE: indexFile }
    try {
      await this.git(['read-tree', 'HEAD'], env)
      await this.git(['add', '-A'], env)
      return await this.git(['write-tree'], env)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private requireSnapshotEnv(): NodeJS.ProcessEnv {
    if (!this.snapshotEnv) throw new Error('No private Git snapshot store is active')
    return this.snapshotEnv
  }

  private cleanupSnapshot(): void {
    if (this.snapshotDir) rmSync(this.snapshotDir, { recursive: true, force: true })
    this.snapshotDir = null
    this.snapshotEnv = null
  }

  private parseNameStatus(value: string): RunChangedFile[] {
    const tokens = value.split('\0').filter(Boolean)
    const files: RunChangedFile[] = []
    for (let index = 0; index < tokens.length; index += 2) {
      const statusCode = tokens[index]?.slice(0, 1) ?? '?'
      const path = tokens[index + 1]
      if (!path) break
      files.push({ path, statusCode, staged: false, unstaged: true })
    }
    return files
  }

  private wasIgnoredAtStart(path: string, ignoredPaths: readonly string[]): boolean {
    const normalizedPath = path.replace(/\\/g, '/')
    return ignoredPaths.some((ignoredPath) => {
      const normalizedIgnored = ignoredPath.replace(/\\/g, '/')
      return normalizedIgnored.endsWith('/')
        ? normalizedPath.startsWith(normalizedIgnored)
        : normalizedPath === normalizedIgnored
    })
  }

  private async applyReversePatches(worktreePatch: string, indexPatch: string): Promise<void> {
    const dir = createRunTempDir('git-patch')
    const worktreePatchFile = join(dir, 'worktree.patch')
    const indexPatchFile = join(dir, 'index.patch')
    try {
      const env = this.requireSnapshotEnv()
      if (worktreePatch) {
        writeFileSync(worktreePatchFile, worktreePatch, 'utf-8')
        await this.git(['apply', '--check', '--reverse', '--binary', worktreePatchFile], env)
      }
      if (indexPatch) {
        writeFileSync(indexPatchFile, indexPatch, 'utf-8')
        await this.git(
          ['apply', '--cached', '--check', '--reverse', '--binary', indexPatchFile],
          env,
        )
      }
      if (worktreePatch) {
        await this.git(
          ['apply', '--reverse', '--binary', '--whitespace=nowarn', worktreePatchFile],
          env,
        )
      }
      if (indexPatch) {
        await this.git(
          ['apply', '--cached', '--reverse', '--binary', '--whitespace=nowarn', indexPatchFile],
          env,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async git(args: string[], env = process.env, trim = true): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['-C', this.cwd, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
        {
          encoding: 'utf-8',
          env,
          maxBuffer: GIT_BUFFER_LIMIT,
          windowsHide: true,
        },
      )
      const output = stdout || stderr
      return trim ? output.trim() : output
    } catch (err) {
      const error = err as Error & { stdout?: string; stderr?: string }
      const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
      throw new Error(output || `git ${args.join(' ')} failed`)
    }
  }
}

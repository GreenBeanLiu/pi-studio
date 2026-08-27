import { createHash, randomUUID } from 'crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import type { LocalBackupSummary } from '../shared/ipc/contract'

/**
 * 启动快照必须早于任何 SQLite 写连接：这样主库与遗留 WAL/SHM 都静止，普通文件复制也能得到一致恢复点。
 * 恢复同样只能发生在启动早期；运行中只写恢复计划，下一次启动先校验、留保护点，再用可回滚的文件替换恢复。
 * 这里只保护体积可控的配置和结构化状态；会话、媒体与日志可能无限增长，不能阻塞桌面端启动。
 */
const BACKUP_DIRECTORY = 'backups'
const PENDING_RESTORE_FILE = '.restore-pending.json'
const FAILED_RESTORE_FILE = '.restore-failed.json'
const DEFAULT_RETENTION = 7
const RECOVERY_POINT_RETENTION = 3
const DAILY_BACKUP_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const RECOVERY_POINT_PATTERN = /^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

export const LOCAL_BACKUP_FILES = [
  'settings.json',
  'channels.json',
  'security-policies.json',
  'routines.json',
  'routines.sqlite3',
  'routines.sqlite3-wal',
  'routines.sqlite3-shm',
  'cloud-sync.json',
  'cloud-sync-outbox.json',
  join('pi-agent', 'acp-sessions.json'),
  join('pi-agent', 'shared-memory.json'),
  join('pi-agent', 'shared-memory.sqlite3'),
  join('pi-agent', 'shared-memory.sqlite3-wal'),
  join('pi-agent', 'shared-memory.sqlite3-shm'),
] as const

type BackupFileManifest = { path: string; bytes: number; sha256: string }
type BackupManifest = {
  version: 1
  createdAt: string
  appVersion: string | null
  kind?: 'daily' | 'pre-restore'
  files: BackupFileManifest[]
}

export type StartupBackupResult = {
  status: 'created' | 'already-exists' | 'no-data'
  directory: string | null
  files: number
  removed: number
}

export type PendingRestoreResult = {
  status: 'none' | 'restored' | 'failed'
  backupName?: string
  protectionBackup?: string | null
  error?: string
}

function normalizeManifestPath(path: string): string {
  return path.replaceAll('\\', '/')
}

const ALLOWED_MANIFEST_PATHS = new Set<string>(LOCAL_BACKUP_FILES.map(normalizeManifestPath))

function sha256(path: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const file = openSync(path, 'r')
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(file, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(file)
  }
  return hash.digest('hex')
}

function isBackupName(name: string): boolean {
  return DAILY_BACKUP_PATTERN.test(name) || RECOVERY_POINT_PATTERN.test(name)
}

function parseManifest(directory: string): BackupManifest {
  const raw = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest.json 格式无效')
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || typeof record.createdAt !== 'string' || !Array.isArray(record.files)) {
    throw new Error('manifest.json 版本或字段无效')
  }
  const seen = new Set<string>()
  const files = record.files.map((value): BackupFileManifest => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件清单格式无效')
    const file = value as Record<string, unknown>
    const path = typeof file.path === 'string' ? normalizeManifestPath(file.path) : ''
    if (!ALLOWED_MANIFEST_PATHS.has(path) || seen.has(path)) throw new Error(`文件清单路径无效：${path || '(empty)'}`)
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`文件大小无效：${path}`)
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`文件校验值无效：${path}`)
    }
    seen.add(path)
    return { path, bytes: file.bytes, sha256: file.sha256 }
  })
  return {
    version: 1,
    createdAt: record.createdAt,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : null,
    kind: record.kind === 'pre-restore' ? 'pre-restore' : 'daily',
    files,
  }
}

function validateBackupFiles(directory: string, manifest: BackupManifest, verifyHash: boolean): void {
  for (const file of manifest.files) {
    const path = join(directory, ...file.path.split('/'))
    if (!existsSync(path) || statSync(path).size !== file.bytes) throw new Error(`备份文件缺失或大小不符：${file.path}`)
    if (verifyHash && sha256(path) !== file.sha256) throw new Error(`备份文件校验失败：${file.path}`)
  }
}

function pruneMatchingBackups(root: string, pattern: RegExp, retention: number): number {
  if (!existsSync(root)) return 0
  const backups = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const expired = backups.slice(0, Math.max(0, backups.length - retention))
  for (const name of expired) rmSync(join(root, name), { recursive: true, force: true })
  return expired.length
}

function createDataBackup(
  userData: string,
  name: string,
  options: { now: Date; appVersion?: string; kind: 'daily' | 'pre-restore' },
): StartupBackupResult {
  const root = join(userData, BACKUP_DIRECTORY)
  const destination = join(root, name)
  if (existsSync(destination)) return { status: 'already-exists', directory: destination, files: 0, removed: 0 }
  const sources = LOCAL_BACKUP_FILES.filter((relativePath) => existsSync(join(userData, relativePath)))
  if (sources.length === 0) return { status: 'no-data', directory: null, files: 0, removed: 0 }

  mkdirSync(root, { recursive: true })
  const temporary = join(root, `.tmp-${name}-${randomUUID()}`)
  mkdirSync(temporary)
  try {
    const files = sources.map((relativePath): BackupFileManifest => {
      const source = join(userData, relativePath)
      const target = join(temporary, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      return { path: normalizeManifestPath(relativePath), bytes: statSync(target).size, sha256: sha256(target) }
    })
    const manifest: BackupManifest = {
      version: 1,
      createdAt: options.now.toISOString(),
      appVersion: options.appVersion ?? null,
      kind: options.kind,
      files,
    }
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(temporary, destination)
    return { status: 'created', directory: destination, files: files.length, removed: 0 }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function createStartupDataBackup(
  userData: string,
  options: { now?: Date; retention?: number; appVersion?: string } = {},
): StartupBackupResult {
  const now = options.now ?? new Date()
  const retention = Math.max(1, Math.floor(options.retention ?? DEFAULT_RETENTION))
  const result = createDataBackup(userData, now.toISOString().slice(0, 10), {
    now,
    appVersion: options.appVersion,
    kind: 'daily',
  })
  return {
    ...result,
    removed: pruneMatchingBackups(join(userData, BACKUP_DIRECTORY), DAILY_BACKUP_PATTERN, retention),
  }
}

export function listLocalDataBackups(userData: string): LocalBackupSummary[] {
  const root = join(userData, BACKUP_DIRECTORY)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isBackupName(entry.name))
    .map((entry): LocalBackupSummary => {
      try {
        const directory = join(root, entry.name)
        const manifest = parseManifest(directory)
        validateBackupFiles(directory, manifest, false)
        return {
          name: entry.name,
          createdAt: manifest.createdAt,
          appVersion: manifest.appVersion,
          kind: manifest.kind,
          fileCount: manifest.files.length,
          status: 'ready',
        }
      } catch (error) {
        return {
          name: entry.name,
          createdAt: entry.name,
          status: 'invalid',
          error: error instanceof Error ? error.message : '备份无效',
        }
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function scheduleDataRestore(userData: string, backupName: string): void {
  if (!isBackupName(backupName)) throw new Error('备份名称无效')
  const directory = join(userData, BACKUP_DIRECTORY, backupName)
  const manifest = parseManifest(directory)
  validateBackupFiles(directory, manifest, true)
  const pending = join(userData, PENDING_RESTORE_FILE)
  const temporary = `${pending}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, backupName, requestedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  rmSync(pending, { force: true })
  renameSync(temporary, pending)
}

function readPendingRestore(userData: string): string | null {
  const pending = join(userData, PENDING_RESTORE_FILE)
  if (!existsSync(pending)) return null
  const raw = JSON.parse(readFileSync(pending, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('恢复计划格式无效')
  const backupName = (raw as Record<string, unknown>).backupName
  if (typeof backupName !== 'string' || !isBackupName(backupName)) throw new Error('恢复计划中的备份名称无效')
  return backupName
}

function writeRestoreFailure(userData: string, backupName: string | null, error: unknown): void {
  writeFileSync(
    join(userData, FAILED_RESTORE_FILE),
    `${JSON.stringify({
      failedAt: new Date().toISOString(),
      backupName,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`,
    'utf8',
  )
}

export function applyPendingDataRestore(
  userData: string,
  options: { now?: Date; appVersion?: string } = {},
): PendingRestoreResult {
  const pending = join(userData, PENDING_RESTORE_FILE)
  if (!existsSync(pending)) return { status: 'none' }
  let backupName: string | null = null
  const stage = join(userData, `.restore-stage-${randomUUID()}`)
  const rollback = join(userData, `.restore-rollback-${randomUUID()}`)
  const processed: string[] = []
  try {
    backupName = readPendingRestore(userData)
    if (!backupName) return { status: 'none' }
    const backupDirectory = join(userData, BACKUP_DIRECTORY, backupName)
    const manifest = parseManifest(backupDirectory)
    validateBackupFiles(backupDirectory, manifest, true)

    const now = options.now ?? new Date()
    const protection = createDataBackup(userData, `pre-restore-${now.toISOString().replace(/[:.]/g, '-')}`, {
      now,
      appVersion: options.appVersion,
      kind: 'pre-restore',
    })
    const filesByPath = new Map(manifest.files.map((file) => [file.path, file]))
    mkdirSync(stage)
    for (const relativePath of LOCAL_BACKUP_FILES) {
      const normalized = normalizeManifestPath(relativePath)
      const file = filesByPath.get(normalized)
      if (!file) continue
      const source = join(backupDirectory, ...normalized.split('/'))
      const staged = join(stage, relativePath)
      mkdirSync(dirname(staged), { recursive: true })
      copyFileSync(source, staged)
      if (statSync(staged).size !== file.bytes || sha256(staged) !== file.sha256) {
        throw new Error(`恢复暂存校验失败：${normalized}`)
      }
    }

    mkdirSync(rollback)
    for (const relativePath of LOCAL_BACKUP_FILES) {
      const destination = join(userData, relativePath)
      const previous = join(rollback, relativePath)
      const staged = join(stage, relativePath)
      processed.push(relativePath)
      if (existsSync(destination)) {
        mkdirSync(dirname(previous), { recursive: true })
        renameSync(destination, previous)
      }
      if (existsSync(staged)) {
        mkdirSync(dirname(destination), { recursive: true })
        renameSync(staged, destination)
      }
    }

    rmSync(stage, { recursive: true, force: true })
    rmSync(rollback, { recursive: true, force: true })
    rmSync(pending, { force: true })
    rmSync(join(userData, FAILED_RESTORE_FILE), { force: true })
    pruneMatchingBackups(join(userData, BACKUP_DIRECTORY), RECOVERY_POINT_PATTERN, RECOVERY_POINT_RETENTION)
    return { status: 'restored', backupName, protectionBackup: protection.directory }
  } catch (error) {
    for (const relativePath of processed.reverse()) {
      const destination = join(userData, relativePath)
      const previous = join(rollback, relativePath)
      rmSync(destination, { force: true })
      if (existsSync(previous)) {
        mkdirSync(dirname(destination), { recursive: true })
        renameSync(previous, destination)
      }
    }
    rmSync(stage, { recursive: true, force: true })
    rmSync(rollback, { recursive: true, force: true })
    rmSync(pending, { force: true })
    writeRestoreFailure(userData, backupName, error)
    return {
      status: 'failed',
      ...(backupName ? { backupName } : {}),
      error: error instanceof Error ? error.message : '恢复失败',
    }
  }
}

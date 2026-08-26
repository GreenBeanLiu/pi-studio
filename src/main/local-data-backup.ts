import { createHash, randomUUID } from 'crypto'
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'

/**
 * 启动快照必须早于任何 SQLite 写连接：这样主库与遗留 WAL/SHM 都静止，普通文件复制也能得到一致恢复点。
 * 这里只保护体积可控的配置和结构化状态；会话、媒体与日志可能无限增长，不能阻塞桌面端启动。
 */
const BACKUP_DIRECTORY = 'backups'
const DEFAULT_RETENTION = 7
const DAILY_BACKUP_PATTERN = /^\d{4}-\d{2}-\d{2}$/

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

type BackupFileManifest = {
  path: string
  bytes: number
  sha256: string
}

type BackupManifest = {
  version: 1
  createdAt: string
  appVersion: string | null
  files: BackupFileManifest[]
}

export type StartupBackupResult = {
  status: 'created' | 'already-exists' | 'no-data'
  directory: string | null
  files: number
  removed: number
}

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

function pruneBackups(root: string, retention: number): number {
  if (!existsSync(root)) return 0
  const backups = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DAILY_BACKUP_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const expired = backups.slice(0, Math.max(0, backups.length - retention))
  for (const name of expired) rmSync(join(root, name), { recursive: true, force: true })
  return expired.length
}

export function createStartupDataBackup(
  userData: string,
  options: { now?: Date; retention?: number; appVersion?: string } = {},
): StartupBackupResult {
  const now = options.now ?? new Date()
  const retention = Math.max(1, Math.floor(options.retention ?? DEFAULT_RETENTION))
  const root = join(userData, BACKUP_DIRECTORY)
  const backupName = now.toISOString().slice(0, 10)
  const destination = join(root, backupName)

  if (existsSync(destination)) {
    return {
      status: 'already-exists',
      directory: destination,
      files: 0,
      removed: pruneBackups(root, retention),
    }
  }

  const sources = LOCAL_BACKUP_FILES.filter((relativePath) => existsSync(join(userData, relativePath)))
  if (sources.length === 0) {
    return { status: 'no-data', directory: null, files: 0, removed: pruneBackups(root, retention) }
  }

  mkdirSync(root, { recursive: true })
  const temporary = join(root, `.tmp-${backupName}-${randomUUID()}`)
  mkdirSync(temporary)
  try {
    const files = sources.map((relativePath): BackupFileManifest => {
      const source = join(userData, relativePath)
      const target = join(temporary, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      return {
        path: relativePath.replaceAll('\\', '/'),
        bytes: statSync(target).size,
        sha256: sha256(target),
      }
    })
    const manifest: BackupManifest = {
      version: 1,
      createdAt: now.toISOString(),
      appVersion: options.appVersion ?? null,
      files,
    }
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(temporary, destination)
    return {
      status: 'created',
      directory: destination,
      files: files.length,
      removed: pruneBackups(root, retention),
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

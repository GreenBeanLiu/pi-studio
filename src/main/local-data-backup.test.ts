import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPendingDataRestore,
  createStartupDataBackup,
  listLocalDataBackups,
  scheduleDataRestore,
} from './local-data-backup'

const directories: string[] = []

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-studio-backup-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

describe('startup data backup', () => {
  it('atomically copies critical state with an integrity manifest', () => {
    const userData = fixture()
    mkdirSync(join(userData, 'pi-agent'))
    writeFileSync(join(userData, 'settings.json'), '{"theme":"dark"}\n')
    writeFileSync(join(userData, 'routines.sqlite3'), 'sqlite fixture')
    writeFileSync(join(userData, 'routines.sqlite3-wal'), 'wal fixture')
    writeFileSync(join(userData, 'pi-agent', 'acp-sessions.json'), '{"sessions":[]}')
    writeFileSync(join(userData, 'pi-agent', 'shared-memory.sqlite3'), 'memory fixture')

    const result = createStartupDataBackup(userData, {
      now: new Date('2026-08-26T01:02:03.000Z'),
      appVersion: '0.12.0',
    })

    expect(result.status).toBe('created')
    expect(result.files).toBe(5)
    expect(readFileSync(join(result.directory!, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n')
    const manifest = JSON.parse(readFileSync(join(result.directory!, 'manifest.json'), 'utf8')) as {
      appVersion: string
      files: Array<{ path: string; bytes: number; sha256: string }>
    }
    expect(manifest.appVersion).toBe('0.12.0')
    expect(manifest.files.map((file) => file.path)).toEqual([
      'settings.json',
      'routines.sqlite3',
      'routines.sqlite3-wal',
      'pi-agent/acp-sessions.json',
      'pi-agent/shared-memory.sqlite3',
    ])
    const settings = manifest.files[0]
    expect(settings.bytes).toBe(Buffer.byteLength('{"theme":"dark"}\n'))
    expect(settings.sha256).toBe(createHash('sha256').update('{"theme":"dark"}\n').digest('hex'))
  })

  it('creates at most one backup per day', () => {
    const userData = fixture()
    writeFileSync(join(userData, 'settings.json'), 'first')
    const first = createStartupDataBackup(userData, { now: new Date('2026-08-26T01:00:00.000Z') })
    writeFileSync(join(userData, 'settings.json'), 'second')
    const second = createStartupDataBackup(userData, { now: new Date('2026-08-26T23:00:00.000Z') })

    expect(first.status).toBe('created')
    expect(second.status).toBe('already-exists')
    expect(readFileSync(join(first.directory!, 'settings.json'), 'utf8')).toBe('first')
  })

  it('retains only the newest configured number of daily backups', () => {
    const userData = fixture()
    writeFileSync(join(userData, 'settings.json'), 'state')
    for (const day of ['01', '02', '03', '04']) {
      createStartupDataBackup(userData, {
        now: new Date(`2026-08-${day}T01:00:00.000Z`),
        retention: 3,
      })
    }

    const backups = ['01', '02', '03', '04'].map((day) => join(userData, 'backups', `2026-08-${day}`))
    expect(() => readFileSync(join(backups[0], 'manifest.json'))).toThrow()
    for (const backup of backups.slice(1)) {
      expect(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')).version).toBe(1)
    }
  })

  it('does not create an empty backup directory', () => {
    const userData = fixture()
    expect(createStartupDataBackup(userData).status).toBe('no-data')
  })

  it('lists valid and structurally broken recovery points', () => {
    const userData = fixture()
    writeFileSync(join(userData, 'settings.json'), 'state')
    const valid = createStartupDataBackup(userData, { now: new Date('2026-08-26T01:00:00.000Z') })
    mkdirSync(join(userData, 'backups', '2026-08-25'))
    writeFileSync(join(userData, 'backups', '2026-08-25', 'manifest.json'), '{}')

    expect(listLocalDataBackups(userData)).toEqual([
      expect.objectContaining({ name: '2026-08-26', status: 'ready', fileCount: 1 }),
      expect.objectContaining({ name: '2026-08-25', status: 'invalid' }),
    ])
    expect(valid.directory).not.toBeNull()
  })

  it('rejects a tampered backup before scheduling a restart', () => {
    const userData = fixture()
    writeFileSync(join(userData, 'settings.json'), 'first')
    const backup = createStartupDataBackup(userData, { now: new Date('2026-08-26T01:00:00.000Z') })
    writeFileSync(join(backup.directory!, 'settings.json'), 'other')

    expect(() => scheduleDataRestore(userData, '2026-08-26')).toThrow('校验失败')
    expect(existsSync(join(userData, '.restore-pending.json'))).toBe(false)
    expect(() => scheduleDataRestore(userData, '../escape')).toThrow('备份名称无效')
  })

  it('restores exact state before databases open and preserves a protection point', () => {
    const userData = fixture()
    writeFileSync(join(userData, 'settings.json'), 'old settings')
    writeFileSync(join(userData, 'routines.sqlite3'), 'old database')
    createStartupDataBackup(userData, { now: new Date('2026-08-26T01:00:00.000Z') })

    writeFileSync(join(userData, 'settings.json'), 'current settings')
    writeFileSync(join(userData, 'routines.sqlite3'), 'current database')
    writeFileSync(join(userData, 'channels.json'), 'newer only')
    scheduleDataRestore(userData, '2026-08-26')
    const restored = applyPendingDataRestore(userData, {
      now: new Date('2026-08-27T02:03:04.005Z'),
      appVersion: '0.12.0',
    })

    expect(restored).toMatchObject({ status: 'restored', backupName: '2026-08-26' })
    expect(readFileSync(join(userData, 'settings.json'), 'utf8')).toBe('old settings')
    expect(readFileSync(join(userData, 'routines.sqlite3'), 'utf8')).toBe('old database')
    expect(existsSync(join(userData, 'channels.json'))).toBe(false)
    expect(existsSync(join(userData, '.restore-pending.json'))).toBe(false)
    expect(readFileSync(join(restored.protectionBackup!, 'settings.json'), 'utf8')).toBe('current settings')
    expect(readFileSync(join(restored.protectionBackup!, 'channels.json'), 'utf8')).toBe('newer only')
  })
})

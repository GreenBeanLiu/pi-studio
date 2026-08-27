import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('pending data restore startup ordering', () => {
  it('restores before snapshots, IPC handlers, and SQLite services can open stores', () => {
    const restore = main.indexOf('const restore = applyPendingDataRestore(')
    const backup = main.indexOf('const backup = createStartupDataBackup(')
    const ipcRegistration = main.indexOf('registerIpcHandlers()')
    const memoryService = main.indexOf('startSharedMemoryService(')

    expect(restore).toBeGreaterThan(-1)
    expect(restore).toBeLessThan(backup)
    expect(restore).toBeLessThan(ipcRegistration)
    expect(restore).toBeLessThan(memoryService)
  })
})

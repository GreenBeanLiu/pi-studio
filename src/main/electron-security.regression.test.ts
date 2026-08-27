import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8')
const electronViteConfig = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')

describe('Electron renderer security', () => {
  it('keeps the renderer isolated and sandboxed', () => {
    expect(main).toContain('sandbox: true')
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('webSecurity: true')
    expect(main).not.toContain('sandbox: false')
  })

  it('loads a CommonJS preload script in the sandboxed renderer', () => {
    expect(main).toContain("preload: join(import.meta.dirname, '../preload/index.cjs')")
    expect(main).not.toContain('../preload/index.mjs')
    expect(electronViteConfig).toContain("format: 'cjs'")
    expect(electronViteConfig).toContain("entryFileNames: '[name].cjs'")
  })

  it('only exposes the typed desktop API from preload', () => {
    expect(preload).toContain("contextBridge.exposeInMainWorld('api', api)")
    expect(preload).not.toContain('@electron-toolkit/preload')
    expect(preload).not.toContain("exposeInMainWorld('electron'")
    expect(preload).not.toContain('process.env')
  })

  it('backs up persistent state before stores are opened', () => {
    const restore = main.indexOf('const restore = applyPendingDataRestore(')
    const backup = main.indexOf('const backup = createStartupDataBackup(')
    const ipcRegistration = main.indexOf('registerIpcHandlers()')
    const memoryService = main.indexOf('startSharedMemoryService(')
    expect(restore).toBeGreaterThan(-1)
    expect(restore).toBeLessThan(backup)
    expect(backup).toBeGreaterThan(-1)
    expect(backup).toBeLessThan(ipcRegistration)
    expect(backup).toBeLessThan(memoryService)
  })
})

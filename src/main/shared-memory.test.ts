import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SharedMemoryStore } from './shared-memory'

describe('shared memory store', () => {
  it('saves global and workspace memories and searches visible entries', () => {
    const store = new SharedMemoryStore(join(mkdtempSync(join(tmpdir(), 'pi-studio-memory-')), 'memory.json'))
    store.save({ content: 'The API gateway uses profile routes.', tags: ['gateway'], source: 'test' })
    store.save({ content: 'Run pnpm verify before packaging.', scope: 'workspace', workspacePath: 'D:/Works/pi-studio', source: 'test' })
    store.save({ content: 'other-project-secret-marker', scope: 'workspace', workspacePath: 'D:/Works/other', source: 'test' })

    expect(store.search('gateway', 'D:/Works/pi-studio')).toHaveLength(1)
    expect(store.search('pnpm verify', 'D:/Works/pi-studio')[0]?.entry.content).toContain('pnpm verify')
    expect(store.search('other-project-secret-marker', 'D:/Works/pi-studio')).toHaveLength(0)
    expect(store.list('D:/Works/pi-studio')).toHaveLength(2)
  })

  it('deduplicates identical entries and deletes by id', () => {
    const store = new SharedMemoryStore(join(mkdtempSync(join(tmpdir(), 'pi-studio-memory-')), 'memory.json'))
    const first = store.save({ content: 'Use SQLite for local state.', source: 'one' })
    const second = store.save({ content: 'Use SQLite for local state.', source: 'two', tags: ['database'] })

    expect(second.id).toBe(first.id)
    expect(store.count()).toBe(1)
    expect(store.delete(first.id)).toBe(true)
    expect(store.delete(first.id)).toBe(false)
    expect(store.count()).toBe(0)
  })
})

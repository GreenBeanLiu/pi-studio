import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SharedMemoryStore,
  sharedMemoryPaths,
  startSharedMemoryService,
  stopSharedMemoryService,
} from './shared-memory'

function newStore(): SharedMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'pi-studio-memory-'))
  return new SharedMemoryStore(join(dir, 'shared-memory.sqlite3'))
}

describe('shared memory store', () => {
  it('saves global and workspace memories and searches visible entries', () => {
    const store = newStore()
    store.save({ content: 'The API gateway uses profile routes.', tags: ['gateway'], source: 'test' })
    store.save({ content: 'Run pnpm verify before packaging.', scope: 'workspace', workspacePath: 'D:/Works/pi-studio', source: 'test' })
    store.save({ content: 'other-project-secret-marker', scope: 'workspace', workspacePath: 'D:/Works/other', source: 'test' })

    expect(store.search('gateway', 'D:/Works/pi-studio')).toHaveLength(1)
    expect(store.search('pnpm verify', 'D:/Works/pi-studio')[0]?.entry.content).toContain('pnpm verify')
    expect(store.search('other-project-secret-marker', 'D:/Works/pi-studio')).toHaveLength(0)
    expect(store.list('D:/Works/pi-studio')).toHaveLength(2)
    store.close()
  })

  it('deduplicates identical entries and deletes by id', () => {
    const store = newStore()
    const first = store.save({ content: 'Use SQLite for local state.', source: 'one' })
    const second = store.save({ content: 'Use SQLite for local state.', source: 'two', tags: ['database'] })

    expect(second.id).toBe(first.id)
    expect(store.count()).toBe(1)
    expect(store.list()[0]?.tags).toEqual(['database'])
    expect(store.delete(first.id)).toBe(true)
    expect(store.delete(first.id)).toBe(false)
    expect(store.count()).toBe(0)
    store.close()
  })

  it('finds Chinese memories by a partial phrase that is not a substring', () => {
    const store = newStore()
    store.save({ content: '打包命令是 pnpm package:mac', tags: ['release'], source: 'test' })
    store.save({ content: '沙箱模式下 loopback 不通,记忆服务要走降级路径', source: 'test' })

    // 迁移前这三个查询全是 0 命中:整段汉字被当成一个 token,只有字面子串才匹配
    expect(store.search('打包')[0]?.entry.content).toContain('打包命令')
    expect(store.search('怎么打包')[0]?.entry.content).toContain('打包命令')
    expect(store.search('记忆服务怎么降级')[0]?.entry.content).toContain('降级路径')
    expect(store.search('完全无关的查询词')).toHaveLength(0)
    store.close()
  })

  it('ranks the better match first and keeps scores positive', () => {
    const store = newStore()
    store.save({ content: '打包命令是 pnpm package:mac', source: 'test' })
    store.save({ content: '发布前运行 pnpm verify 再打包', source: 'test' })

    const results = store.search('打包命令')
    expect(results[0]?.entry.content).toContain('打包命令')
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    store.close()
  })

  it('lists the most recent entries when the query has no usable token', () => {
    const store = newStore()
    store.save({ content: 'first', source: 'test' })
    store.save({ content: 'second', source: 'test' })
    expect(store.search('***')).toHaveLength(2)
    store.close()
  })

  it('imports the legacy JSON database once and backs it up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-memory-'))
    const paths = sharedMemoryPaths(join(dir, 'shared-memory.sqlite3'))
    writeFileSync(
      paths.legacyJson,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'legacy-1',
            content: '发布前运行 pnpm verify',
            scope: 'global',
            workspacePath: null,
            tags: ['release'],
            source: 'codex',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            accessCount: 4,
          },
          { content: '   ' },
        ],
      }),
      'utf8',
    )

    const store = new SharedMemoryStore(paths.database)
    expect(store.count()).toBe(1)
    const imported = store.list()[0]!
    expect(imported.id).toBe('legacy-1')
    expect(imported.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(imported.accessCount).toBe(4)
    expect(store.search('pnpm verify')).toHaveLength(1)
    expect(existsSync(`${paths.legacyJson}.backup-v1`)).toBe(true)
    store.close()

    // 重开不该再导一次
    const reopened = new SharedMemoryStore(paths.database)
    expect(reopened.count()).toBe(1)
    reopened.close()
  })

  it('mirrors the database into a read-only snapshot for sandboxed agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-memory-'))
    const paths = sharedMemoryPaths(join(dir, 'shared-memory.sqlite3'))
    const store = new SharedMemoryStore(paths.database)
    const saved = store.save({ content: '沙箱里读得到这条', scope: 'workspace', workspacePath: dir, source: 'test' })

    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8')) as {
      version: number
      entries: { id: string; content: string }[]
    }
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.map((entry) => entry.content)).toEqual(['沙箱里读得到这条'])

    store.delete(saved.id)
    const afterDelete = JSON.parse(readFileSync(paths.snapshot, 'utf8')) as { entries: unknown[] }
    expect(afterDelete.entries).toHaveLength(0)
    store.close()
  })

  it('survives a long prompt with many distinct tokens', () => {
    const store = newStore()
    store.save({ content: '打包命令是 pnpm package:mac', source: 'test' })
    // before_agent_start 直接把整条 prompt 当查询用,MATCH 表达式会长到上千个 OR
    const long = Array.from({ length: 1500 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('') + ' 打包命令'
    const results = store.search(long)
    expect(results[0]?.entry.content).toContain('打包命令')
    store.close()
  })

  it('rejects empty content and workspace memories without a path', () => {
    const store = newStore()
    expect(() => store.save({ content: '  ' })).toThrow(/must not be empty/)
    expect(() => store.save({ content: 'x', scope: 'workspace' })).toThrow(/requires workspacePath/)
    store.close()
  })
})

describe('shared memory service', () => {
  afterEach(async () => {
    await stopSharedMemoryService()
  })

  it('serves the store over loopback and cleans up the old connection file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-memory-'))
    const paths = sharedMemoryPaths(join(dir, 'shared-memory.sqlite3'))
    // 迁移前的连接文件指向一个早就关掉的端口,启动时必须清掉
    writeFileSync(`${paths.legacyJson}.connection.json`, '{"url":"http://127.0.0.1:1"}', 'utf8')

    const connection = await startSharedMemoryService(paths.database)
    expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(existsSync(paths.connection)).toBe(true)
    expect(existsSync(`${paths.legacyJson}.connection.json`)).toBe(false)

    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }
    const saved = await fetch(`${connection.url}/v1/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: '打包命令是 pnpm package:mac', scope: 'global', source: 'test' }),
    })
    expect(saved.status).toBe(201)

    const found = await fetch(`${connection.url}/v1/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: '怎么打包' }),
    })
    const body = (await found.json()) as { results: { entry: { content: string } }[] }
    expect(body.results[0]?.entry.content).toContain('打包命令')

    const unauthorized = await fetch(`${connection.url}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    expect(unauthorized.status).toBe(401)
  })

  it('removes the connection file when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-studio-memory-'))
    const paths = sharedMemoryPaths(join(dir, 'shared-memory.sqlite3'))
    await startSharedMemoryService(paths.database)
    await stopSharedMemoryService()
    expect(existsSync(paths.connection)).toBe(false)
  })
})

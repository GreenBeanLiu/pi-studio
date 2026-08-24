import { randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join, resolve, win32 } from 'path'
import { buildMatchExpression, segmentSearchText } from './memory-segment'

export type SharedMemoryScope = 'global' | 'workspace'

export type SharedMemoryEntry = {
  id: string
  content: string
  scope: SharedMemoryScope
  workspacePath: string | null
  tags: string[]
  source: string
  createdAt: string
  updatedAt: string
  accessCount: number
}

export type SharedMemorySearchResult = {
  entry: SharedMemoryEntry
  score: number
  snippet: string
}

/** 迁移前的 JSON 库,以及现在写给沙箱降级读的只读快照,共用这个形状。 */
type SharedMemoryDatabase = {
  version: 1
  entries: SharedMemoryEntry[]
}

export type SaveSharedMemoryInput = {
  content: string
  scope?: SharedMemoryScope
  workspacePath?: string | null
  tags?: string[]
  source?: string
}

export type SharedMemoryConnection = {
  url: string
  token: string
  /** SQLite 库本体。外部 Agent 不应直接开它,一律走 HTTP API。 */
  file: string
  /** 只读 JSON 快照;沙箱里 loopback 不通时的降级读取源。 */
  snapshotFile: string
  connectionFile: string
}

/** 一个共享记忆库涉及的全部路径,统一由库文件名派生,命名规则只此一处。 */
export type SharedMemoryPaths = {
  database: string
  legacyJson: string
  snapshot: string
  connection: string
}

export function sharedMemoryPaths(databaseFile: string): SharedMemoryPaths {
  const dir = dirname(databaseFile)
  const base = basename(databaseFile).replace(/\.sqlite3$/, '')
  return {
    database: databaseFile,
    legacyJson: join(dir, `${base}.json`),
    snapshot: join(dir, `${base}.snapshot.json`),
    connection: join(dir, `${base}.connection.json`),
  }
}

export class SharedMemoryUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SharedMemoryUnavailableError'
  }
}

// node:sqlite 的最小类型面,和 routine-database.ts 里那份保持一致(Node 自带类型
// 在 Electron 的 @types/node 里还没稳定下来,两处各留一份比引一个共享 shim 省事)。
type SqlValue = string | number | bigint | null | Uint8Array

type StatementSync = {
  run: (...params: SqlValue[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
  get: (...params: SqlValue[]) => Record<string, SqlValue> | undefined
  all: (...params: SqlValue[]) => Record<string, SqlValue>[]
}

type DatabaseSyncInstance = {
  exec: (sql: string) => void
  prepare: (sql: string) => StatementSync
  close: () => void
}

function openDatabase(path: string): DatabaseSyncInstance {
  let DatabaseSync: new (databasePath: string) => DatabaseSyncInstance
  try {
    // ESM 下没有裸 require;createRequire 保持同步加载
    const cjsRequire = createRequire(import.meta.url)
    ;({ DatabaseSync } = cjsRequire('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => DatabaseSyncInstance
    })
  } catch (error) {
    throw new SharedMemoryUnavailableError('This runtime does not provide node:sqlite', {
      cause: error,
    })
  }
  return new DatabaseSync(path)
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const raw = value.trim()
  const windowsPath = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')
  const normalized = windowsPath ? win32.resolve(raw) : resolve(raw)
  return process.platform === 'win32' || windowsPath ? normalized.toLowerCase() : normalized
}

function snippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= 360) return compact
  const terms = segmentSearchText(query).split(/\s+/).filter(Boolean)
  const lower = compact.toLocaleLowerCase()
  const index = terms.reduce((best, term) => {
    const found = lower.indexOf(term.toLocaleLowerCase())
    return found >= 0 && (best < 0 || found < best) ? found : best
  }, -1)
  const start = Math.max(0, (index < 0 ? 0 : index) - 100)
  return `${start > 0 ? '... ' : ''}${compact.slice(start, start + 360)}${start + 360 < compact.length ? ' ...' : ''}`
}

/** FTS5 索引文本:内容和标签一起进索引,和迁移前 haystack 的口径一致。 */
function searchText(content: string, tags: string[]): string {
  return segmentSearchText(`${content} ${tags.join(' ')}`)
}

function text(value: SqlValue): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function number(value: SqlValue): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0
}

function parseTags(value: SqlValue): string[] {
  try {
    const parsed = JSON.parse(text(value)) as unknown
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function rowToEntry(row: Record<string, SqlValue>): SharedMemoryEntry {
  return {
    id: text(row.id),
    content: text(row.content),
    scope: row.scope === 'workspace' ? 'workspace' : 'global',
    workspacePath: typeof row.workspace_path === 'string' ? row.workspace_path : null,
    tags: parseTags(row.tags_json),
    source: text(row.source),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    accessCount: number(row.access_count),
  }
}

const VISIBLE_TO_WORKSPACE = "(m.scope = 'global' OR (? IS NOT NULL AND m.workspace_path = ?))"

export class SharedMemoryStore {
  readonly paths: SharedMemoryPaths
  /** SQLite 库路径。历史字段名,连接文件和 sharedStatus 都在用。 */
  readonly file: string
  private readonly db: DatabaseSyncInstance

  constructor(
    databaseFile: string,
    private readonly onWarning: (message: string, error: unknown) => void = () => {},
  ) {
    this.paths = sharedMemoryPaths(databaseFile)
    this.file = this.paths.database
    mkdirSync(dirname(databaseFile), { recursive: true })
    this.db = openDatabase(databaseFile)
    try {
      this.initialize()
      this.importLegacyOnce()
    } catch (error) {
      this.db.close()
      throw error
    }
    this.refreshSnapshot()
  }

  close(): void {
    this.db.close()
  }

  save(input: SaveSharedMemoryInput): SharedMemoryEntry {
    const content = input.content.trim()
    if (!content) throw new Error('Memory content must not be empty')
    if (content.length > 20000) throw new Error('Memory content is too long (maximum 20000 characters)')
    const scope = input.scope ?? 'global'
    const workspacePath = scope === 'workspace' ? normalizeWorkspacePath(input.workspacePath) : null
    if (scope === 'workspace' && !workspacePath) throw new Error('Workspace memory requires workspacePath')
    const now = new Date().toISOString()
    const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20)
    const source = input.source?.trim() || 'unknown'

    const entry = this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT rowid AS row_id, * FROM memories
             WHERE content = ? AND scope = ? AND ifnull(workspace_path, '') = ifnull(?, '')`,
        )
        .get(content, scope, workspacePath)
      if (existing) {
        // 迁移前的语义:重复内容不新增,只刷新 updatedAt / source / tags 并返回原条目
        this.db
          .prepare('UPDATE memories SET updated_at = ?, source = ?, tags_json = ? WHERE rowid = ?')
          .run(now, source, JSON.stringify(tags), number(existing.row_id))
        this.db
          .prepare('UPDATE memories_fts SET seg = ? WHERE rowid = ?')
          .run(searchText(content, tags), number(existing.row_id))
        return { ...rowToEntry(existing), tags, source, updatedAt: now }
      }
      const created: SharedMemoryEntry = {
        id: randomUUID(),
        content,
        scope,
        workspacePath,
        tags,
        source,
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
      }
      this.insertEntry(created)
      return created
    })
    this.refreshSnapshot()
    return entry
  }

  search(query: string, workspacePath?: string | null, limit = 8): SharedMemorySearchResult[] {
    const cwd = normalizeWorkspacePath(workspacePath)
    const cap = Math.max(1, Math.min(limit, 20))
    const match = buildMatchExpression(query)

    // 空查询退化成「最近若干条」,和迁移前 terms.length === 0 的行为一致
    const rows = match
      ? this.db
          .prepare(
            `SELECT m.*, bm25(memories_fts) AS bm25_rank
               FROM memories_fts
               JOIN memories m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ? AND ${VISIBLE_TO_WORKSPACE}
              ORDER BY bm25(memories_fts) - min(m.access_count, 3) * 0.1, m.updated_at DESC
              LIMIT ?`,
          )
          .all(match, cwd, cwd, cap)
      : this.db
          .prepare(
            `SELECT m.*, 0 AS bm25_rank FROM memories m
              WHERE ${VISIBLE_TO_WORKSPACE}
              ORDER BY m.updated_at DESC LIMIT ?`,
          )
          .all(cwd, cwd, cap)

    const results = rows.map((row) => ({
      entry: rowToEntry(row),
      // bm25 越负越相关,取负号对外保持「越大越好」。这是同一次查询内的相对分,
      // 语料很小时 IDF 趋近 0、绝对值会非常小 —— 不要跨查询比较,也别做阈值判断
      score: match ? -number(row.bm25_rank) : 0,
      snippet: snippet(text(row.content), query),
    }))

    if (results.length > 0) {
      const ids = results.map((result) => result.entry.id)
      this.db
        .prepare(
          `UPDATE memories SET access_count = access_count + 1
            WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .run(...ids)
      // accessCount 只影响排序,降级快照不看它,这里不重写快照
    }
    return results
  }

  list(workspacePath?: string | null, limit = 100): SharedMemoryEntry[] {
    const cwd = normalizeWorkspacePath(workspacePath)
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
          WHERE ${VISIBLE_TO_WORKSPACE}
          ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .all(cwd, cwd, Math.max(1, Math.min(limit, 500)))
      .map(rowToEntry)
  }

  delete(id: string): boolean {
    const deleted = this.transaction(() => {
      const row = this.db.prepare('SELECT rowid AS row_id FROM memories WHERE id = ?').get(id)
      if (!row) return false
      this.db.prepare('DELETE FROM memories WHERE rowid = ?').run(number(row.row_id))
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(number(row.row_id))
      return true
    })
    if (deleted) this.refreshSnapshot()
    return deleted
  }

  count(): number {
    return number(this.db.prepare('SELECT COUNT(*) AS total FROM memories').get()?.total ?? 0)
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private insertEntry(entry: SharedMemoryEntry): void {
    const info = this.db
      .prepare(
        `INSERT INTO memories
           (id, content, scope, workspace_path, tags_json, source, created_at, updated_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.content,
        entry.scope,
        entry.workspacePath,
        JSON.stringify(entry.tags),
        entry.source,
        entry.createdAt,
        entry.updatedAt,
        entry.accessCount,
      )
    this.db
      .prepare('INSERT INTO memories_fts (rowid, seg) VALUES (?, ?)')
      .run(number(info.lastInsertRowid), searchText(entry.content, entry.tags))
  }

  /**
   * 沙箱里 agent 够不到 127.0.0.1,扩展会退化成读文件。写一份只读快照给它,
   * 而不是让它直接开库 —— 保证 SQLite 永远只有 main 一个写者。
   */
  private refreshSnapshot(): void {
    try {
      const database: SharedMemoryDatabase = {
        version: 1,
        entries: this.db
          .prepare('SELECT * FROM memories ORDER BY updated_at DESC')
          .all()
          .map(rowToEntry),
      }
      const temp = `${this.paths.snapshot}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify(database, null, 2), 'utf8')
      try {
        renameSync(temp, this.paths.snapshot)
      } catch {
        rmSync(this.paths.snapshot, { force: true })
        renameSync(temp, this.paths.snapshot)
      }
    } catch (error) {
      // 快照是降级用的镜像,写不出去不该让一次成功的保存失败
      this.onWarning('Failed to refresh the shared memory snapshot', error)
    }
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    const current = number(
      this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0,
    )
    if (current < 1) this.migrateToVersion1()
  }

  private migrateToVersion1(): void {
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_path TEXT,
        tags_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memories_identity_idx
        ON memories (content, scope, ifnull(workspace_path, ''));
      CREATE INDEX IF NOT EXISTS memories_scope_idx
        ON memories (scope, workspace_path, updated_at);
      CREATE VIRTUAL TABLE memories_fts
        USING fts5(seg, tokenize='unicode61 remove_diacritics 2');
      INSERT INTO schema_migrations (version, applied_at)
        VALUES (1, unixepoch('subsec') * 1000);
    `),
    )
  }

  /** routines 那边同款一次性导入:备份原 JSON,打标记,之后再不回头看。 */
  private importLegacyOnce(): void {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'legacy_json_imported'").get()) return
    const legacy = this.paths.legacyJson
    const entries: SharedMemoryEntry[] = []
    if (existsSync(legacy)) {
      try {
        const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as Partial<SharedMemoryDatabase>
        for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
          const normalized = normalizeLegacyEntry(raw)
          if (normalized) entries.push(normalized)
        }
      } catch {
        // 坏掉的旧库不该挡住服务启动;备份还在,人工可捞
      }
      if (!existsSync(`${legacy}.backup-v1`)) copyFileSync(legacy, `${legacy}.backup-v1`)
    }
    this.transaction(() => {
      const seen = new Set<string>()
      for (const entry of entries) {
        const key = `${entry.scope} ${entry.workspacePath ?? ''} ${entry.content}`
        if (seen.has(key)) continue
        seen.add(key)
        this.insertEntry(entry)
      }
      this.db
        .prepare("INSERT INTO metadata (key, value) VALUES ('legacy_json_imported', ?)")
        .run(new Date().toISOString())
    })
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function normalizeLegacyEntry(value: unknown): SharedMemoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SharedMemoryEntry>
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!content) return null
  const scope: SharedMemoryScope = raw.scope === 'workspace' ? 'workspace' : 'global'
  const workspacePath = scope === 'workspace' ? normalizeWorkspacePath(raw.workspacePath) : null
  if (scope === 'workspace' && !workspacePath) return null
  const now = new Date().toISOString()
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    content,
    scope,
    workspacePath,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    accessCount: typeof raw.accessCount === 'number' && raw.accessCount > 0 ? Math.floor(raw.accessCount) : 0,
  }
}

let server: Server | null = null
let connection: SharedMemoryConnection | null = null
let activeStore: SharedMemoryStore | null = null
let startPromise: Promise<SharedMemoryConnection> | null = null

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function authorized(req: IncomingMessage): boolean {
  return !!connection && req.headers.authorization === `Bearer ${connection.token}`
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be an object')
  return parsed as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/health' && req.method === 'GET') {
    json(res, 200, { ok: true, service: 'pi-studio-memory', version: 1 })
    return
  }
  if (!authorized(req)) {
    json(res, 401, { error: 'Unauthorized' })
    return
  }
  const store = activeStore
  if (!store) {
    json(res, 503, { error: 'Memory service is not ready' })
    return
  }

  try {
    if (url.pathname === '/v1/search' && req.method === 'POST') {
      const input = await body(req)
      const results = store.search(stringValue(input.query) ?? '', stringValue(input.workspacePath), Number(input.limit) || 8)
      json(res, 200, { results })
      return
    }
    if (url.pathname === '/v1/memories' && req.method === 'GET') {
      const entries = store.list(url.searchParams.get('workspacePath'), Number(url.searchParams.get('limit')) || 100)
      json(res, 200, { entries })
      return
    }
    if (url.pathname === '/v1/memories' && req.method === 'POST') {
      const input = await body(req)
      const entry = store.save({
        content: stringValue(input.content) ?? '',
        scope: input.scope === 'workspace' ? 'workspace' : 'global',
        workspacePath: stringValue(input.workspacePath),
        tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        source: stringValue(input.source),
      })
      json(res, 201, { entry })
      return
    }
    const match = /^\/v1\/memories\/([^/]+)$/.exec(url.pathname)
    if (match && req.method === 'DELETE') {
      json(res, 200, { deleted: store.delete(match[1]) })
      return
    }
    json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function startSharedMemoryService(
  file: string,
  onWarning?: (message: string, error: unknown) => void,
): Promise<SharedMemoryConnection> {
  if (connection && server) return connection
  if (startPromise) return startPromise
  startPromise = startSharedMemoryServiceOnce(file, onWarning)
  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

async function startSharedMemoryServiceOnce(
  file: string,
  onWarning?: (message: string, error: unknown) => void,
): Promise<SharedMemoryConnection> {
  const paths = sharedMemoryPaths(file)
  const store = new SharedMemoryStore(file, onWarning)
  const token = randomBytes(32).toString('hex')
  server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => json(res, 400, { error: String(error) }))
  })
  try {
    await new Promise<void>((resolveListen, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolveListen)
    })
  } catch (error) {
    store.close()
    server = null
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) {
    store.close()
    throw new Error('Failed to start shared memory service')
  }
  activeStore = store
  connection = {
    url: `http://127.0.0.1:${port}`,
    token,
    file: paths.database,
    snapshotFile: paths.snapshot,
    connectionFile: paths.connection,
  }
  mkdirSync(dirname(paths.connection), { recursive: true })
  writeFileSync(paths.connection, JSON.stringify(connection, null, 2), 'utf8')
  // 迁移前的连接文件叫 shared-memory.json.connection.json,留着只会把外部
  // adapter 指向一个已经关掉的端口
  rmSync(`${paths.legacyJson}.connection.json`, { force: true })
  return connection
}

export function getSharedMemoryConnection(): SharedMemoryConnection | null {
  return connection
}

/** 只在服务已启动时可用;调用方拿到 null 说明库还没开起来。 */
export function getSharedMemoryStore(): SharedMemoryStore | null {
  return activeStore
}

export async function stopSharedMemoryService(): Promise<void> {
  const current = connection
  const currentServer = server
  const currentStore = activeStore
  server = null
  startPromise = null
  connection = null
  activeStore = null
  if (currentServer) await new Promise<void>((resolveClose) => currentServer.close(() => resolveClose()))
  currentStore?.close()
  if (current) rmSync(current.connectionFile, { force: true })
}

import { randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, resolve, win32 } from 'path'

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
  file: string
  connectionFile: string
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const raw = value.trim()
  const windowsPath = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')
  const normalized = windowsPath ? win32.resolve(raw) : resolve(raw)
  return process.platform === 'win32' || windowsPath ? normalized.toLowerCase() : normalized
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
}

function snippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= 360) return compact
  const terms = tokenize(query)
  const lower = compact.toLocaleLowerCase()
  const index = terms.reduce((best, term) => {
    const found = lower.indexOf(term)
    return found >= 0 && (best < 0 || found < best) ? found : best
  }, -1)
  const start = Math.max(0, (index < 0 ? 0 : index) - 100)
  return `${start > 0 ? '... ' : ''}${compact.slice(start, start + 360)}${start + 360 < compact.length ? ' ...' : ''}`
}

function emptyDatabase(): SharedMemoryDatabase {
  return { version: 1, entries: [] }
}

export class SharedMemoryStore {
  constructor(readonly file: string) {}

  private read(): SharedMemoryDatabase {
    if (!existsSync(this.file)) return emptyDatabase()
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SharedMemoryDatabase>
      if (value.version !== 1 || !Array.isArray(value.entries)) return emptyDatabase()
      return { version: 1, entries: value.entries.filter((entry): entry is SharedMemoryEntry => !!entry && typeof entry.id === 'string' && typeof entry.content === 'string') }
    } catch {
      return emptyDatabase()
    }
  }

  private write(database: SharedMemoryDatabase): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(database, null, 2), 'utf8')
    try {
      renameSync(temp, this.file)
    } catch {
      rmSync(this.file, { force: true })
      renameSync(temp, this.file)
    }
  }

  save(input: SaveSharedMemoryInput): SharedMemoryEntry {
    const content = input.content.trim()
    if (!content) throw new Error('Memory content must not be empty')
    if (content.length > 20000) throw new Error('Memory content is too long (maximum 20000 characters)')
    const scope = input.scope ?? 'global'
    const workspacePath = scope === 'workspace' ? normalizeWorkspacePath(input.workspacePath) : null
    if (scope === 'workspace' && !workspacePath) throw new Error('Workspace memory requires workspacePath')
    const now = new Date().toISOString()
    const entry: SharedMemoryEntry = {
      id: randomUUID(),
      content,
      scope,
      workspacePath,
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
      source: input.source?.trim() || 'unknown',
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    }
    const database = this.read()
    const duplicate = database.entries.find(
      (candidate) =>
        candidate.content === entry.content &&
        candidate.scope === entry.scope &&
        candidate.workspacePath === entry.workspacePath,
    )
    if (duplicate) {
      duplicate.updatedAt = now
      duplicate.source = entry.source
      duplicate.tags = entry.tags
      this.write(database)
      return duplicate
    }
    database.entries.push(entry)
    this.write(database)
    return entry
  }

  search(query: string, workspacePath?: string | null, limit = 8): SharedMemorySearchResult[] {
    const terms = tokenize(query)
    const cwd = normalizeWorkspacePath(workspacePath)
    const results = this.read().entries
      .filter((entry) => entry.scope === 'global' || (!!cwd && entry.workspacePath === cwd))
      .map((entry) => {
        const haystack = `${entry.content} ${entry.tags.join(' ')}`.toLocaleLowerCase()
        const phrase = query.trim().toLocaleLowerCase()
        const termScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 2 : 0), 0)
        const matchScore = (phrase && haystack.includes(phrase) ? 5 : 0) + termScore
        const score = matchScore > 0 ? matchScore + Math.min(entry.accessCount, 3) * 0.1 : 0
        return { entry, score, snippet: snippet(entry.content, query) }
      })
      .filter((result) => terms.length === 0 || result.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 20)))

    if (results.length > 0) {
      const database = this.read()
      const ids = new Set(results.map((result) => result.entry.id))
      for (const entry of database.entries) {
        if (ids.has(entry.id)) entry.accessCount += 1
      }
      this.write(database)
    }
    return results
  }

  list(workspacePath?: string | null, limit = 100): SharedMemoryEntry[] {
    const cwd = normalizeWorkspacePath(workspacePath)
    return this.read().entries
      .filter((entry) => entry.scope === 'global' || (!!cwd && entry.workspacePath === cwd))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 500)))
  }

  delete(id: string): boolean {
    const database = this.read()
    const next = database.entries.filter((entry) => entry.id !== id)
    if (next.length === database.entries.length) return false
    this.write({ version: 1, entries: next })
    return true
  }

  count(): number {
    return this.read().entries.length
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

export async function startSharedMemoryService(file: string): Promise<SharedMemoryConnection> {
  if (connection && server) return connection
  if (startPromise) return startPromise
  startPromise = startSharedMemoryServiceOnce(file)
  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

async function startSharedMemoryServiceOnce(file: string): Promise<SharedMemoryConnection> {
  activeStore = new SharedMemoryStore(file)
  const token = randomBytes(32).toString('hex')
  const connectionFile = `${file}.connection.json`
  server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => json(res, 400, { error: String(error) }))
  })
  await new Promise<void>((resolveListen, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Failed to start shared memory service')
  connection = { url: `http://127.0.0.1:${port}`, token, file, connectionFile }
  mkdirSync(dirname(connectionFile), { recursive: true })
  writeFileSync(connectionFile, JSON.stringify(connection, null, 2), 'utf8')
  return connection
}

export function getSharedMemoryConnection(): SharedMemoryConnection | null {
  return connection
}

export function getSharedMemoryStore(file: string): SharedMemoryStore {
  return activeStore ?? new SharedMemoryStore(file)
}

export async function stopSharedMemoryService(): Promise<void> {
  const current = connection
  const currentServer = server
  server = null
  startPromise = null
  connection = null
  activeStore = null
  if (currentServer) await new Promise<void>((resolveClose) => currentServer.close(() => resolveClose()))
  if (current) rmSync(current.connectionFile, { force: true })
}

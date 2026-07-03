import { readdirSync, createReadStream, unlinkSync } from 'fs'
import { stat } from 'fs/promises'
import { join, resolve } from 'path'
import { createInterface } from 'readline'

/**
 * Session-list support. pi persists each session as a .jsonl file under
 * <agentDir>/sessions/<encoded-cwd>/: line 1 is a `{type:"session"}` header
 * (id, cwd, timestamp), then `{type:"session_info"}` entries carry the
 * user-set display name and `{type:"message"}` entries the conversation.
 * RpcClient can switch/fork/name sessions but has no list API, so we scan
 * the directory ourselves (same logic as pi's own session selector).
 */
export type SessionInfo = {
  path: string
  id: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  /** ISO string of last message activity (fallback: header time / file mtime) */
  modified: string
}

type SessionEntry = Record<string, unknown>

function parseLine(line: string): SessionEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function extractText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const stats = await stat(filePath)
    let header: SessionEntry | null = null
    let name: string | undefined
    let firstMessage = ''
    let messageCount = 0
    let lastActivity: number | undefined

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      const entry = parseLine(line)
      if (!entry) continue
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string') return null
        header = entry
        continue
      }
      if (entry.type === 'session_info') {
        name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined
        continue
      }
      if (entry.type !== 'message') continue
      const message = entry.message as Record<string, unknown> | undefined
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
      messageCount++
      const ts =
        typeof message.timestamp === 'number'
          ? message.timestamp
          : new Date(entry.timestamp as string).getTime()
      if (!Number.isNaN(ts)) lastActivity = Math.max(lastActivity ?? 0, ts)
      if (!firstMessage && message.role === 'user') {
        firstMessage = extractText(message).slice(0, 200)
      }
    }
    if (!header) return null

    const headerTime = new Date(header.timestamp as string).getTime()
    const modified = lastActivity ?? (Number.isNaN(headerTime) ? stats.mtime.getTime() : headerTime)
    return {
      path: filePath,
      id: header.id as string,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      name,
      firstMessage: firstMessage || '(空会话)',
      messageCount,
      modified: new Date(modified).toISOString(),
    }
  } catch {
    return null
  }
}

/** List sessions in `sessionDir` belonging to `cwd`, newest first. */
export async function listSessions(sessionDir: string, cwd: string): Promise<SessionInfo[]> {
  let files: string[]
  try {
    files = readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(sessionDir, f))
  } catch {
    return []
  }
  const resolvedCwd = resolve(cwd)
  const infos = await Promise.all(files.map((f) => buildSessionInfo(f)))
  return infos
    .filter((s): s is SessionInfo => s !== null && resolve(s.cwd || resolvedCwd) === resolvedCwd)
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

export function deleteSession(filePath: string): void {
  unlinkSync(filePath)
}

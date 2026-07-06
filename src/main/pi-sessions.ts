import { readdirSync, createReadStream, readFileSync, unlinkSync } from 'fs'
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
export type SessionExportFormat = 'markdown' | 'json'

export type SessionExport = {
  fileName: string
  content: string
}

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

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 72)
}

function stringifyBlock(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function contentToMarkdown(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyBlock(content)

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return stringifyBlock(block)
      const item = block as Record<string, unknown>
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'thinking') {
        const thinking = typeof item.thinking === 'string' ? item.thinking.trim() : ''
        return thinking ? `<details><summary>思考过程</summary>\n\n${thinking}\n\n</details>` : ''
      }
      if (item.type === 'image') return '[图片]'
      if (item.type === 'toolCall') {
        const name = typeof item.name === 'string' ? item.name : 'tool'
        const id = typeof item.id === 'string' ? item.id : ''
        return [
          `**工具调用：${name}${id ? ` (${id})` : ''}**`,
          '',
          '```json',
          stringifyBlock(item.arguments ?? {}),
          '```',
        ].join('\n')
      }
      return [
        `**${String(item.type ?? 'content')}**`,
        '',
        '```json',
        stringifyBlock(item),
        '```',
      ].join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

function readSessionEntries(filePath: string): SessionEntry[] {
  return readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(parseLine)
    .filter((entry): entry is SessionEntry => entry !== null)
}

function buildMarkdown(entries: SessionEntry[], exportedAt: string): string {
  const header = entries.find((entry) => entry.type === 'session')
  const infoEntries = entries.filter((entry) => entry.type === 'session_info')
  const name = [...infoEntries].reverse().find((entry) => typeof entry.name === 'string')?.name
  const messages = entries.filter((entry) => entry.type === 'message')
  const title = typeof name === 'string' && name.trim() ? name.trim() : 'Pi Studio Session'
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const id = typeof header?.id === 'string' ? header.id : ''

  const roleCounts = messages.reduce<Record<string, number>>((acc, entry) => {
    const message = entry.message as Record<string, unknown> | undefined
    const role = typeof message?.role === 'string' ? message.role : 'unknown'
    acc[role] = (acc[role] ?? 0) + 1
    return acc
  }, {})

  const lines = [
    `# ${title}`,
    '',
    `- 导出时间：${exportedAt}`,
    id ? `- Session ID：${id}` : '',
    cwd ? `- Workspace：${cwd}` : '',
    `- 消息数：${messages.length}`,
    `- 角色统计：${Object.entries(roleCounts).map(([role, count]) => `${role} ${count}`).join(' / ') || '无'}`,
    '',
    '## 对话记录',
    '',
  ].filter(Boolean)

  for (const entry of messages) {
    const message = entry.message as Record<string, unknown> | undefined
    if (!message) continue
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const timestamp =
      typeof message.timestamp === 'number'
        ? new Date(message.timestamp).toISOString()
        : typeof entry.timestamp === 'string'
          ? entry.timestamp
          : ''
    const titleRole =
      role === 'user'
        ? '用户'
        : role === 'assistant'
          ? '助手'
          : role === 'toolResult'
            ? `工具结果：${typeof message.toolName === 'string' ? message.toolName : 'tool'}`
            : role
    lines.push(`### ${titleRole}${timestamp ? ` · ${timestamp}` : ''}`, '')
    if (role === 'toolResult') {
      if (message.isError) lines.push('> 工具执行失败', '')
      lines.push('```text', contentToMarkdown(message.content), '```', '')
    } else {
      lines.push(contentToMarkdown(message.content), '')
    }
  }

  return `${lines.join('\n').trim()}\n`
}

export function buildSessionExport(filePath: string, format: SessionExportFormat): SessionExport {
  const entries = readSessionEntries(filePath)
  const header = entries.find((entry) => entry.type === 'session')
  const infoEntries = entries.filter((entry) => entry.type === 'session_info')
  const name = [...infoEntries].reverse().find((entry) => typeof entry.name === 'string')?.name
  const id = typeof header?.id === 'string' ? header.id : 'session'
  const exportedAt = new Date().toISOString()
  const baseName = safeFileName(
    typeof name === 'string' && name.trim() ? name.trim() : `pi-session-${id.slice(0, 8)}`,
  )

  if (format === 'json') {
    return {
      fileName: `${baseName || 'pi-session'}.json`,
      content: `${JSON.stringify({ exportedAt, sourceFile: filePath, entries }, null, 2)}\n`,
    }
  }

  return {
    fileName: `${baseName || 'pi-session'}.md`,
    content: buildMarkdown(entries, exportedAt),
  }
}

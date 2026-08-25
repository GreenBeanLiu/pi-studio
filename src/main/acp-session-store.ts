import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { SessionInfo } from '../shared/ipc/contract'
import { acpSessionKey } from '../shared/acp-session-key'

/**
 * 外部 agent 会话的宿主侧索引。
 *
 * pi 的会话在磁盘上有 jsonl,列表直接扫目录就有了。ACP 的会话存在 agent 那边,
 * 宿主手里只有一个 sessionId —— 不记下来的话,进程一断这个会话就再也找不回来了
 * (agent 那边还留着,但我们不知道它的 id)。
 *
 * 这里只存「够把它找回来」的最小信息,不存对话内容:内容要靠 session/load
 * 从 agent 那儿回放。
 */

export type AcpSessionRecord = {
  agentId: string
  agentName: string
  sessionId: string
  cwd: string
  /** 列表里的预览文本。agent 不回放的话我们也只有这个。 */
  firstMessage: string
  createdAt: string
  modified: string
}

/** 索引上限。超了丢最旧的 —— 这只是个「找得回来」的索引,不是历史归档。 */
export const MAX_ACP_SESSION_RECORDS = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value ? value : null
}

/** 一条坏记录不该让整份索引失效。 */
export function parseAcpSessionRecords(raw: unknown): AcpSessionRecord[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : []
  const records: AcpSessionRecord[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const agentId = str(item, 'agentId')
    const sessionId = str(item, 'sessionId')
    const cwd = str(item, 'cwd')
    if (!agentId || !sessionId || !cwd) continue
    const createdAt = str(item, 'createdAt') ?? new Date(0).toISOString()
    records.push({
      agentId,
      agentName: str(item, 'agentName') ?? agentId,
      sessionId,
      cwd,
      firstMessage: typeof item.firstMessage === 'string' ? item.firstMessage : '',
      createdAt,
      modified: str(item, 'modified') ?? createdAt,
    })
  }
  return records
}

export function acpRecordToSessionInfo(record: AcpSessionRecord): SessionInfo {
  return {
    path: acpSessionKey(record.agentId, record.sessionId),
    id: record.sessionId,
    cwd: record.cwd,
    name: record.agentName,
    firstMessage: record.firstMessage || '(还没有消息)',
    // 宿主不知道外部会话有多少条消息,不编一个数。
    messageCount: 0,
    modified: record.modified,
  }
}

export class AcpSessionStore {
  private records: AcpSessionRecord[] | null = null

  constructor(private readonly file: string) {}

  private load(): AcpSessionRecord[] {
    if (this.records) return this.records
    try {
      this.records = parseAcpSessionRecords(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // 文件不存在或坏了都当空索引 —— 丢的只是「能找回旧会话」,不该让应用起不来。
      this.records = []
    }
    return this.records
  }

  private persist(): void {
    const records = this.load()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ sessions: records }, null, 2), 'utf8')
    } catch {
      // 索引写不进去不该让当前这轮对话失败。
    }
  }

  /** 本工作区的记录,最近的在前。 */
  list(cwd: string): AcpSessionRecord[] {
    return this.load()
      .filter((record) => record.cwd === cwd)
      .sort((a, b) => b.modified.localeCompare(a.modified))
  }

  find(agentId: string, sessionId: string): AcpSessionRecord | undefined {
    return this.load().find(
      (record) => record.agentId === agentId && record.sessionId === sessionId,
    )
  }

  /** 记下一个会话,或更新已有的那条。 */
  upsert(record: AcpSessionRecord): void {
    const records = this.load()
    const index = records.findIndex(
      (item) => item.agentId === record.agentId && item.sessionId === record.sessionId,
    )
    if (index >= 0) records[index] = { ...records[index], ...record }
    else records.unshift(record)
    if (records.length > MAX_ACP_SESSION_RECORDS) {
      records.sort((a, b) => b.modified.localeCompare(a.modified))
      records.length = MAX_ACP_SESSION_RECORDS
    }
    this.persist()
  }

  /** 发了消息就更新预览和时间。第一条消息定下预览之后不再改。 */
  touch(agentId: string, sessionId: string, patch: { firstMessage?: string; modified: string }): void {
    const record = this.find(agentId, sessionId)
    if (!record) return
    if (patch.firstMessage && !record.firstMessage) record.firstMessage = patch.firstMessage
    record.modified = patch.modified
    this.persist()
  }

  remove(agentId: string, sessionId: string): void {
    const records = this.load()
    const next = records.filter(
      (record) => !(record.agentId === agentId && record.sessionId === sessionId),
    )
    if (next.length === records.length) return
    this.records = next
    this.persist()
  }
}

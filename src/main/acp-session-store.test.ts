import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AcpSessionStore,
  MAX_ACP_SESSION_RECORDS,
  acpRecordToSessionInfo,
  parseAcpSessionRecords,
  type AcpSessionRecord,
} from './acp-session-store'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-store-'))
  file = join(dir, 'nested', 'acp-sessions.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function record(overrides: Partial<AcpSessionRecord> = {}): AcpSessionRecord {
  return {
    agentId: 'codex-acp',
    agentName: 'Codex',
    sessionId: 's1',
    cwd: '/w',
    firstMessage: '看看 hello.txt',
    createdAt: '2026-08-25T00:00:00.000Z',
    modified: '2026-08-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('persistence', () => {
  it('survives a round trip through the file', () => {
    const store = new AcpSessionStore(file)
    store.upsert(record())
    expect(new AcpSessionStore(file).list('/w')).toEqual([record()])
  })

  it('creates the directory it needs', () => {
    new AcpSessionStore(file).upsert(record())
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(1)
  })

  // 索引坏了丢的只是「能找回旧会话」,不该让应用起不来。
  it('treats a missing or corrupt file as an empty index', () => {
    expect(new AcpSessionStore(join(dir, 'nope.json')).list('/w')).toEqual([])
    writeFileSync(file.replace('nested/', ''), 'not json at all', 'utf8')
    expect(new AcpSessionStore(file.replace('nested/', '')).list('/w')).toEqual([])
  })

  it('keeps writing after a write failure instead of throwing', () => {
    // 目录位置被一个文件占住,写不进去
    const blocked = join(dir, 'blocker')
    writeFileSync(blocked, 'x', 'utf8')
    const store = new AcpSessionStore(join(blocked, 'acp.json'))
    expect(() => store.upsert(record())).not.toThrow()
    // 内存里仍然有,当前这轮对话不受影响
    expect(store.list('/w')).toHaveLength(1)
  })
})

describe('parseAcpSessionRecords', () => {
  it('skips entries missing the fields needed to find the session again', () => {
    const parsed = parseAcpSessionRecords({
      sessions: [
        record(),
        { agentId: 'x', cwd: '/w' },
        { sessionId: 's', cwd: '/w' },
        { agentId: 'x', sessionId: 's' },
        record({ sessionId: 's2' }),
      ],
    })
    expect(parsed.map((r) => r.sessionId)).toEqual(['s1', 's2'])
  })

  it('accepts a bare array as well as the wrapped shape', () => {
    expect(parseAcpSessionRecords([record()])).toHaveLength(1)
    expect(parseAcpSessionRecords({ sessions: [record()] })).toHaveLength(1)
    expect(parseAcpSessionRecords(null)).toEqual([])
    expect(parseAcpSessionRecords('nope')).toEqual([])
  })

  it('fills in the fields that only affect presentation', () => {
    const [parsed] = parseAcpSessionRecords([
      { agentId: 'a', sessionId: 's', cwd: '/w', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(parsed).toMatchObject({ agentName: 'a', firstMessage: '', modified: '2026-01-01T00:00:00.000Z' })
  })
})

describe('listing and updating', () => {
  it('lists only this workspace, newest first', () => {
    const store = new AcpSessionStore(file)
    store.upsert(record({ sessionId: 'old', modified: '2026-08-01T00:00:00.000Z' }))
    store.upsert(record({ sessionId: 'new', modified: '2026-08-20T00:00:00.000Z' }))
    store.upsert(record({ sessionId: 'other', cwd: '/elsewhere' }))
    expect(store.list('/w').map((r) => r.sessionId)).toEqual(['new', 'old'])
  })

  it('updates in place instead of duplicating', () => {
    const store = new AcpSessionStore(file)
    store.upsert(record())
    store.upsert(record({ agentName: 'Codex 改名了' }))
    expect(store.list('/w')).toHaveLength(1)
    expect(store.list('/w')[0]?.agentName).toBe('Codex 改名了')
  })

  // 预览是第一条消息,后面的不该覆盖它。
  it('keeps the first message as the preview and moves the timestamp', () => {
    const store = new AcpSessionStore(file)
    store.upsert(record({ firstMessage: '' }))
    store.touch('codex-acp', 's1', { firstMessage: '第一句', modified: '2026-08-25T01:00:00.000Z' })
    store.touch('codex-acp', 's1', { firstMessage: '第二句', modified: '2026-08-25T02:00:00.000Z' })
    expect(store.list('/w')[0]).toMatchObject({
      firstMessage: '第一句',
      modified: '2026-08-25T02:00:00.000Z',
    })
  })

  it('ignores a touch for a session it never recorded', () => {
    const store = new AcpSessionStore(file)
    expect(() => store.touch('nope', 'nope', { modified: 'x' })).not.toThrow()
    expect(store.list('/w')).toEqual([])
  })

  it('removes a session and persists the removal', () => {
    const store = new AcpSessionStore(file)
    store.upsert(record())
    store.remove('codex-acp', 's1')
    expect(new AcpSessionStore(file).list('/w')).toEqual([])
  })

  it('caps the index and drops the oldest', () => {
    const store = new AcpSessionStore(file)
    for (let i = 0; i < MAX_ACP_SESSION_RECORDS + 10; i++) {
      store.upsert(
        record({ sessionId: `s${i}`, modified: `2026-08-25T00:00:${String(i % 60).padStart(2, '0')}.000Z` }),
      )
    }
    expect(store.list('/w')).toHaveLength(MAX_ACP_SESSION_RECORDS)
  })
})

describe('acpRecordToSessionInfo', () => {
  it('keys the entry so sessions:switch can route it', () => {
    expect(acpRecordToSessionInfo(record()).path).toBe('acp:codex-acp:s1')
  })

  it('shows the agent name and a placeholder for an empty session', () => {
    const info = acpRecordToSessionInfo(record({ firstMessage: '' }))
    expect(info.name).toBe('Codex')
    expect(info.firstMessage).not.toBe('')
    // 宿主不知道外部会话有多少条消息,不编一个数
    expect(info.messageCount).toBe(0)
  })
})

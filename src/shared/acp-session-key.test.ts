import { describe, expect, it } from 'vitest'
import { acpSessionKey, isAcpSessionKey, parseAcpSessionKey } from './acp-session-key'

describe('acp session keys', () => {
  it('round-trips an agent id and session id', () => {
    const key = acpSessionKey('codex-acp', '01a03683-1921-7dc3-8a3b-c32be1d3b555')
    expect(key).toBe('acp:codex-acp:01a03683-1921-7dc3-8a3b-c32be1d3b555')
    expect(parseAcpSessionKey(key)).toEqual({
      agentId: 'codex-acp',
      sessionId: '01a03683-1921-7dc3-8a3b-c32be1d3b555',
    })
  })

  it('keeps a session id that itself contains separators-ish characters', () => {
    const key = acpSessionKey('claude-acp', '1851fea2-7fba-4f06-801d-8ba7ad6d1240')
    expect(parseAcpSessionKey(key)?.sessionId).toBe('1851fea2-7fba-4f06-801d-8ba7ad6d1240')
  })

  it('tells acp keys apart from pi session file paths', () => {
    expect(isAcpSessionKey('acp:codex-acp:s1')).toBe(true)
    expect(isAcpSessionKey('/Users/me/pi-agent/sessions/x/s.jsonl')).toBe(false)
    expect(isAcpSessionKey('C:\\pi-agent\\sessions\\s.jsonl')).toBe(false)
    expect(isAcpSessionKey(null)).toBe(false)
    expect(isAcpSessionKey(42)).toBe(false)
  })

  // 这个值来自 renderer,不能假设是我们自己生成的那个。
  describe('rejects anything malformed', () => {
    const bad = [
      'acp:',
      'acp:onlyagent',
      'acp::nosession',
      'acp:agent:',
      // 路径穿越:解析出来的段一旦被当成路径用就危险
      'acp:../../etc:passwd',
      'acp:agent:../../../etc/shadow',
      'acp:agent id:s1',
      'acp:agent\u0000:s1',
      'not-acp:agent:s1',
      '',
    ]
    for (const value of bad) {
      it(`rejects ${JSON.stringify(value)}`, () => {
        expect(parseAcpSessionKey(value)).toBeNull()
      })
    }
  })

  it('rejects non-strings outright', () => {
    expect(parseAcpSessionKey(undefined)).toBeNull()
    expect(parseAcpSessionKey({ agentId: 'x' })).toBeNull()
  })
})

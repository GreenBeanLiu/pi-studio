import { describe, expect, it } from 'vitest'
import { resolve, sep } from 'path'
import { isContainedPath, oneOf, parseContainedPath, parseSessionPath, requiredString } from './validators'

const ROOT = resolve('/tmp/agent/sessions/ws-abc')

describe('path containment', () => {
  it('accepts a file directly inside the root', () => {
    expect(isContainedPath(resolve(ROOT, 'a.jsonl'), ROOT)).toBe(true)
  })

  it('rejects a sibling directory sharing a name prefix', () => {
    // ws-abc-evil must not pass just because it starts with ws-abc
    expect(isContainedPath(`${ROOT}-evil${sep}a.jsonl`, ROOT)).toBe(false)
  })

  it('rejects traversal out of the root', () => {
    expect(isContainedPath(resolve(ROOT, '..', 'other', 'a.jsonl'), ROOT)).toBe(false)
  })
})

describe('parseContainedPath', () => {
  it('resolves a relative path against the root', () => {
    expect(parseContainedPath('a.jsonl', ROOT, '会话路径')).toBe(resolve(ROOT, 'a.jsonl'))
  })

  it('rejects traversal', () => {
    expect(() => parseContainedPath('../../etc/passwd', ROOT, '会话路径')).toThrow('超出允许范围')
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => parseContainedPath(resolve('/etc/passwd'), ROOT, '会话路径')).toThrow(
      '超出允许范围',
    )
  })

  it('rejects a non-string', () => {
    expect(() => parseContainedPath(42, ROOT, '会话路径')).toThrow('不能为空')
  })
})

describe('parseSessionPath', () => {
  it('accepts a .jsonl inside the session directory', () => {
    expect(parseSessionPath('s.jsonl', ROOT)).toBe(resolve(ROOT, 's.jsonl'))
  })

  // sessions:delete hands this straight to unlinkSync
  it('refuses a non-session file even inside the directory', () => {
    expect(() => parseSessionPath('notes.txt', ROOT)).toThrow('必须是会话文件')
  })

  it('refuses a .jsonl outside the directory', () => {
    expect(() => parseSessionPath('../elsewhere/s.jsonl', ROOT)).toThrow('超出允许范围')
  })
})

describe('oneOf', () => {
  it('returns the value when allowed', () => {
    expect(oneOf('high', ['off', 'high'] as const, '推理等级')).toBe('high')
  })

  it('rejects a value outside the enum', () => {
    expect(() => oneOf('nope', ['off', 'high'] as const, '推理等级')).toThrow('推理等级无效')
  })

  it('rejects a non-string', () => {
    expect(() => oneOf(1, ['off'] as const, '推理等级')).toThrow('推理等级无效')
  })
})

describe('requiredString', () => {
  it('trims', () => {
    expect(requiredString('  a  ', '会话名称')).toBe('a')
  })

  it('rejects whitespace-only input', () => {
    expect(() => requiredString('   ', '会话名称')).toThrow('会话名称不能为空')
  })
})

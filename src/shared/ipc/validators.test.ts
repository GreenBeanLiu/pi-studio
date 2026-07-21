import { describe, expect, it } from 'vitest'
import { resolve, sep } from 'path'
import {
  isContainedPath,
  oneOf,
  parseContainedPath,
  parseRoutineSave,
  parseRoutineSchedule,
  parseSettingsSave,
  parseSessionPath,
  requiredString,
} from './validators'

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

describe('parseRoutineSchedule', () => {
  it('accepts each schedule kind', () => {
    expect(parseRoutineSchedule({ type: 'manual' })).toEqual({ type: 'manual' })
    expect(parseRoutineSchedule({ type: 'interval', minutes: 30 })).toEqual({
      type: 'interval',
      minutes: 30,
    })
    expect(parseRoutineSchedule({ type: 'weekly', day: 0, time: '09:00' })).toEqual({
      type: 'weekly',
      day: 0,
      time: '09:00',
    })
  })

  it('rejects a zero-minute interval that would spin the scheduler', () => {
    expect(() => parseRoutineSchedule({ type: 'interval', minutes: 0 })).toThrow('间隔分钟')
  })

  it('rejects a malformed time', () => {
    expect(() => parseRoutineSchedule({ type: 'daily', time: '25:99' })).toThrow('HH:mm')
  })

  it('rejects an unknown type', () => {
    expect(() => parseRoutineSchedule({ type: 'cron', expr: '* * * * *' })).toThrow('调度类型')
  })
})

describe('parseRoutineSave', () => {
  const base = {
    name: '晨报',
    steps: [{ name: '抓取', type: 'agent', prompt: 'x' }],
    workspacePath: 'D:/Works/blog',
    schedule: { type: 'daily', time: '09:00' },
    notify: 'error',
  }

  it('keeps known fields and passes steps through untouched', () => {
    const parsed = parseRoutineSave({ ...base, id: 'r1', pushEachStep: true })
    expect(parsed.id).toBe('r1')
    expect(parsed.pushEachStep).toBe(true)
    expect(parsed.steps).toBe(base.steps)
  })

  // Object.assign(existing, routine) used to persist and cloud-sync any extra key
  it('drops unknown fields', () => {
    const parsed = parseRoutineSave({ ...base, __proto__pollution: 'x', extra: 1 })
    expect('extra' in parsed).toBe(false)
  })

  it('rejects a missing name', () => {
    expect(() => parseRoutineSave({ ...base, name: ' ' })).toThrow('工作流名称')
  })

  it('rejects a bad notify value', () => {
    expect(() => parseRoutineSave({ ...base, notify: 'sometimes' })).toThrow('通知策略')
  })
})

describe('parseSettingsSave', () => {
  const base = {
    provider: 'openai',
    apiKey: 'k',
    model: 'gpt-5.5',
    baseUrl: '',
    favoriteModels: '',
    tavilyApiKey: '',
    heliconeApiKey: '',
    securityGuardEnabled: true,
    sandboxEnabled: false,
    subagentsEnabled: true,
    remoteEnabled: true,
    feishuWebhookUrl: '',
    feishuSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuChatId: '',
    imageEngine: '',
    cloudImageRelay: '',
    cloudImageKey: '',
  }

  it('round-trips a valid form', () => {
    expect(parseSettingsSave({ ...base, clearCloudImageKey: true }).clearCloudImageKey).toBe(true)
  })

  // used to reach saveSettings and blow up on .trim()
  it('rejects a non-string cloudImageKey instead of crashing later', () => {
    expect(() => parseSettingsSave({ ...base, cloudImageKey: 42 })).toThrow('云端 Key')
  })

  it('rejects an unknown provider', () => {
    expect(() => parseSettingsSave({ ...base, provider: 'gemini' })).toThrow('Provider')
  })

  it('drops unknown fields instead of persisting them', () => {
    const parsed = parseSettingsSave({ ...base, injected: 'x' })
    expect('injected' in parsed).toBe(false)
  })
})

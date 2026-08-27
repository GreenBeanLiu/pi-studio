import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

describe('SettingsModal backup restore compatibility', () => {
  it('guards optional mixed-version APIs and requires confirmation before restore', () => {
    expect(source).toContain('if (!listBackups) return')
    expect(source).toContain('if (!restoreBackup || !selectedBackup) return')
    expect(source).toContain("title: '恢复本地数据并重启？'")
    expect(source).toContain('当前数据会先保存为保护点')
  })
})

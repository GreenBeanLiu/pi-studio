import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settings = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

describe('desktop remote pairing reset', () => {
  it('requires confirmation before unlinking every paired phone', () => {
    expect(settings).toContain('解除所有已配对手机')
    expect(settings).toContain('api.remote.resetPairings()')
    expect(settings).toContain('<Popconfirm')
  })
})

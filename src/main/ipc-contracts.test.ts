import { describe, expect, it } from 'vitest'
import { parseLlmProfileSavePayload } from './ipc-contracts'

const profile = {
  id: 'three-a-main',
  display_name: '3A Main',
  base_url: 'https://api.3a-api.com/v1',
  api_type: 'openai-completions',
  api_key: 'secret',
  models: ['gpt-5.5'],
  enabled: true,
  sort_order: 0,
}

describe('llm profile IPC contract', () => {
  it('requires a key when creating a profile', () => {
    expect(() =>
      parseLlmProfileSavePayload({ create: true, profile: { ...profile, api_key: '' } }),
    ).toThrow('API Key')
  })

  it('allows an empty key when updating a profile', () => {
    expect(
      parseLlmProfileSavePayload({ create: false, profile: { ...profile, api_key: '' } }),
    ).toEqual({ create: false, profile: { ...profile, api_key: '' } })
  })

  it.each([
    { ...profile, id: '../bad' },
    { ...profile, base_url: 'not-a-url' },
    { ...profile, api_type: 'anthropic' },
    { ...profile, models: ['ok', 3] },
    { ...profile, enabled: 'yes' },
  ])('rejects malformed renderer input', (invalidProfile) => {
    expect(() =>
      parseLlmProfileSavePayload({ create: false, profile: invalidProfile }),
    ).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_MODELS,
  DEEPSEEK_PROFILE_ID,
  createDeepSeekProfileWrite,
  migrateDeepSeekFavoriteModels,
} from './deepseek-profile'

describe('DeepSeek official profile preset', () => {
  it('uses the current official endpoint and V4 model ids', () => {
    expect(DEEPSEEK_PROFILE_ID).toBe('deepseek')
    expect(DEEPSEEK_OFFICIAL_BASE_URL).toBe('https://api.deepseek.com')
    expect(DEEPSEEK_OFFICIAL_MODELS).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })

  it('builds a server-side provider write without transforming the key', () => {
    expect(createDeepSeekProfileWrite('sk-deepseek-secret', 3)).toEqual({
      id: 'deepseek',
      display_name: 'DeepSeek 官方',
      base_url: 'https://api.deepseek.com',
      api_type: 'openai-completions',
      api_key: 'sk-deepseek-secret',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      enabled: true,
      sort_order: 3,
    })
  })

  it('adds an existing cloud DeepSeek lane to a curated model switcher', () => {
    expect(
      migrateDeepSeekFavoriteModels({
        favoriteModels: 'openai::gpt-5.6-sol',
        legacyProvider: 'openai',
        enabledModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      }),
    ).toBe(
      'openai::gpt-5.6-sol, deepseek::deepseek-v4-flash, deepseek::deepseek-v4-pro',
    )
  })
})

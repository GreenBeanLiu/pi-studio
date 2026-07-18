import { describe, expect, it } from 'vitest'
import {
  favoriteRouteKey,
  parseFavoriteModelRoutes,
  selectRuntimeModelRoute,
} from '../shared/model-route'
import type { LlmProviderProfile } from './llm-gateway'

const cloudProfiles: LlmProviderProfile[] = [
  {
    id: 'three-a-main',
    display_name: '3A Main',
    api_type: 'openai-completions',
    models: ['gpt-5.5', 'grok-4'],
    enabled: true,
    sort_order: 0,
    has_key: true,
  },
  {
    id: 'other-main',
    display_name: 'Other',
    api_type: 'openai-completions',
    models: ['gpt-5.5'],
    enabled: true,
    sort_order: 1,
    has_key: true,
  },
]

describe('canonical model route selection', () => {
  it('keeps the selected cloud route even when a local API key exists', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'three-a-main', model: 'grok-4' },
        localProvider: 'openai',
        localModel: 'gpt-4o',
        localKeyConfigured: true,
        gatewayProfiles: cloudProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'grok-4' })
  })

  it('falls back to the local route when the persisted route no longer exists', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'deleted-profile', model: 'old-model' },
        localProvider: 'openai',
        localModel: 'gpt-4o',
        localKeyConfigured: true,
        gatewayProfiles: cloudProfiles,
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('scopes favorites by provider when model ids are identical', () => {
    expect(favoriteRouteKey('three-a-main', 'gpt-5.5')).not.toBe(
      favoriteRouteKey('other-main', 'gpt-5.5'),
    )
  })

  it('migrates legacy favorite ids to the configured direct provider', () => {
    expect(parseFavoriteModelRoutes('gpt-4o, three-a-main::gpt-5.5', 'openai')).toEqual([
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'three-a-main', model: 'gpt-5.5' },
    ])
  })
})

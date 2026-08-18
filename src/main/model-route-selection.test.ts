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

  it('uses gpt-5.6-luna as the first-run cloud default when available', () => {
    expect(
      selectRuntimeModelRoute({
        selected: null,
        localProvider: 'openai',
        localModel: 'gpt-4o',
        localKeyConfigured: true,
        gatewayProfiles: [
          {
            ...cloudProfiles[0],
            models: ['codex-auto-review', 'gpt-5.6-luna', 'gpt-5.6-sol'],
          },
        ],
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.6-luna' })
  })

  // 2026-08-18:selectedModelRoute 里躺着一条 openai::gpt-4-turbo。它在 pi 内置注册表
  // 里有,但自建网关不供,于是每次调用都是 502,工作流报「没有产出任何文本」。本地线路
  // 当时只比对 provider 名字,这条脏数据就一路盖过配好的 gpt-5.5 跑到网关才炸。
  it('drops a selected local model the direct provider does not actually offer', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'openai', model: 'gpt-4-turbo' },
        localProvider: 'openai',
        localModel: 'gpt-5.5',
        localKeyConfigured: true,
        localModels: ['gpt-5.6-sol', 'grok-4.5'],
        gatewayProfiles: [],
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-5.5' })
  })

  it('keeps a selected local model that is on the switcher list', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'openai', model: 'grok-4.5' },
        localProvider: 'openai',
        localModel: 'gpt-5.5',
        localKeyConfigured: true,
        localModels: ['gpt-5.6-sol', 'grok-4.5'],
        gatewayProfiles: [],
      }),
    ).toEqual({ provider: 'openai', model: 'grok-4.5' })
  })

  it('honours the configured default even when it is not on the switcher list', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'openai', model: 'gpt-5.5' },
        localProvider: 'openai',
        localModel: 'gpt-5.5',
        localKeyConfigured: true,
        localModels: ['gpt-5.6-sol'],
        gatewayProfiles: [],
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-5.5' })
  })

  // 没配模型切换列表就无从判断该 provider 到底有哪些模型,不能瞎拦。
  it('leaves the selected local route alone when no local model list is known', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'openai', model: 'gpt-4o' },
        localProvider: 'openai',
        localModel: 'gpt-5.5',
        localKeyConfigured: true,
        gatewayProfiles: [],
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

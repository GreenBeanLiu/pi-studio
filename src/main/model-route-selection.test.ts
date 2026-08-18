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

// 直连 provider 退役后选路只剩网关一条线:选中的还在供就用它,否则默认 profile,
// 再否则任意一个有模型的 profile。
describe('canonical model route selection', () => {
  it('keeps the selected route while its profile still serves that model', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'three-a-main', model: 'grok-4' },
        gatewayProfiles: cloudProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'grok-4' })
  })

  it('drops a selection whose profile is gone', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'deleted-profile', model: 'old-model' },
        gatewayProfiles: cloudProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.5' })
  })

  // 退役前的真实故障:selectedModelRoute 里躺着 openai::gpt-4-turbo,它在 pi 内置注册表
  // 里有、自建网关却不供,于是每次调用都是 502。现在这种线路根本不再被接受。
  it('drops a selection left over from the retired direct provider', () => {
    expect(
      selectRuntimeModelRoute({
        selected: { provider: 'openai', model: 'gpt-4-turbo' },
        gatewayProfiles: cloudProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.5' })
  })

  it('uses the default cloud route on first run when it is available', () => {
    expect(
      selectRuntimeModelRoute({
        selected: null,
        gatewayProfiles: [
          {
            ...cloudProfiles[0],
            models: ['codex-auto-review', 'gpt-5.6-sol', 'gpt-5.6-terra'],
          },
        ],
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.6-sol' })
  })

  // DEFAULT_MODEL_ROUTE 的模型被服务端改名/下架时,原来会一路掉到最后一档「第一个
  // profile 的第一个模型」—— 那是 codex-auto-review,代码审查专用模型当聊天默认。
  // 宁可退到同一个默认 profile 的别的模型。
  it('stays on the default profile when its named default model is gone', () => {
    expect(
      selectRuntimeModelRoute({
        selected: null,
        gatewayProfiles: [
          { ...cloudProfiles[1], models: ['grok-4'] },
          { ...cloudProfiles[0], models: ['gpt-5.7-whatever'] },
        ],
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.7-whatever' })
  })

  it('falls back to any profile that still has models when the default one is missing', () => {
    expect(
      selectRuntimeModelRoute({
        selected: null,
        gatewayProfiles: [{ ...cloudProfiles[1], models: ['grok-4'] }],
      }),
    ).toEqual({ provider: 'other-main', model: 'grok-4' })
  })

  it('gives up when no profile has any model', () => {
    expect(selectRuntimeModelRoute({ selected: null, gatewayProfiles: [] })).toBeNull()
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

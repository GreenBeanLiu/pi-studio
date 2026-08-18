import { describe, expect, it } from 'vitest'
import {
  migrateDirectFavoritesToGateway,
  migrateDirectSelectedRoute,
} from './direct-provider-retirement'

// 用户机器上的真实形状:直连 provider 叫 openai,收藏项混着直连和网关两种线路。
const gatewayProfiles = [
  { id: 'three-a-main', models: ['codex-auto-review', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra'] },
  { id: 'deepseek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  { id: 'three-a-grok', models: ['grok-4.3', 'grok-4.5'] },
]

describe('retiring the direct provider: favorites', () => {
  it('re-homes each direct route onto the gateway profile that serves it', () => {
    expect(
      migrateDirectFavoritesToGateway({
        favoriteModels: 'openai::gpt-5.5, openai::gpt-5.6-sol, openai::grok-4.5',
        directProvider: 'openai',
        gatewayProfiles,
      }),
    ).toBe('three-a-main::gpt-5.5, three-a-main::gpt-5.6-sol, three-a-grok::grok-4.5')
  })

  // gpt-5.6-luna 只存在于 customModelIds 注入的直连 provider 上,网关没有。直连一去
  // 它在模型选择器里就是个点不到的死条目,留着只会让人以为还能用。
  it('drops a direct route no gateway profile can serve', () => {
    expect(
      migrateDirectFavoritesToGateway({
        favoriteModels: 'openai::gpt-5.5, openai::gpt-5.6-luna',
        directProvider: 'openai',
        gatewayProfiles,
      }),
    ).toBe('three-a-main::gpt-5.5')
  })

  it('leaves routes that already point at a gateway profile alone', () => {
    expect(
      migrateDirectFavoritesToGateway({
        favoriteModels: 'deepseek::deepseek-v4-pro, openai::gpt-5.5',
        directProvider: 'openai',
        gatewayProfiles,
      }),
    ).toBe('deepseek::deepseek-v4-pro, three-a-main::gpt-5.5')
  })

  it('does not leave a duplicate when both spellings of one model are favorited', () => {
    expect(
      migrateDirectFavoritesToGateway({
        favoriteModels: 'three-a-main::gpt-5.5, openai::gpt-5.5',
        directProvider: 'openai',
        gatewayProfiles,
      }),
    ).toBe('three-a-main::gpt-5.5')
  })
})

describe('retiring the direct provider: selected route', () => {
  it('keeps a selection that already points at a gateway profile', () => {
    expect(
      migrateDirectSelectedRoute({
        selected: { provider: 'three-a-grok', model: 'grok-4.5' },
        directProvider: 'openai',
        directModel: 'gpt-5.5',
        gatewayProfiles,
      }),
    ).toEqual({ provider: 'three-a-grok', model: 'grok-4.5' })
  })

  it('re-homes a direct selection onto the profile that serves the same model', () => {
    expect(
      migrateDirectSelectedRoute({
        selected: { provider: 'openai', model: 'gpt-5.6-sol' },
        directProvider: 'openai',
        directModel: 'gpt-5.5',
        gatewayProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.6-sol' })
  })

  // 这台机器上的实际状态:selectedModelRoute 是早就 502 的 gpt-4-turbo,而 model 字段
  // 写的 gpt-5.5 才是人一直想用的。搬迁应该落到后者,而不是甩去 DEFAULT_MODEL_ROUTE。
  it('falls back to the configured direct model when the selection has no home', () => {
    expect(
      migrateDirectSelectedRoute({
        selected: { provider: 'openai', model: 'gpt-4-turbo' },
        directProvider: 'openai',
        directModel: 'gpt-5.5',
        gatewayProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.5' })
  })

  it('gives up and lets the default route decide when nothing matches', () => {
    expect(
      migrateDirectSelectedRoute({
        selected: { provider: 'openai', model: 'gpt-4-turbo' },
        directProvider: 'openai',
        directModel: 'gpt-4o',
        gatewayProfiles,
      }),
    ).toBeNull()
  })

  it('re-homes the configured direct model when nothing was ever selected', () => {
    expect(
      migrateDirectSelectedRoute({
        selected: null,
        directProvider: 'openai',
        directModel: 'gpt-5.5',
        gatewayProfiles,
      }),
    ).toEqual({ provider: 'three-a-main', model: 'gpt-5.5' })
  })
})

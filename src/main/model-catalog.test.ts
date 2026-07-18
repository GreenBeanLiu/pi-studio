import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogCoordinator, type ModelCatalogDependencies } from './model-catalog'
import type { LlmProviderProfile, LlmProfileWrite } from './llm-gateway'

const profile: LlmProviderProfile = {
  id: 'three-a-main',
  display_name: '3A Main',
  base_url: 'https://api.3a-api.com/v1',
  api_type: 'openai-completions',
  models: ['gpt-5.5'],
  enabled: true,
  sort_order: 0,
  has_key: true,
}

function dependencies(
  overrides: Partial<ModelCatalogDependencies> = {},
): ModelCatalogDependencies {
  return {
    loadLocalSettings: () => ({
      provider: 'openai',
      baseUrl: '',
      heliconeEnabled: false,
      customModelIds: [],
    }),
    getConnection: () => ({
      available: true,
      relay: 'https://trail-api.glanger.xyz',
      key: 'desktop-key',
      error: null,
    }),
    fetchCatalog: vi.fn(async () => ({ providers: [profile] })),
    createSessionToken: vi.fn(async () => ({
      token: 'chat-token',
      expires_at: 4_000_000_000,
      scope: 'llm:chat' as const,
    })),
    listProfiles: vi.fn(async () => [profile]),
    createProfile: vi.fn(async (_relay, _key, value: LlmProfileWrite) => ({
      ...profile,
      ...value,
      has_key: true,
    })),
    updateProfile: vi.fn(async () => profile),
    deleteProfile: vi.fn(async () => undefined),
    refreshProfileModels: vi.fn(async () => profile),
    projectModels: vi.fn(),
    ...overrides,
  }
}

describe('model catalog coordination', () => {
  it('projects and publishes one consistent catalog after a profile mutation', async () => {
    const onChanged = vi.fn()
    const deps = dependencies()
    const catalog = new ModelCatalogCoordinator(deps, onChanged)

    const result = await catalog.saveProfile(
      {
        id: 'three-a-main',
        display_name: '3A Main',
        base_url: 'https://api.3a-api.com/v1',
        api_type: 'openai-completions',
        api_key: 'new-key',
        models: ['gpt-5.5'],
        enabled: true,
        sort_order: 0,
      },
      true,
    )

    expect(result.profile.id).toBe('three-a-main')
    expect(deps.projectModels).toHaveBeenCalledOnce()
    expect(deps.projectModels).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayProfiles: [profile] }),
    )
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('preserves the last cloud projection when refresh is temporarily unavailable', async () => {
    const deps = dependencies({
      fetchCatalog: vi.fn(async () => {
        throw new Error('gateway offline')
      }),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    const result = await catalog.sync()

    expect(result.profiles).toEqual([])
    expect(result.warning).toBe('gateway offline')
    expect(deps.projectModels).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayProfiles: undefined }),
    )
  })

  it('prepares catalog and scoped chat token through the same coordinator', async () => {
    const deps = dependencies()
    const catalog = new ModelCatalogCoordinator(deps)

    const runtime = await catalog.prepareRuntime()

    expect(runtime.profiles).toEqual([profile])
    expect(runtime.chatToken).toBe('chat-token')
    expect(deps.projectModels).toHaveBeenCalledOnce()
  })

  it('publishes a renderer-safe provider label view', async () => {
    const catalog = new ModelCatalogCoordinator(dependencies())

    await expect(catalog.view()).resolves.toEqual({
      providerLabels: { 'three-a-main': '3A Main' },
    })
  })
})

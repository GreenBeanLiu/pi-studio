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

const deepSeekProfile: LlmProviderProfile = {
  id: 'deepseek',
  display_name: 'DeepSeek 官方',
  base_url: 'https://api.deepseek.com',
  api_type: 'openai-completions',
  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  enabled: true,
  sort_order: 2,
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
      favoriteModelRoutes: [],
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
    loadCachedProfiles: vi.fn(() => []),
    saveCachedProfiles: vi.fn(),
    migrateOfficialDeepSeekFavorites: vi.fn(() => false),
    loadAvailableModels: vi.fn(async () => []),
    saveCustomModelIds: vi.fn(),
    ...overrides,
  }
}

describe('model catalog coordination', () => {
  it('projects and publishes one consistent catalog after a profile mutation', async () => {
    const onChanged = vi.fn()
    const deps = dependencies()
    const catalog = new ModelCatalogCoordinator(deps, onChanged)

    const result = await catalog.saveProfile({
      create: true,
      profile: {
        id: 'three-a-main',
        display_name: '3A Main',
        base_url: 'https://api.3a-api.com/v1',
        api_type: 'openai-completions',
        api_key: 'new-key',
        models: ['gpt-5.5'],
        enabled: true,
        sort_order: 0,
      },
    })

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

  it('publishes a model-switcher refresh when cloud favorites are migrated', async () => {
    const onChanged = vi.fn()
    const migrateOfficialDeepSeekFavorites = vi.fn(() => true)
    const deps = dependencies({
      fetchCatalog: vi.fn(async () => ({ providers: [profile, deepSeekProfile] })),
      migrateOfficialDeepSeekFavorites,
    } as never)

    await new ModelCatalogCoordinator(deps, onChanged).sync()

    expect(migrateOfficialDeepSeekFavorites).toHaveBeenCalledWith([
      profile,
      deepSeekProfile,
    ])
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('migrates DeepSeek favorites from the cached catalog when refresh is offline', async () => {
    const onChanged = vi.fn()
    const migrateOfficialDeepSeekFavorites = vi.fn(() => true)
    const deps = dependencies({
      fetchCatalog: vi.fn(async () => {
        throw new Error('offline')
      }),
      loadCachedProfiles: vi.fn(() => [deepSeekProfile]),
      migrateOfficialDeepSeekFavorites,
    })

    await new ModelCatalogCoordinator(deps, onChanged).sync()

    expect(migrateOfficialDeepSeekFavorites).toHaveBeenCalledWith([deepSeekProfile])
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('defers the one-time migration when no model-switcher notifier is attached', async () => {
    const migrateOfficialDeepSeekFavorites = vi.fn(() => true)
    const deps = dependencies({ migrateOfficialDeepSeekFavorites })

    await new ModelCatalogCoordinator(deps).sync()

    expect(migrateOfficialDeepSeekFavorites).not.toHaveBeenCalled()
  })

  it('removes projected cloud models when a scoped session token cannot be issued', async () => {
    const deps = dependencies({
      createSessionToken: vi.fn(async () => {
        throw new Error('token unavailable')
      }),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.prepareRuntime()).resolves.toEqual({
      profiles: [],
      chatToken: '',
      warning: 'token unavailable',
    })
    expect(deps.projectModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ gatewayProfiles: [] }),
    )
  })

  it('keeps the selected cloud lane when catalog refresh fails but a cached catalog exists', async () => {
    const deps = dependencies({
      fetchCatalog: vi.fn(async () => {
        throw new Error('catalog offline')
      }),
      loadCachedProfiles: vi.fn(() => [profile]),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.prepareRuntime()).resolves.toEqual({
      profiles: [profile],
      chatToken: 'chat-token',
      warning: 'catalog offline',
    })
    expect(deps.projectModels).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayProfiles: [profile] }),
    )
  })

  it('publishes a renderer-safe provider label view', async () => {
    const catalog = new ModelCatalogCoordinator(dependencies())

    await expect(catalog.loadProviderLabels()).resolves.toEqual({
      providerLabels: { 'three-a-main': '3A Main' },
    })
  })

  it('labels a legacy OpenAI-compatible 3A route as 3A API', async () => {
    const catalog = new ModelCatalogCoordinator(
      dependencies({
        loadLocalSettings: () => ({
          provider: 'openai',
          baseUrl: 'https://www.3a-api.com',
          heliconeEnabled: false,
          customModelIds: [],
          favoriteModelRoutes: [],
        }),
      }),
    )

    await expect(catalog.loadProviderLabels()).resolves.toEqual({
      providerLabels: {
        openai: '3A API',
        'three-a-main': '3A Main',
      },
    })
  })

  it('keeps the local 3A label when the cloud catalog is unavailable', async () => {
    const catalog = new ModelCatalogCoordinator(
      dependencies({
        loadLocalSettings: () => ({
          provider: 'openai',
          baseUrl: 'https://www.3a-api.com',
          heliconeEnabled: false,
          customModelIds: [],
          favoriteModelRoutes: [],
        }),
        getConnection: () => ({
          available: false,
          relay: '',
          key: null,
          error: 'cloud unavailable',
        }),
      }),
    )

    await expect(catalog.loadProviderLabels()).resolves.toEqual({
      providerLabels: { openai: '3A API' },
    })
  })

  it('loads local and cached labels without waiting for the cloud catalog', () => {
    const fetchCatalog = vi.fn(async () => ({ providers: [profile] }))
    const catalog = new ModelCatalogCoordinator(
      dependencies({
        loadLocalSettings: () => ({
          provider: 'openai',
          baseUrl: 'https://www.3a-api.com',
          heliconeEnabled: false,
          customModelIds: [],
          favoriteModelRoutes: [],
        }),
        loadCachedProfiles: vi.fn(() => [deepSeekProfile]),
        fetchCatalog,
      }),
    )

    expect(catalog.loadCachedProviderLabels()).toEqual({
      providerLabels: {
        openai: '3A API',
        deepseek: 'DeepSeek 官方',
      },
    })
    expect(fetchCatalog).not.toHaveBeenCalled()
  })

  it('loads provider labels from the last valid cache when the gateway is offline', async () => {
    const catalog = new ModelCatalogCoordinator(
      dependencies({
        fetchCatalog: vi.fn(async () => {
          throw new Error('offline')
        }),
        loadCachedProfiles: vi.fn(() => [profile]),
      }),
    )

    await expect(catalog.loadProviderLabels()).resolves.toEqual({
      providerLabels: { 'three-a-main': '3A Main' },
    })
  })

  it('ignores malformed cached profiles before projecting them', async () => {
    const deps = dependencies({
      fetchCatalog: vi.fn(async () => {
        throw new Error('offline')
      }),
      loadCachedProfiles: vi.fn(
        () => [{ id: 'broken', models: ['x'], enabled: true }] as LlmProviderProfile[],
      ),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.sync()).resolves.toEqual({ profiles: [], warning: 'offline' })
    expect(deps.projectModels).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayProfiles: undefined }),
    )
  })

  it('reconciles only missing favorites for the active direct provider', async () => {
    const deps = dependencies({
      loadLocalSettings: () => ({
        provider: 'openai',
        baseUrl: '',
        heliconeEnabled: false,
        customModelIds: ['existing-model'],
        favoriteModelRoutes: [
          { provider: 'openai', model: 'custom-direct' },
          { provider: 'three-a-main', model: 'cloud-only' },
        ],
      }),
      loadAvailableModels: vi.fn(async () => [
        { provider: 'openai', id: 'existing-model' },
        { provider: 'three-a-main', id: 'gpt-5.5' },
      ]),
    })
    const catalog = new ModelCatalogCoordinator(deps)

    await expect(catalog.reconcileFavoriteRoutes()).resolves.toEqual({ changed: true })
    expect(deps.saveCustomModelIds).toHaveBeenCalledWith(['existing-model', 'custom-direct'])
    expect(deps.projectModels).toHaveBeenCalledOnce()
  })

  it('matches favorite routes case-insensitively using the shared route identity', async () => {
    const deps = dependencies({
      loadLocalSettings: () => ({
        provider: 'openai',
        baseUrl: '',
        heliconeEnabled: false,
        customModelIds: [],
        favoriteModelRoutes: [{ provider: 'openai', model: 'custom-direct' }],
      }),
      loadAvailableModels: vi.fn(async () => [
        { provider: 'OpenAI', id: 'CUSTOM-DIRECT' },
      ]),
    })

    await expect(new ModelCatalogCoordinator(deps).reconcileFavoriteRoutes()).resolves.toEqual({
      changed: false,
    })
    expect(deps.saveCustomModelIds).not.toHaveBeenCalled()
  })
})

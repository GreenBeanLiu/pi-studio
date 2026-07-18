import { getCloudConnection, type CloudConnection } from './cloud-connection'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  createLlmProfile,
  createLlmSessionToken,
  deleteLlmProfile,
  fetchLlmCatalog,
  listLlmProfiles,
  refreshLlmProfileModels,
  updateLlmProfile,
  type LlmCatalog,
  type LlmProviderProfile,
} from './llm-gateway'
import {
  agentConfigDir,
  loadSettings,
  saveCustomModelIds,
  writeModelsOverride,
  type PiProvider,
} from './settings'
import { piClientManager } from './pi-client'
import type { LlmProfileSavePayload, ModelCatalogView } from '../shared/contracts'
import { favoriteRouteKey, type ModelRoute } from '../shared/model-route'

type LocalModelSettings = {
  provider: PiProvider
  baseUrl: string
  heliconeEnabled: boolean
  customModelIds: string[]
  favoriteModelRoutes: ModelRoute[]
}

type ModelProjection = LocalModelSettings & {
  gatewayRelay: string
  gatewayProfiles?: LlmProviderProfile[]
}

export type ModelCatalogDependencies = {
  loadLocalSettings: () => LocalModelSettings
  getConnection: () => CloudConnection
  fetchCatalog: (relay: string, appKey: string) => Promise<LlmCatalog>
  createSessionToken: typeof createLlmSessionToken
  listProfiles: typeof listLlmProfiles
  createProfile: typeof createLlmProfile
  updateProfile: typeof updateLlmProfile
  deleteProfile: typeof deleteLlmProfile
  refreshProfileModels: typeof refreshLlmProfileModels
  projectModels: (projection: ModelProjection) => void
  loadCachedProfiles: () => LlmProviderProfile[]
  saveCachedProfiles: (profiles: LlmProviderProfile[]) => void
  loadAvailableModels: () => Promise<Array<{ provider: string; id: string }>>
  saveCustomModelIds: (ids: string[]) => void
}

export type ModelCatalogSync = {
  profiles: LlmProviderProfile[]
  warning?: string
}

export type ModelCatalogRuntime = ModelCatalogSync & {
  chatToken: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function catalogCachePath(): string {
  return join(agentConfigDir(), 'model-catalog-cache.json')
}

function isLlmProviderProfile(value: unknown): value is LlmProviderProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<LlmProviderProfile>
  return (
    typeof profile.id === 'string' &&
    !!profile.id.trim() &&
    typeof profile.display_name === 'string' &&
    !!profile.display_name.trim() &&
    (profile.base_url === undefined || typeof profile.base_url === 'string') &&
    profile.api_type === 'openai-completions' &&
    Array.isArray(profile.models) &&
    profile.models.every((model) => typeof model === 'string' && !!model.trim()) &&
    typeof profile.enabled === 'boolean' &&
    typeof profile.sort_order === 'number' &&
    Number.isFinite(profile.sort_order) &&
    typeof profile.has_key === 'boolean'
  )
}

function validProfiles(values: unknown[]): LlmProviderProfile[] {
  return values.filter(isLlmProviderProfile)
}

function loadCatalogCache(): LlmProviderProfile[] {
  const path = catalogCachePath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { profiles?: unknown }
    if (!Array.isArray(parsed.profiles)) return []
    return validProfiles(parsed.profiles)
  } catch {
    return []
  }
}

function saveCatalogCache(profiles: LlmProviderProfile[]): void {
  const path = catalogCachePath()
  mkdirSync(agentConfigDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({ profiles }, null, 2), 'utf-8')
}

export function defaultModelCatalogDependencies(): ModelCatalogDependencies {
  return {
    loadLocalSettings: () => {
      const settings = loadSettings()
      return {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        heliconeEnabled: !!settings.heliconeApiKey,
        customModelIds: settings.customModelIds,
        favoriteModelRoutes: settings.favoriteModelRoutes,
      }
    },
    getConnection: getCloudConnection,
    fetchCatalog: fetchLlmCatalog,
    createSessionToken: createLlmSessionToken,
    listProfiles: listLlmProfiles,
    createProfile: createLlmProfile,
    updateProfile: updateLlmProfile,
    deleteProfile: deleteLlmProfile,
    refreshProfileModels: refreshLlmProfileModels,
    projectModels: (projection) =>
      writeModelsOverride(
        projection.provider,
        projection.baseUrl,
        projection.heliconeEnabled,
        projection.customModelIds,
        projection.gatewayRelay,
        projection.gatewayProfiles,
      ),
    loadCachedProfiles: loadCatalogCache,
    saveCachedProfiles: saveCatalogCache,
    loadAvailableModels: () => piClientManager.getAvailableModels(),
    saveCustomModelIds,
  }
}

/** Owns remote catalog refresh, Pi registry projection, fallback, and change publication. */
export class ModelCatalogCoordinator {
  constructor(
    private readonly dependencies = defaultModelCatalogDependencies(),
    private readonly onChanged: () => void = () => undefined,
  ) {}

  private project(
    connection: CloudConnection,
    gatewayProfiles?: LlmProviderProfile[],
  ): void {
    const local = this.dependencies.loadLocalSettings()
    this.dependencies.projectModels({
      ...local,
      gatewayRelay: connection.relay,
      gatewayProfiles,
    })
  }

  private async loadAndProject(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<LlmProviderProfile[]> {
    const profiles = (await this.fetchAndCacheProfiles(connection)).filter(
      (profile) => profile.enabled && profile.models.length > 0,
    )
    this.project(connection, profiles)
    return profiles
  }

  private async fetchAndCacheProfiles(
    connection: Extract<CloudConnection, { available: true }>,
  ): Promise<LlmProviderProfile[]> {
    const catalog = await this.dependencies.fetchCatalog(connection.relay, connection.key)
    const profiles = validProfiles(catalog.providers)
    this.dependencies.saveCachedProfiles(profiles)
    return profiles
  }

  private loadCachedAndProject(connection: CloudConnection): LlmProviderProfile[] {
    const profiles = validProfiles(this.dependencies.loadCachedProfiles())
      .filter((profile) => profile.enabled && profile.models.length > 0)
    this.project(connection, profiles.length > 0 ? profiles : undefined)
    return profiles
  }

  async sync(): Promise<ModelCatalogSync> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [])
      return { profiles: [] }
    }
    try {
      return { profiles: await this.loadAndProject(connection) }
    } catch (error) {
      return {
        profiles: this.loadCachedAndProject(connection),
        warning: errorMessage(error),
      }
    }
  }

  async prepareRuntime(): Promise<ModelCatalogRuntime> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection, [])
      return { profiles: [], chatToken: '' }
    }
    const [catalogResult, sessionResult] = await Promise.allSettled([
      this.loadAndProject(connection),
      this.dependencies.createSessionToken(connection.relay, connection.key),
    ])
    const warnings: string[] = []
    const profiles =
      catalogResult.status === 'fulfilled'
        ? catalogResult.value
        : this.loadCachedAndProject(connection)
    if (catalogResult.status === 'rejected') warnings.push(errorMessage(catalogResult.reason))
    if (sessionResult.status === 'rejected') warnings.push(errorMessage(sessionResult.reason))
    if (sessionResult.status === 'rejected') this.project(connection, [])
    return {
      profiles: sessionResult.status === 'fulfilled' ? profiles : [],
      chatToken: sessionResult.status === 'fulfilled' ? sessionResult.value.token : '',
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    }
  }

  async listProfiles(): Promise<LlmProviderProfile[]> {
    const connection = this.requireConnection()
    return this.dependencies.listProfiles(connection.relay, connection.key)
  }

  async loadProviderLabels(): Promise<ModelCatalogView> {
    const connection = this.requireConnection()
    let profiles: LlmProviderProfile[]
    try {
      profiles = await this.fetchAndCacheProfiles(connection)
    } catch (error) {
      profiles = validProfiles(this.dependencies.loadCachedProfiles())
      if (profiles.length === 0) throw error
    }
    return {
      providerLabels: Object.fromEntries(
        profiles.map((profile) => [profile.id, profile.display_name]),
      ),
    }
  }

  private async mutateAndPublish<T>(mutation: () => Promise<T>): Promise<{
    value: T
    warning?: string
  }> {
    const value = await mutation()
    const sync = await this.sync()
    this.onChanged()
    return { value, warning: sync.warning }
  }

  async saveProfile(
    payload: LlmProfileSavePayload,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      payload.create
        ? this.dependencies.createProfile(connection.relay, connection.key, payload.profile)
        : this.dependencies.updateProfile(connection.relay, connection.key, payload.profile),
    )
    return { profile: result.value, warning: result.warning }
  }

  async reconcileFavoriteRoutes(): Promise<{ changed: boolean; warning?: string }> {
    const local = this.dependencies.loadLocalSettings()
    const available = await this.dependencies.loadAvailableModels()
    const known = new Set(
      available.map((model) => favoriteRouteKey(model.provider, model.id)),
    )
    const missing = local.favoriteModelRoutes
      .filter(
        (route) =>
          route.provider === local.provider &&
          !known.has(favoriteRouteKey(route.provider, route.model)),
      )
      .map((route) => route.model)
    const next = [...new Set([...local.customModelIds, ...missing])]
    if (next.length === local.customModelIds.length) return { changed: false }
    this.dependencies.saveCustomModelIds(next)
    const sync = await this.sync()
    return { changed: true, warning: sync.warning }
  }

  async deleteProfile(id: string): Promise<{ warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      this.dependencies.deleteProfile(connection.relay, connection.key, id),
    )
    return { warning: result.warning }
  }

  async refreshProfileModels(
    id: string,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const result = await this.mutateAndPublish(() =>
      this.dependencies.refreshProfileModels(connection.relay, connection.key, id),
    )
    return { profile: result.value, warning: result.warning }
  }

  private requireConnection(): Extract<CloudConnection, { available: true }> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      throw new Error(connection.error || 'Pi Studio cloud service is not configured')
    }
    return connection
  }
}

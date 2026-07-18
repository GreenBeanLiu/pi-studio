import { getCloudConnection, type CloudConnection } from './cloud-connection'
import {
  createLlmProfile,
  createLlmSessionToken,
  deleteLlmProfile,
  fetchLlmCatalog,
  listLlmProfiles,
  refreshLlmProfileModels,
  updateLlmProfile,
  type LlmCatalog,
  type LlmProfileWrite,
  type LlmProviderProfile,
} from './llm-gateway'
import { loadSettings, writeModelsOverride, type PiProvider } from './settings'
import type { ModelCatalogView } from '../shared/contracts'

type LocalModelSettings = {
  provider: PiProvider
  baseUrl: string
  heliconeEnabled: boolean
  customModelIds: string[]
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

export function defaultModelCatalogDependencies(): ModelCatalogDependencies {
  return {
    loadLocalSettings: () => {
      const settings = loadSettings()
      return {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        heliconeEnabled: !!settings.heliconeApiKey,
        customModelIds: settings.customModelIds,
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

  async sync(): Promise<ModelCatalogSync> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection)
      return { profiles: [] }
    }
    try {
      const catalog = await this.dependencies.fetchCatalog(connection.relay, connection.key)
      const profiles = catalog.providers.filter((profile) => profile.models.length > 0)
      this.project(connection, profiles)
      return { profiles }
    } catch (error) {
      // Omitting gatewayProfiles preserves the last known cloud projection on disk.
      this.project(connection)
      return { profiles: [], warning: errorMessage(error) }
    }
  }

  async prepareRuntime(): Promise<ModelCatalogRuntime> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      this.project(connection)
      return { profiles: [], chatToken: '' }
    }
    try {
      const [catalog, session] = await Promise.all([
        this.dependencies.fetchCatalog(connection.relay, connection.key),
        this.dependencies.createSessionToken(connection.relay, connection.key),
      ])
      const profiles = catalog.providers.filter((profile) => profile.models.length > 0)
      this.project(connection, profiles)
      return { profiles, chatToken: session.token }
    } catch (error) {
      this.project(connection)
      return { profiles: [], chatToken: '', warning: errorMessage(error) }
    }
  }

  async listProfiles(): Promise<LlmProviderProfile[]> {
    const connection = this.requireConnection()
    return this.dependencies.listProfiles(connection.relay, connection.key)
  }

  async view(): Promise<ModelCatalogView> {
    const connection = this.requireConnection()
    const catalog = await this.dependencies.fetchCatalog(connection.relay, connection.key)
    return {
      providerLabels: Object.fromEntries(
        catalog.providers.map((profile) => [profile.id, profile.display_name]),
      ),
    }
  }

  async saveProfile(
    profile: LlmProfileWrite,
    create: boolean,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const saved = create
      ? await this.dependencies.createProfile(connection.relay, connection.key, profile)
      : await this.dependencies.updateProfile(connection.relay, connection.key, profile)
    const sync = await this.sync()
    this.onChanged()
    return { profile: saved, warning: sync.warning }
  }

  async deleteProfile(id: string): Promise<{ warning?: string }> {
    const connection = this.requireConnection()
    await this.dependencies.deleteProfile(connection.relay, connection.key, id)
    const sync = await this.sync()
    this.onChanged()
    return { warning: sync.warning }
  }

  async refreshProfileModels(
    id: string,
  ): Promise<{ profile: LlmProviderProfile; warning?: string }> {
    const connection = this.requireConnection()
    const profile = await this.dependencies.refreshProfileModels(
      connection.relay,
      connection.key,
      id,
    )
    const sync = await this.sync()
    this.onChanged()
    return { profile, warning: sync.warning }
  }

  private requireConnection(): Extract<CloudConnection, { available: true }> {
    const connection = this.dependencies.getConnection()
    if (!connection.available) {
      throw new Error(connection.error || 'Pi Studio cloud service is not configured')
    }
    return connection
  }
}

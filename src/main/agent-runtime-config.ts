import { appendAppLog, normalizeError } from './app-log'
import type { LlmProviderProfile } from './llm-gateway'
import { ModelCatalogCoordinator } from './model-catalog'
import { agentConfigDir, apiKeyEnvVar, loadSettings } from './settings'
import { selectRuntimeModelRoute } from '../shared/model-route'

export type AgentRuntimeConfig = {
  provider: string
  model?: string
  env: Record<string, string>
  gatewayProfiles: LlmProviderProfile[]
}

/**
 * Single provider/runtime seam for chat, routines, and model-building agents.
 * A cloud failure keeps the last written gateway providers while still updating
 * the direct-provider override; cloud-only launches fail instead of silently
 * starting a subprocess without credentials.
 */
export async function prepareAgentRuntime(): Promise<AgentRuntimeConfig> {
  const settings = loadSettings()
  const catalog = await new ModelCatalogCoordinator().prepareRuntime()
  const gatewayProfiles = catalog.profiles
  const gatewayChatToken = catalog.chatToken
  if (catalog.warning) {
    appendAppLog(
      'warn',
      'llm.catalog',
      'Failed to prepare cloud model runtime',
      normalizeError(catalog.warning),
    )
  }

  // 本地直连 provider 供得出什么,以用户自己配过的为准:自定义模型 id(写进 models.json
  // 的那批)加模型切换列表里点名的。pi 内置注册表不能拿来当判据 —— 自建网关不供的老模型
  // 也在里面躺着。
  const localModels = [
    ...settings.customModelIds,
    ...settings.favoriteModelRoutes
      .filter((route) => route.provider === settings.provider)
      .map((route) => route.model),
  ]

  const selectedRoute = selectRuntimeModelRoute({
    selected: settings.selectedModelRoute,
    localProvider: settings.provider,
    localModel: settings.model,
    localKeyConfigured: !!settings.apiKey,
    localModels,
    gatewayProfiles,
  })

  if (!selectedRoute) {
    throw new Error('请先配置本地直连 API Key，或在云端模型线路中添加可用模型')
  }

  return {
    provider: selectedRoute.provider,
    model: selectedRoute.model || undefined,
    env: {
      ...(settings.apiKey ? { [apiKeyEnvVar(settings.provider)]: settings.apiKey } : {}),
      ...(gatewayChatToken ? { PI_STUDIO_LLM_KEY: gatewayChatToken } : {}),
      PI_CODING_AGENT_DIR: agentConfigDir(),
      ...(settings.tavilyApiKey ? { TAVILY_API_KEY: settings.tavilyApiKey } : {}),
      ...(settings.heliconeApiKey ? { HELICONE_API_KEY: settings.heliconeApiKey } : {}),
    },
    gatewayProfiles,
  }
}

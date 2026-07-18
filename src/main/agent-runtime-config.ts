import { appendAppLog, normalizeError } from './app-log'
import { getCloud } from './image-gen'
import { createLlmSessionToken, fetchLlmCatalog, type LlmProviderProfile } from './llm-gateway'
import {
  agentConfigDir,
  apiKeyEnvVar,
  loadSettings,
  writeModelsOverride,
} from './settings'

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
  const cloud = getCloud()
  let gatewayProfiles: LlmProviderProfile[] = []
  let gatewayChatToken = ''

  if (cloud.available) {
    try {
      const [catalog, session] = await Promise.all([
        fetchLlmCatalog(cloud.relay, cloud.key),
        createLlmSessionToken(cloud.relay, cloud.key),
      ])
      gatewayProfiles = catalog.providers.filter((profile) => profile.models.length > 0)
      gatewayChatToken = session.token
      writeModelsOverride(
        settings.provider,
        settings.baseUrl,
        !!settings.heliconeApiKey,
        settings.customModelIds,
        cloud.relay,
        gatewayProfiles,
      )
    } catch (err) {
      appendAppLog('warn', 'llm.catalog', 'Failed to prepare cloud model runtime', normalizeError(err))
      writeModelsOverride(
        settings.provider,
        settings.baseUrl,
        !!settings.heliconeApiKey,
        settings.customModelIds,
      )
    }
  } else {
    writeModelsOverride(
      settings.provider,
      settings.baseUrl,
      !!settings.heliconeApiKey,
      settings.customModelIds,
    )
  }

  if (!settings.apiKey && gatewayProfiles.length === 0) {
    throw new Error('请先配置本地直连 API Key，或在云端模型线路中添加可用模型')
  }

  return {
    provider: settings.apiKey ? settings.provider : gatewayProfiles[0].id,
    model: settings.apiKey ? settings.model || undefined : gatewayProfiles[0].models[0] || undefined,
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

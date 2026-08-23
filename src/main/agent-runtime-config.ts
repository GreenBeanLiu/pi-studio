import { appendAppLog, normalizeError } from './app-log'
import type { LlmProviderProfile } from './llm-gateway'
import { ModelCatalogCoordinator } from './model-catalog'
import { agentConfigDir, loadSettings } from './settings'
import { selectRuntimeModelRoute } from '../shared/model-route'
import {
  sharedMemoryPath,
} from './workspace-memory'
import { getSharedMemoryConnection, startSharedMemoryService } from './shared-memory'

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
export async function prepareAgentRuntime(cwd?: string): Promise<AgentRuntimeConfig> {
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

  const selectedRoute = selectRuntimeModelRoute({
    selected: settings.selectedModelRoute,
    gatewayProfiles,
  })

  if (!selectedRoute) {
    throw new Error('请先在云端模型线路中添加可用模型')
  }

  const memory = getSharedMemoryConnection() ?? await startSharedMemoryService(sharedMemoryPath())

  return {
    provider: selectedRoute.provider,
    model: selectedRoute.model || undefined,
    env: {
      ...(gatewayChatToken ? { PI_STUDIO_LLM_KEY: gatewayChatToken } : {}),
      PI_CODING_AGENT_DIR: agentConfigDir(),
      PI_STUDIO_MEMORY_URL: memory.url,
      PI_STUDIO_MEMORY_TOKEN: memory.token,
      PI_STUDIO_MEMORY_FILE: sharedMemoryPath(),
      ...(cwd ? { PI_STUDIO_MEMORY_WORKSPACE_PATH: cwd } : {}),
      ...(settings.tavilyApiKey ? { TAVILY_API_KEY: settings.tavilyApiKey } : {}),
    },
    gatewayProfiles,
  }
}

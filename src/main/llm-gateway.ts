import type {
  LlmModelMetadata,
  LlmProfileWrite,
  LlmProviderHealth,
  LlmProviderProfile,
} from '../shared/contracts'
import { cloudFetch } from './cloud-fetch'

export type { LlmProfileWrite, LlmProviderHealth, LlmProviderProfile } from '../shared/contracts'

export type LlmCatalog = { providers: LlmProviderProfile[] }

export function listEnabledLlmRoutes(catalog: LlmCatalog): string[] {
  return catalog.providers
    .filter((profile) => profile.enabled)
    .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name))
    .flatMap((profile) =>
      profile.models
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) => `${profile.id}::${model}`),
    )
}

export type PiCustomModelConfig = {
  id: string
  name: string
} & Omit<LlmModelMetadata, 'name'>

export type PiCustomProviderConfig = {
  baseUrl: string
  api: 'openai-completions'
  apiKey: '$PI_STUDIO_LLM_KEY'
  models: PiCustomModelConfig[]
}

/** 云端 catalog 可下发模型能力；这里的模型名判断只作为旧 catalog 的兜底。 */
export function isGatewayReasoningModel(id: string): boolean {
  const s = id.toLowerCase()
  if (/non-reasoning|composer|fast|build|image|embed|whisper|tts/.test(s)) return false
  return /grok-4|grok-[5-9]|gpt-5|gpt-[6-9]|^o[1-9]|reasoning|deepseek-(?:r|v4)|glm.*think|qwq/.test(s)
}

function modelFromMetadata(id: string, metadata: LlmModelMetadata): PiCustomModelConfig {
  const { name, ...rest } = metadata
  return { id, name: name?.trim() || id, ...rest }
}

function buildGatewayModel(profile: LlmProviderProfile, id: string): PiCustomModelConfig {
  const metadata = profile.model_metadata?.[id]
  if (metadata) return modelFromMetadata(id, metadata)

  const reasoning = isGatewayReasoningModel(id)
  if (!reasoning) return { id, name: id }
  if (profile.id === 'deepseek' && id.toLowerCase().startsWith('deepseek-v4-')) {
    const isPro = id.toLowerCase() === 'deepseek-v4-pro'
    return {
      id,
      name: isPro ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash',
      reasoning: true,
      input: ['text'],
      // 官网 2026-09-13(CNY / 1M tokens,峰时):flash 未命中 ¥2 / 输出 ¥8 / 命中 ¥0.04,
      // pro ¥9 / ¥27 / ¥0.30;按 ≈6.8 折 USD。谷时半价,这里按峰时标。之前的 0.14 / 0.28 那组不知出处,
      // 比官网低两到四倍,后端网关按它算预算兜底时兜不住 —— 云端 profile 的 metadata 已改成这组。
      cost: {
        input: isPro ? 1.32 : 0.3,
        output: isPro ? 3.96 : 1.2,
        cacheRead: isPro ? 0.044 : 0.006,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: {
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
      },
    }
  }
  return { id, name: id, reasoning: true, compat: { supportsReasoningEffort: true } }
}

export function buildGatewayProviderConfigs(
  relay: string,
  profiles: LlmProviderProfile[],
): Record<string, PiCustomProviderConfig> {
  const root = relay.trim().replace(/\/+$/, '')
  return Object.fromEntries(
    profiles
      .filter((profile) => profile.enabled && profile.models.length > 0)
      .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name))
      .map((profile) => [
        profile.id,
        {
          baseUrl: `${root}/llm/v1/${encodeURIComponent(profile.id)}`,
          api: 'openai-completions' as const,
          apiKey: '$PI_STUDIO_LLM_KEY' as const,
          models: profile.models.map((id) => buildGatewayModel(profile, id)),
        },
      ]),
  )
}

async function gatewayJson<T>(
  relay: string,
  appKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await cloudFetch(`${relay.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': appKey,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as { detail?: string }
      if (payload.detail) detail = payload.detail
    } catch {
      // Keep the stable status fallback; never copy an HTML error page into the UI.
    }
    throw new Error(detail)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function fetchLlmCatalog(relay: string, appKey: string): Promise<LlmCatalog> {
  return gatewayJson(relay, appKey, '/llm/catalog')
}

export function createLlmSessionToken(
  relay: string,
  appKey: string,
): Promise<{ token: string; expires_at: number; scope: 'llm:chat' }> {
  return gatewayJson(relay, appKey, '/llm/session-token', { method: 'POST' })
}

/**
 * 给 agent 子进程换一张只能出图的票。子进程不该拿 appKey 本身 —— 那把 key 在后端
 * 是管理员(能改 provider 的 base_url、签 chat token、读日志),而 image_gen 扩展
 * 只需要 POST /imagegen 和 /imagegen/reference。票一天作废,每次 spawn 都换新。
 */
export function createImageAgentToken(
  relay: string,
  appKey: string,
): Promise<{ token: string; expires_at: number; scope: 'imagegen:agent' }> {
  return gatewayJson(relay, appKey, '/imagegen/agent-token', { method: 'POST' })
}

export function listLlmProfiles(relay: string, appKey: string): Promise<LlmProviderProfile[]> {
  return gatewayJson(relay, appKey, '/llm/profiles')
}

export function createLlmProfile(
  relay: string,
  appKey: string,
  profile: LlmProfileWrite,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, '/llm/profiles', {
    method: 'POST',
    body: JSON.stringify(profile),
  })
}

export function updateLlmProfile(
  relay: string,
  appKey: string,
  profile: LlmProfileWrite,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function deleteLlmProfile(relay: string, appKey: string, id: string): Promise<void> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function refreshLlmProfileModels(
  relay: string,
  appKey: string,
  id: string,
): Promise<LlmProviderProfile> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}/refresh-models`, {
    method: 'POST',
  })
}

export function fetchLlmProviderHealth(
  relay: string,
  appKey: string,
  id: string,
): Promise<LlmProviderHealth> {
  return gatewayJson(relay, appKey, `/llm/profiles/${encodeURIComponent(id)}/provider-health`)
}

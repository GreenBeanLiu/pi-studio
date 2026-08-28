import type { LlmModelMetadata, LlmProfileWrite, LlmProviderProfile } from '../shared/contracts'

export type { LlmProfileWrite, LlmProviderProfile } from '../shared/contracts'

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
      cost: {
        input: isPro ? 0.435 : 0.14,
        output: isPro ? 0.87 : 0.28,
        cacheRead: isPro ? 0.003625 : 0.0028,
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
  const response = await fetch(`${relay.replace(/\/+$/, '')}${path}`, {
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

import type { LlmProfileWrite, LlmProviderProfile } from '../shared/contracts'

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
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Partial<
    Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>
  >
  compat?: {
    supportsReasoningEffort?: boolean
    requiresReasoningContentOnAssistantMessages?: boolean
    thinkingFormat?: 'deepseek'
  }
}

export type PiCustomProviderConfig = {
  baseUrl: string
  api: 'openai-completions'
  apiKey: '$PI_STUDIO_LLM_KEY'
  models: PiCustomModelConfig[]
}

/**
 * 网关模型是自定义 provider id(three-a-*),pi 内置 registry 没有它们的元数据,
 * getAvailableModels 里 reasoning 全默认成 false —— 于是聊天页 hover 不显示推理深度、
 * pi 也不给上游带 reasoning_effort。这里按 id 补判断,让推理类模型标 reasoning:true +
 * supportsReasoningEffort。宁可给非推理模型多带个被忽略的参数,也别漏掉真推理模型。
 */
export function isGatewayReasoningModel(id: string): boolean {
  const s = id.toLowerCase()
  if (/non-reasoning|composer|fast|build|image|embed|whisper|tts/.test(s)) return false
  return /grok-4|grok-[5-9]|gpt-5|gpt-[6-9]|^o[1-9]|reasoning|deepseek-(?:r|v4)|glm.*think|qwq/.test(s)
}

function buildGatewayModel(profileId: string, id: string): PiCustomModelConfig {
  const reasoning = isGatewayReasoningModel(id)
  if (!reasoning) return { id, name: id }
  if (profileId === 'deepseek' && id.toLowerCase().startsWith('deepseek-v4-')) {
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
          models: profile.models.map((id) => buildGatewayModel(profile.id, id)),
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

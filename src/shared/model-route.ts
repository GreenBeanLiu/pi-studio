import { DEFAULT_MODEL_ROUTE } from './agent-defaults'

/**
 * 外部 ACP agent(Claude Code / Codex 等)在模型选择器里共用的 provider。
 *
 * 放在 shared 是因为 main 要用它投影目录、renderer 要用它把这一组单独对待:
 * ACP 是一小撮外部 agent,不该被「模型切换列表」那套收藏过滤掉。
 */
export const ACP_MODEL_PROVIDER = 'acp'

/** 这一组在界面上的名字。providerLabels 来自网关 profile,不会有 acp。 */
export const ACP_PROVIDER_LABEL = '外部 Agent (ACP)'

export function isAcpModelRoute(provider: string): boolean {
  return provider === ACP_MODEL_PROVIDER
}

export type ModelRoute = {
  provider: string
  model: string
}

export type RuntimeModelRouteInput = {
  selected: ModelRoute | null
  gatewayProfiles: Array<{ id: string; models: string[] }>
}

export function favoriteRouteKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`.toLowerCase()
}

export function parseFavoriteModelRoutes(value: string, legacyProvider: string): ModelRoute[] {
  const routes: ModelRoute[] = []
  const seen = new Set<string>()
  for (const token of value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)) {
    const separator = token.indexOf('::')
    const provider = separator > 0 ? token.slice(0, separator).trim() : legacyProvider.trim()
    const model = separator > 0 ? token.slice(separator + 2).trim() : token
    if (!provider || !model) continue
    const key = favoriteRouteKey(provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider, model })
  }
  return routes
}

export function formatFavoriteModelRoutes(routes: ModelRoute[]): string {
  return routes.map((route) => `${route.provider}::${route.model}`).join(', ')
}

export function selectRuntimeModelRoute(input: RuntimeModelRouteInput): ModelRoute | null {
  if (input.selected) {
    const stillOnOffer = input.gatewayProfiles.some(
      (profile) =>
        profile.id === input.selected?.provider && profile.models.includes(input.selected.model),
    )
    if (stillOnOffer) return input.selected
  }

  const defaultProfile = input.gatewayProfiles.find(
    (profile) => profile.id === DEFAULT_MODEL_ROUTE.provider,
  )
  if (defaultProfile?.models.includes(DEFAULT_MODEL_ROUTE.model)) {
    return { ...DEFAULT_MODEL_ROUTE }
  }

  // 默认模型被服务端改名/下架时,宁可退到同一个 profile 的别的模型,也别甩到另一家
  // provider 去 —— 那个 profile 是特意选的默认。
  if (defaultProfile?.models.length) {
    return { provider: defaultProfile.id, model: defaultProfile.models[0] }
  }

  const firstProfile = input.gatewayProfiles.find((profile) => profile.models.length > 0)
  return firstProfile
    ? { provider: firstProfile.id, model: firstProfile.models[0] }
    : null
}

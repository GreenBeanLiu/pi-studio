import { DEFAULT_MODEL_ROUTE } from './agent-defaults'

export type ModelRoute = {
  provider: string
  model: string
}

export type RuntimeModelRouteInput = {
  selected: ModelRoute | null
  localProvider: string
  localModel: string
  localKeyConfigured: boolean
  /**
   * 本地直连 provider 实际供得出的模型(= 模型切换列表)。留空表示没配列表,
   * 无从判断该 provider 到底有哪些模型,这时一律放行。
   */
  localModels?: string[]
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

/**
 * 云端线路会核对模型还在不在目录里,本地直连线路原来只比对 provider 名字 —— 于是一条
 * 陈旧的 selectedModelRoute(比如 pi 内置注册表里有、但自建网关根本不供的 gpt-4-turbo)
 * 能一路盖过配好的 model 跑到网关才炸,报错还只说「没有产出任何文本」。两边对齐。
 */
function localProviderOffers(input: RuntimeModelRouteInput, model: string): boolean {
  const offered = input.localModels ?? []
  if (offered.length === 0) return true
  // 配在 model 字段上的那个是默认线路,始终算数。
  return model === input.localModel || offered.includes(model)
}

export function selectRuntimeModelRoute(input: RuntimeModelRouteInput): ModelRoute | null {
  if (input.selected) {
    const selectedIsLocal =
      input.localKeyConfigured &&
      input.selected.provider === input.localProvider &&
      localProviderOffers(input, input.selected.model)
    const selectedIsCloud = input.gatewayProfiles.some(
      (profile) =>
        profile.id === input.selected?.provider && profile.models.includes(input.selected.model),
    )
    if (selectedIsLocal || selectedIsCloud) return input.selected
  }

  const defaultCloudProfile = input.gatewayProfiles.find(
    (profile) =>
      profile.id === DEFAULT_MODEL_ROUTE.provider &&
      profile.models.includes(DEFAULT_MODEL_ROUTE.model),
  )
  if (defaultCloudProfile) return { ...DEFAULT_MODEL_ROUTE }

  if (input.localKeyConfigured) {
    return { provider: input.localProvider, model: input.localModel }
  }

  const firstProfile = input.gatewayProfiles.find((profile) => profile.models.length > 0)
  return firstProfile
    ? { provider: firstProfile.id, model: firstProfile.models[0] }
    : null
}

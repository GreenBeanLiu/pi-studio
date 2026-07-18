export type ModelRoute = {
  provider: string
  model: string
}

export type RuntimeModelRouteInput = {
  selected: ModelRoute | null
  localProvider: string
  localModel: string
  localKeyConfigured: boolean
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
    const selectedIsLocal =
      input.localKeyConfigured && input.selected.provider === input.localProvider
    const selectedIsCloud = input.gatewayProfiles.some(
      (profile) =>
        profile.id === input.selected?.provider && profile.models.includes(input.selected.model),
    )
    if (selectedIsLocal || selectedIsCloud) return input.selected
  }

  if (input.localKeyConfigured) {
    return { provider: input.localProvider, model: input.localModel }
  }

  const firstProfile = input.gatewayProfiles.find((profile) => profile.models.length > 0)
  return firstProfile
    ? { provider: firstProfile.id, model: firstProfile.models[0] }
    : null
}

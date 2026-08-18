import {
  favoriteRouteKey,
  formatFavoriteModelRoutes,
  parseFavoriteModelRoutes,
  type ModelRoute,
} from './model-route'

/**
 * 直连 provider 退役时的数据搬迁。
 *
 * 直连那条腿(baseUrl + 桌面端持有的上游 key)去掉之后,配置里所有 `openai::X` 形式的
 * 线路都成了死条目 —— 模型选择器按 provider 分组,openai 那组整组消失,人只会看到
 * 收藏项莫名少了几个。所以退役时要把它们落到真正供这个模型的网关 profile 上。
 */

type GatewayProfile = { id: string; models: string[] }

/** 哪个网关 profile 供这个模型;都不供就返回 null。 */
function findGatewayHome(profiles: GatewayProfile[], model: string): string | null {
  const wanted = model.trim().toLowerCase()
  if (!wanted) return null
  const home = profiles.find((profile) =>
    profile.models.some((candidate) => candidate.trim().toLowerCase() === wanted),
  )
  return home ? home.id : null
}

/**
 * 收藏列表:直连线路改挂到供得出该模型的网关 profile;没有归宿的丢掉(直连没了它也点不到)。
 * 已经是网关线路的原样保留,顺序不动。
 */
export function migrateDirectFavoritesToGateway(input: {
  favoriteModels: string
  directProvider: string
  gatewayProfiles: GatewayProfile[]
}): string {
  if (!input.favoriteModels.trim()) return input.favoriteModels

  const routes = parseFavoriteModelRoutes(input.favoriteModels, input.directProvider)
  const kept: ModelRoute[] = []
  const seen = new Set<string>()
  const keep = (provider: string, model: string): void => {
    const key = favoriteRouteKey(provider, model)
    if (seen.has(key)) return
    seen.add(key)
    kept.push({ provider, model })
  }

  for (const route of routes) {
    if (route.provider !== input.directProvider) {
      keep(route.provider, route.model)
      continue
    }
    const home = findGatewayHome(input.gatewayProfiles, route.model)
    if (home) keep(home, route.model)
  }

  return formatFavoriteModelRoutes(kept)
}

/**
 * 当前选中的线路。按「尽量别打断用户」的顺序找落脚点:
 *   1. 已经是网关线路 —— 不动;
 *   2. 直连线路,且网关供同名模型 —— 换 provider,模型不变;
 *   3. 上面都不成,退回直连那个 `model` 字段配的默认模型(它往往才是用户真正在用的);
 *   4. 还是没有 —— 返回 null,交给 DEFAULT_MODEL_ROUTE。
 *
 * 第 3 条是为这种情况留的:selectedModelRoute 里躺着一条早就不能用的脏数据(比如网关
 * 不供的 gpt-4-turbo),而 model 字段写的才是人一直在用的那个。
 */
export function migrateDirectSelectedRoute(input: {
  selected: ModelRoute | null
  directProvider: string
  directModel: string
  gatewayProfiles: GatewayProfile[]
}): ModelRoute | null {
  const { selected, directProvider, gatewayProfiles } = input

  if (selected && selected.provider !== directProvider) {
    const stillThere = gatewayProfiles.some(
      (profile) => profile.id === selected.provider && profile.models.includes(selected.model),
    )
    if (stillThere) return selected
  }

  if (selected && selected.provider === directProvider) {
    const home = findGatewayHome(gatewayProfiles, selected.model)
    if (home) return { provider: home, model: selected.model }
  }

  const fallbackHome = findGatewayHome(gatewayProfiles, input.directModel)
  if (fallbackHome) return { provider: fallbackHome, model: input.directModel.trim() }

  return null
}

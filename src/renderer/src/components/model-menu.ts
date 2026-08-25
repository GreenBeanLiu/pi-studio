import type { ModelInfo } from '../../../shared/ipc/contract'
import {
  ACP_PROVIDER_LABEL,
  favoriteRouteKey,
  isAcpModelRoute,
  type ModelRoute,
} from '../../../shared/model-route'

export type ModelMenuEntry = {
  key: string
  label: string
  info: ModelInfo
}

export type ModelMenuGroup = {
  type: 'group'
  label: string
  provider: string
  children: ModelMenuEntry[]
}

export type ModelMenuInput = {
  models: readonly ModelInfo[]
  favoriteModels: readonly ModelRoute[]
  providerLabels: Record<string, string>
  currentModel: { provider: string; id: string } | null
}

/** 每组在没配收藏时最多显示几个。registry 里的历史注册太多,全列会刷屏。 */
const FALLBACK_PER_PROVIDER = 8

/**
 * 模型选择器的分组。
 *
 * 配了「模型切换列表」就只显示列表里的模型 —— 没被点名的 provider 组整组消失
 * (registry 里的历史注册/本地直连残留不再刷屏);完全没配时才回退每组最新 8 个。
 *
 * 外部 ACP agent 那一组是例外,见下面。
 */
export function buildModelMenuGroups(input: ModelMenuInput): ModelMenuGroup[] {
  const favSet = new Set(
    input.favoriteModels.map((route) => favoriteRouteKey(route.provider, route.model)),
  )
  const byProvider = new Map<string, ModelInfo[]>()
  for (const model of input.models) {
    const list = byProvider.get(model.provider) ?? []
    list.push(model)
    byProvider.set(model.provider, list)
  }
  const anyFavorites = favSet.size > 0

  return [...byProvider.entries()]
    .map(([provider, list]): ModelMenuGroup => {
      // 外部 agent 不参与收藏过滤:那套是给 registry 里成百上千个模型防刷屏用的,
      // ACP 一共就十来个,按它过滤会让整组消失 —— 用户配过收藏就再也看不到
      // Claude Code 和 Codex。
      const isAcpGroup = isAcpModelRoute(provider)
      if (isAcpGroup) {
        return {
          type: 'group',
          label: ACP_PROVIDER_LABEL,
          provider,
          // registry 给的展示名(Codex / Claude Agent)比 id 好认
          children: list.map((model) => ({
            key: `${model.provider}::${model.id}`,
            label: model.name ?? model.id,
            info: model,
          })),
        }
      }

      const providerFavorites = list.filter((model) =>
        favSet.has(favoriteRouteKey(model.provider, model.id)),
      )
      let shown = anyFavorites
        ? providerFavorites
        : list.slice(-FALLBACK_PER_PROVIDER).reverse()
      // 当前在用的模型不在列表里也要能看见(否则不知道自己用的什么)
      if (anyFavorites && input.currentModel && input.currentModel.provider === provider) {
        const current = list.find((model) => model.id === input.currentModel!.id)
        if (current && !shown.includes(current)) shown = [current, ...shown]
      }
      return {
        type: 'group',
        label: input.providerLabels[provider] ?? provider,
        provider,
        children: shown.map((model) => ({
          key: `${model.provider}::${model.id}`,
          label: model.id,
          info: model,
        })),
      }
    })
    .filter((group) => group.children.length > 0)
}

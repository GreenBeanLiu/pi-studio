import type { ModelInfo } from '../shared/ipc/contract'
import { ACP_MODEL_PROVIDER, isAcpModelRoute } from '../shared/model-route'
import type { AcpRegistryAgent } from './acp-registry'
import { resolveAcpLaunchSpec, type AcpPlatformKey } from './acp-launch-spec'

/**
 * 把 ACP agent 投影成模型选择器里的条目。
 *
 * 外部 agent 在界面上就是「另一个模型」—— 这是 DeepChat 那边验证过的做法,
 * 用户不用学一个新概念,选择器里多一组就行。
 */

export { ACP_MODEL_PROVIDER, isAcpModelRoute } from '../shared/model-route'

/**
 * 选择器里只放这两个。
 *
 * registry 现在有 39 个 agent,其中能启动的也有二十多个 —— 全列出来,模型选择
 * 器里一组就比其余所有模型加起来还长,而绝大多数用户一个都不会点。要用别的走
 * 「自定义命令」手动接。
 */
export const ACP_ALLOWED_AGENT_IDS: readonly string[] = ['claude-acp', 'codex-acp']

/**
 * 只列真的能启动、且在白名单里的 agent。
 *
 * 二进制分发的 16 个(cursor、devin、goose、opencode……)本来就进不来:
 * 我们不自动下载安装(registry 里近一半二进制分发没有校验和),列出来只会让
 * 用户点了之后拿到一个失败。
 *
 * `allowedIds: null` 关掉白名单,只保留可启动性过滤 —— 单测用它单独验证那一层。
 */
export function acpModelEntries(
  agents: readonly AcpRegistryAgent[],
  options?: { platformKey?: AcpPlatformKey | null; allowedIds?: readonly string[] | null },
): ModelInfo[] {
  const allowed =
    options?.allowedIds === null
      ? null
      : new Set(options?.allowedIds ?? ACP_ALLOWED_AGENT_IDS)
  const entries: ModelInfo[] = []
  for (const agent of agents) {
    if (allowed && !allowed.has(agent.id)) continue
    const resolved = resolveAcpLaunchSpec(agent, options)
    if (!resolved.ok) continue
    entries.push({
      provider: ACP_MODEL_PROVIDER,
      id: agent.id,
      name: agent.name,
      // 外部 agent 自己管上下文,宿主既不知道窗口多大也不做预算。
      contextWindow: 0,
      // 推不推理是 agent 内部的事,宿主不声明。
      reasoning: false,
      api: resolved.spec.distribution,
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 合并 pi 的模型和 ACP agent。
 *
 * pi 的那份可能是缓存的:当前会话是 ACP 时没有 pi 进程可问,但用户仍然要能
 * 切回自己的模型,所以宁可给一份上次拿到的,也不能让 pi 那组整个消失。
 */
export function mergeModelEntries(
  piModels: readonly ModelInfo[],
  acpEntries: readonly ModelInfo[],
): ModelInfo[] {
  return [...piModels.filter((model) => !isAcpModelRoute(model.provider)), ...acpEntries]
}

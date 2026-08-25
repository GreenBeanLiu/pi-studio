import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../../../shared/ipc/contract'
import { ACP_PROVIDER_LABEL } from '../../../shared/model-route'
import { buildModelMenuGroups, type ModelMenuInput } from './model-menu'

function model(provider: string, id: string, name?: string): ModelInfo {
  return { provider, id, name, contextWindow: 0, reasoning: false }
}

function build(overrides: Partial<ModelMenuInput> = {}) {
  return buildModelMenuGroups({
    models: [],
    favoriteModels: [],
    providerLabels: {},
    currentModel: null,
    ...overrides,
  })
}

const CODEX = model('acp', 'codex-acp', 'Codex')
const CLAUDE = model('acp', 'claude-acp', 'Claude Agent')
const DS_CHAT = model('deepseek', 'deepseek-chat')
const DS_PRO = model('deepseek', 'deepseek-v4-pro')

describe('provider grouping', () => {
  it('groups by provider and uses the configured label', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO],
      providerLabels: { deepseek: 'DeepSeek 官方' },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ provider: 'deepseek', label: 'DeepSeek 官方' })
    expect(groups[0]?.children.map((c) => c.key)).toEqual([
      'deepseek::deepseek-v4-pro',
      'deepseek::deepseek-chat',
    ])
  })

  it('falls back to the provider id when there is no label', () => {
    expect(build({ models: [DS_CHAT] })[0]?.label).toBe('deepseek')
  })

  it('shows only the favourites once any are configured', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
    expect(groups[0]?.children.map((c) => c.info.id)).toEqual(['deepseek-chat'])
  })

  it('keeps the model in use visible even when it is not a favourite', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      currentModel: { provider: 'deepseek', id: 'deepseek-v4-pro' },
    })
    expect(groups[0]?.children.map((c) => c.info.id)).toEqual(['deepseek-v4-pro', 'deepseek-chat'])
  })

  it('drops a group that ends up empty', () => {
    const groups = build({
      models: [DS_CHAT, CODEX],
      favoriteModels: [{ provider: 'acp', model: 'codex-acp' }],
    })
    expect(groups.map((g) => g.provider)).toEqual(['acp'])
  })
})

// 收藏过滤是给 registry 里成百上千个模型防刷屏用的。ACP 一共十来个,
// 按它过滤会让整组消失 —— 用户配过收藏就再也看不到 Claude Code 和 Codex。
describe('the ACP group is exempt from favourite filtering', () => {
  it('stays fully visible when favourites are configured elsewhere', () => {
    const groups = build({
      models: [DS_CHAT, DS_PRO, CODEX, CLAUDE],
      favoriteModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
    const acp = groups.find((g) => g.provider === 'acp')
    expect(acp?.children.map((c) => c.info.id)).toEqual(['codex-acp', 'claude-acp'])
  })

  it('is not capped at the per-provider fallback limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => model('acp', `agent-${i}`, `Agent ${i}`))
    expect(build({ models: many })[0]?.children).toHaveLength(12)
  })

  it('gets its own label instead of the bare provider id', () => {
    expect(build({ models: [CODEX] })[0]?.label).toBe(ACP_PROVIDER_LABEL)
  })

  // id 是 codex-acp / claude-acp,registry 给的展示名才是 Codex / Claude Agent
  it('shows the registry display name, not the agent id', () => {
    expect(build({ models: [CODEX, CLAUDE] })[0]?.children.map((c) => c.label)).toEqual([
      'Codex',
      'Claude Agent',
    ])
  })

  it('falls back to the id when the registry gave no name', () => {
    expect(build({ models: [model('acp', 'nameless')] })[0]?.children[0]?.label).toBe('nameless')
  })

  it('still keys entries as provider::id so pickModel can parse them', () => {
    expect(build({ models: [CODEX] })[0]?.children[0]?.key).toBe('acp::codex-acp')
  })
})

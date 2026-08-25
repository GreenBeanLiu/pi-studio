import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../shared/ipc/contract'
import type { AcpRegistryAgent } from './acp-registry'
import { ACP_MODEL_PROVIDER, acpModelEntries, isAcpModelRoute, mergeModelEntries } from './acp-model-entries'

function agent(id: string, distribution: AcpRegistryAgent['distribution'], name = id): AcpRegistryAgent {
  return { id, name, version: '1.0.0', distribution }
}

const NPX = agent('codex-acp', { npx: { package: '@agentclientprotocol/codex-acp@1.6.2' } }, 'Codex')
const UVX = agent('fast-agent', { uvx: { package: 'fast-agent-acp==0.10.1' } }, 'fast-agent')
const BINARY = agent('opencode', {
  binary: { 'darwin-aarch64': { archive: 'https://e.test/o.zip', cmd: 'opencode' } },
})

const DARWIN = { platformKey: 'darwin-aarch64' as const }

describe('acpModelEntries', () => {
  it('projects a launchable agent into one selector entry', () => {
    expect(acpModelEntries([NPX], DARWIN)).toEqual([
      {
        provider: ACP_MODEL_PROVIDER,
        id: 'codex-acp',
        name: 'Codex',
        contextWindow: 0,
        reasoning: false,
        api: 'npx',
      },
    ])
  })

  // 我们不自动装二进制(registry 里近一半没有校验和),列出来只会让用户
  // 点了之后拿到一个失败。
  it('leaves out agents that cannot actually be started', () => {
    expect(acpModelEntries([NPX, BINARY, UVX], DARWIN).map((m) => m.id)).toEqual([
      'codex-acp',
      'fast-agent',
    ])
  })

  it('leaves out an agent with no build for this platform', () => {
    const linuxOnly = agent('devin', {
      binary: { 'linux-x86_64': { archive: 'u', cmd: 'c' } },
    })
    expect(acpModelEntries([linuxOnly], DARWIN)).toEqual([])
  })

  it('sorts by id so the group does not reshuffle between refreshes', () => {
    const ids = acpModelEntries([UVX, NPX, agent('auggie', { npx: { package: 'a' } })], DARWIN).map(
      (m) => m.id,
    )
    expect(ids).toEqual(['auggie', 'codex-acp', 'fast-agent'])
  })

  // 上下文窗口和推理深度都是外部 agent 内部的事,宿主不知道也不该编。
  it('does not invent a context window or a reasoning flag', () => {
    const [entry] = acpModelEntries([NPX], DARWIN)
    expect(entry?.contextWindow).toBe(0)
    expect(entry?.reasoning).toBe(false)
  })
})

describe('mergeModelEntries', () => {
  const piModel: ModelInfo = { provider: 'deepseek', id: 'deepseek-chat', contextWindow: 64000, reasoning: false }

  it('keeps pi models and appends the acp group', () => {
    const merged = mergeModelEntries([piModel], acpModelEntries([NPX], DARWIN))
    expect(merged.map((m) => `${m.provider}::${m.id}`)).toEqual([
      'deepseek::deepseek-chat',
      'acp::codex-acp',
    ])
  })

  // 上一份里如果混进了 acp 条目(缓存来的),要用新的那份替换掉,不能叠加。
  it('replaces any stale acp entries instead of duplicating them', () => {
    const stale: ModelInfo = { provider: 'acp', id: 'old-agent', contextWindow: 0, reasoning: false }
    const merged = mergeModelEntries([piModel, stale], acpModelEntries([NPX], DARWIN))
    expect(merged.filter((m) => isAcpModelRoute(m.provider)).map((m) => m.id)).toEqual(['codex-acp'])
  })

  it('still lists the acp group when there are no pi models at all', () => {
    expect(mergeModelEntries([], acpModelEntries([NPX], DARWIN))).toHaveLength(1)
  })
})

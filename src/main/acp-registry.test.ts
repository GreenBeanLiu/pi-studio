import { describe, expect, it, vi } from 'vitest'
import { AcpRegistry, parseAcpRegistry } from './acp-registry'

const CLAUDE = {
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.70.0',
  description: "ACP wrapper for Anthropic's Claude",
  license: 'proprietary',
  distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.70.0' } },
}

const CODEX = {
  id: 'codex-acp',
  name: 'Codex',
  version: '1.6.2',
  license: 'Apache-2.0',
  distribution: { npx: { package: '@agentclientprotocol/codex-acp@1.6.2' } },
}

const OPENCODE = {
  id: 'opencode',
  name: 'opencode',
  version: '1.18.22',
  distribution: {
    binary: {
      'darwin-aarch64': { archive: 'https://example.test/opencode.zip', cmd: 'opencode' },
    },
  },
}

function registry(...agents: unknown[]): unknown {
  return { version: '1.0.0', agents, extensions: [] }
}

describe('parseAcpRegistry', () => {
  it('reads the distributions the launcher understands', () => {
    const agents = parseAcpRegistry(registry(CLAUDE, CODEX, OPENCODE))
    expect(agents.map((agent) => agent.id)).toEqual(['claude-acp', 'codex-acp', 'opencode'])
    expect(agents[0]?.distribution.npx?.package).toBe(
      '@agentclientprotocol/claude-agent-acp@0.70.0',
    )
    expect(agents[2]?.distribution.binary?.['darwin-aarch64']?.cmd).toBe('opencode')
  })

  // 目录是远端来的:一条坏了不该把整张列表带走,否则一次上游手滑就等于所有外部
  // agent 从选择器里消失。
  it('skips malformed entries instead of failing the whole list', () => {
    const agents = parseAcpRegistry(
      registry(
        CLAUDE,
        { id: 'no-name', version: '1.0.0', distribution: { npx: { package: 'x' } } },
        { id: 'no-distribution', name: 'X', version: '1.0.0', distribution: {} },
        { id: 'binary-without-cmd', name: 'Y', version: '1', distribution: { binary: { 'linux-x86_64': { archive: 'u' } } } },
        CODEX,
      ),
    )
    expect(agents.map((agent) => agent.id)).toEqual(['claude-acp', 'codex-acp'])
  })

  it('survives a payload that is not a registry at all', () => {
    expect(parseAcpRegistry(null)).toEqual([])
    expect(parseAcpRegistry({ agents: 'nope' })).toEqual([])
    expect(parseAcpRegistry([CLAUDE])).toEqual([])
  })
})

describe('AcpRegistry caching', () => {
  it('serves from cache inside the TTL and refetches after it', async () => {
    const fetchRegistry = vi.fn(async () => registry(CLAUDE))
    let clock = 1_000
    const acp = new AcpRegistry({ fetchRegistry, now: () => clock, ttlMs: 1_000 })

    await acp.load()
    await acp.load()
    expect(fetchRegistry).toHaveBeenCalledTimes(1)

    clock += 1_001
    await acp.load()
    expect(fetchRegistry).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent callers', async () => {
    const fetchRegistry = vi.fn(async () => registry(CLAUDE))
    const acp = new AcpRegistry({ fetchRegistry, now: () => 0 })
    const [a, b, c] = await Promise.all([acp.load(), acp.load(), acp.load()])
    expect(fetchRegistry).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  // 离线时宁可列一份过期目录,也好过整个外部 agent 入口消失。
  it('keeps serving the previous list when a refetch fails', async () => {
    let fail = false
    const fetchRegistry = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return registry(CLAUDE)
    })
    let clock = 0
    const acp = new AcpRegistry({ fetchRegistry, now: () => clock, ttlMs: 10 })
    await acp.load()
    fail = true
    clock += 100
    await expect(acp.load()).resolves.toHaveLength(1)
  })

  it('falls back to the bundled copy on a cold failure', async () => {
    const acp = new AcpRegistry({
      fetchRegistry: async () => {
        throw new Error('offline')
      },
      now: () => 0,
      readFallback: () => registry(CODEX),
    })
    await expect(acp.load()).resolves.toEqual([expect.objectContaining({ id: 'codex-acp' })])
  })

  it('throws when there is neither a network answer nor a fallback', async () => {
    const acp = new AcpRegistry({
      fetchRegistry: async () => {
        throw new Error('offline')
      },
      now: () => 0,
    })
    await expect(acp.load()).rejects.toThrow('offline')
  })

  // 兜底副本不算"拉到过":下一次调用还要再试网络,否则一次离线启动会让目录
  // 在整个 TTL 内都停在旧版本上。
  it('retries the network after serving a fallback', async () => {
    const fetchRegistry = vi.fn(async () => {
      throw new Error('offline')
    })
    const acp = new AcpRegistry({
      fetchRegistry,
      now: () => 0,
      ttlMs: 60_000,
      readFallback: () => registry(CODEX),
    })
    await acp.load()
    await acp.load()
    expect(fetchRegistry).toHaveBeenCalledTimes(2)
  })
})

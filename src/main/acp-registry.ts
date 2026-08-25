/**
 * ACP(Agent Client Protocol)官方 agent 目录。
 *
 * 不硬编码 agent 列表:Claude Code、Codex、Gemini、Copilot 这些都在官方 registry 里,
 * 各自声明自己的分发方式。一个 JSON 拉下来就能把它们列进模型选择器。
 */

export const ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

/** 目录一小时之内不重复拉。 */
export const ACP_REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000

export type AcpPackageDistribution = {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export type AcpBinaryDistribution = {
  archive: string
  cmd: string
  /** registry 里有将近一半的二进制分发没有校验和,见 acp-launch-spec 的说明。 */
  sha256?: string
  args?: string[]
  env?: Record<string, string>
}

export type AcpDistribution = {
  npx?: AcpPackageDistribution
  uvx?: AcpPackageDistribution
  /** key 是 `${platform}-${arch}`,例如 darwin-aarch64。 */
  binary?: Record<string, AcpBinaryDistribution>
}

export type AcpRegistryAgent = {
  id: string
  name: string
  version: string
  description?: string
  repository?: string
  license?: string
  icon?: string
  distribution: AcpDistribution
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length ? items : undefined
}

function asEnv(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') env[key] = item
  }
  return Object.keys(env).length ? env : undefined
}

function parsePackage(value: unknown): AcpPackageDistribution | undefined {
  const record = asRecord(value)
  const pkg = asString(record?.package)
  if (!pkg) return undefined
  return { package: pkg, args: asStringArray(record?.args), env: asEnv(record?.env) }
}

function parseBinary(value: unknown): Record<string, AcpBinaryDistribution> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const binary: Record<string, AcpBinaryDistribution> = {}
  for (const [platformKey, raw] of Object.entries(record)) {
    const entry = asRecord(raw)
    const archive = asString(entry?.archive)
    const cmd = asString(entry?.cmd)
    if (!archive || !cmd) continue
    binary[platformKey] = {
      archive,
      cmd,
      sha256: asString(entry?.sha256),
      args: asStringArray(entry?.args),
      env: asEnv(entry?.env),
    }
  }
  return Object.keys(binary).length ? binary : undefined
}

/**
 * 把 registry.json 解析成 agent 列表。跳过任何一条都不影响其余的 ——
 * 目录是远端来的,一条格式变了不该让整个列表消失。
 */
export function parseAcpRegistry(raw: unknown): AcpRegistryAgent[] {
  const root = asRecord(raw)
  const agents = Array.isArray(root?.agents) ? root.agents : []
  const parsed: AcpRegistryAgent[] = []
  for (const item of agents) {
    const record = asRecord(item)
    const id = asString(record?.id)
    const name = asString(record?.name)
    const version = asString(record?.version)
    if (!id || !name || !version) continue
    const distributionRecord = asRecord(record?.distribution)
    const distribution: AcpDistribution = {
      npx: parsePackage(distributionRecord?.npx),
      uvx: parsePackage(distributionRecord?.uvx),
      binary: parseBinary(distributionRecord?.binary),
    }
    if (!distribution.npx && !distribution.uvx && !distribution.binary) continue
    parsed.push({
      id,
      name,
      version,
      description: asString(record?.description),
      repository: asString(record?.repository),
      license: asString(record?.license),
      icon: asString(record?.icon),
      distribution,
    })
  }
  return parsed
}

export type AcpRegistryDependencies = {
  fetchRegistry: () => Promise<unknown>
  now: () => number
  /** 拉不到时的兜底(读打包内或上次落盘的副本);没有就返回 null。 */
  readFallback?: () => unknown | null
  writeCache?: (raw: unknown) => void
  ttlMs?: number
}

export function defaultAcpRegistryDependencies(): AcpRegistryDependencies {
  return {
    fetchRegistry: async () => {
      const response = await fetch(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) {
        throw new Error(`ACP registry responded ${response.status} ${response.statusText}`)
      }
      return response.json()
    },
    now: () => Date.now(),
  }
}

/**
 * 带 TTL 的目录缓存。拉失败时优先用内存里的旧副本,再退到 readFallback ——
 * 离线时宁可列一份过期的 agent 目录,也好过整个入口消失。
 */
export class AcpRegistry {
  private agents: AcpRegistryAgent[] | null = null
  /** null = 还没有从网络成功拿到过(兜底副本不算),下次调用要重试。 */
  private fetchedAt: number | null = null
  private inflight: Promise<AcpRegistryAgent[]> | null = null

  constructor(private readonly deps: AcpRegistryDependencies = defaultAcpRegistryDependencies()) {}

  /** 已经在手上的目录,不触发网络。 */
  cached(): AcpRegistryAgent[] | null {
    return this.agents
  }

  async load(options?: { force?: boolean }): Promise<AcpRegistryAgent[]> {
    const ttl = this.deps.ttlMs ?? ACP_REGISTRY_CACHE_TTL_MS
    const fresh =
      this.agents !== null && this.fetchedAt !== null && this.deps.now() - this.fetchedAt < ttl
    if (!options?.force && fresh) return this.agents!
    // 并发调用共享同一次请求,避免开三个窗口就拉三遍。
    this.inflight ??= this.fetchOnce().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetchOnce(): Promise<AcpRegistryAgent[]> {
    try {
      const raw = await this.deps.fetchRegistry()
      const agents = parseAcpRegistry(raw)
      if (agents.length === 0) throw new Error('ACP registry contained no usable agents')
      this.agents = agents
      this.fetchedAt = this.deps.now()
      this.deps.writeCache?.(raw)
      return agents
    } catch (error) {
      if (this.agents) return this.agents
      const fallback = this.deps.readFallback?.()
      if (fallback != null) {
        const agents = parseAcpRegistry(fallback)
        if (agents.length > 0) {
          this.agents = agents
          // fetchedAt 保持 null:兜底副本不算拉到过,下次调用还会再试一次网络。
          return agents
        }
      }
      throw error
    }
  }

  find(agentId: string): AcpRegistryAgent | undefined {
    return this.agents?.find((agent) => agent.id === agentId)
  }
}

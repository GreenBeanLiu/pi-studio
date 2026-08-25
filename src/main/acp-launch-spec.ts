import type { AcpBinaryDistribution, AcpRegistryAgent } from './acp-registry'

/**
 * 把 registry 里的一条 agent 解析成能直接 spawn 的命令。
 *
 * 只支持 npx / uvx 两种包分发 —— 这两种覆盖了 registry 里 39 个 agent 中的 23 个,
 * 包含 Claude Code(claude-acp)、Codex(codex-acp)、Gemini、Copilot、Qwen 和 pi-acp。
 *
 * 二进制分发**故意不自动安装**,只报告到哪儿去拿。原因是实测 registry 的 95 条
 * 二进制分发里只有 48 条带 sha256 —— 另外 47 条是没有校验和的可执行文件 URL,
 * 自动下载执行等于给自己开一条无校验的供应链入口。要支持的话得先解决两件事:
 * 校验和缺失时的信任策略,以及 .zip 的解压(Linux 的 GNU tar 不认 zip,得引依赖)。
 */

export type AcpPlatform = 'darwin' | 'linux' | 'windows'
export type AcpArch = 'aarch64' | 'x86_64'
export type AcpPlatformKey = `${AcpPlatform}-${AcpArch}`

const PLATFORMS: Record<string, AcpPlatform> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
}

const ARCHS: Record<string, AcpArch> = {
  arm64: 'aarch64',
  x64: 'x86_64',
}

/** registry 的平台 key,例如 darwin-aarch64。认不出的平台返回 null。 */
export function acpPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): AcpPlatformKey | null {
  const os = PLATFORMS[platform]
  const cpu = ARCHS[arch]
  return os && cpu ? `${os}-${cpu}` : null
}

export type AcpLaunchSpec = {
  agentId: string
  source: 'registry' | 'manual'
  distribution: 'npx' | 'uvx' | 'manual'
  version?: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type AcpLaunchUnavailable =
  | {
      agentId: string
      reason: 'unsupported-platform'
      message: string
    }
  | {
      agentId: string
      reason: 'no-distribution'
      message: string
    }
  | {
      agentId: string
      reason: 'binary-not-supported'
      message: string
      platformKey: AcpPlatformKey
      archive: string
      /** 没有校验和的分发要在界面上说清楚,别让用户以为下下来是验过的。 */
      checksum: string | null
    }

export type AcpLaunchResolution = { ok: true; spec: AcpLaunchSpec } | { ok: false; error: AcpLaunchUnavailable }

function packageArgs(kind: 'npx' | 'uvx', pkg: string, extra: readonly string[] = []): string[] {
  // npx 要 -y 才不会在没装过包时停下来问;uvx 直接吃包名。
  return kind === 'npx' ? ['-y', pkg, ...extra] : [pkg, ...extra]
}

/**
 * 分发选择顺序:先看当前平台有没有二进制(有就明确报"暂不支持"而不是悄悄降级),
 * 再 npx,最后 uvx。这样用户看到的是真实原因,不是一个跑不起来的命令。
 */
export function resolveAcpLaunchSpec(
  agent: AcpRegistryAgent,
  options?: { platformKey?: AcpPlatformKey | null },
): AcpLaunchResolution {
  const { npx, uvx, binary } = agent.distribution
  if (npx) {
    return {
      ok: true,
      spec: {
        agentId: agent.id,
        source: 'registry',
        distribution: 'npx',
        version: agent.version,
        command: 'npx',
        args: packageArgs('npx', npx.package, npx.args),
        env: { ...npx.env },
      },
    }
  }
  if (uvx) {
    return {
      ok: true,
      spec: {
        agentId: agent.id,
        source: 'registry',
        distribution: 'uvx',
        version: agent.version,
        command: 'uvx',
        args: packageArgs('uvx', uvx.package, uvx.args),
        env: { ...uvx.env },
      },
    }
  }
  if (!binary) {
    return {
      ok: false,
      error: {
        agentId: agent.id,
        reason: 'no-distribution',
        message: `${agent.name} 没有声明任何可用的分发方式。`,
      },
    }
  }

  const platformKey = options?.platformKey === undefined ? acpPlatformKey() : options.platformKey
  if (!platformKey) {
    return {
      ok: false,
      error: {
        agentId: agent.id,
        reason: 'unsupported-platform',
        message: `认不出当前平台(${process.platform}/${process.arch}),无法为 ${agent.name} 选择分发。`,
      },
    }
  }
  const entry: AcpBinaryDistribution | undefined = binary[platformKey]
  if (!entry) {
    return {
      ok: false,
      error: {
        agentId: agent.id,
        reason: 'unsupported-platform',
        message: `${agent.name} 没有提供 ${platformKey} 的构建。`,
      },
    }
  }
  return {
    ok: false,
    error: {
      agentId: agent.id,
      reason: 'binary-not-supported',
      message: `${agent.name} 只提供二进制分发,暂不支持自动安装,请手动安装后按「自定义命令」接入。`,
      platformKey,
      archive: entry.archive,
      checksum: entry.sha256 ?? null,
    },
  }
}

export type AcpManualAgent = {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** 用户自己填的命令。不做校验 —— 那是他自己机器上的可执行文件。 */
export function resolveManualAcpLaunchSpec(agent: AcpManualAgent): AcpLaunchSpec {
  return {
    agentId: agent.id,
    source: 'manual',
    distribution: 'manual',
    command: agent.command,
    args: [...(agent.args ?? [])],
    env: { ...agent.env },
  }
}

/** 界面上展示用的一行命令预览。 */
export function describeAcpLaunchSpec(spec: AcpLaunchSpec): string {
  return [spec.command, ...spec.args].join(' ')
}

import { describe, expect, it } from 'vitest'
import type { AcpRegistryAgent } from './acp-registry'
import {
  acpPlatformKey,
  describeAcpLaunchSpec,
  resolveAcpLaunchSpec,
  resolveManualAcpLaunchSpec,
} from './acp-launch-spec'

function agent(overrides: Partial<AcpRegistryAgent>): AcpRegistryAgent {
  return {
    id: 'x',
    name: 'X',
    version: '1.0.0',
    distribution: {},
    ...overrides,
  }
}

describe('acpPlatformKey', () => {
  it('maps node platform/arch onto the registry keys', () => {
    expect(acpPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(acpPlatformKey('darwin', 'x64')).toBe('darwin-x86_64')
    expect(acpPlatformKey('linux', 'x64')).toBe('linux-x86_64')
    expect(acpPlatformKey('win32', 'arm64')).toBe('windows-aarch64')
  })

  it('returns null for a platform the registry has no key for', () => {
    expect(acpPlatformKey('freebsd', 'x64')).toBeNull()
    expect(acpPlatformKey('linux', 'ppc64')).toBeNull()
  })
})

describe('resolveAcpLaunchSpec', () => {
  // npx 不加 -y 会在没装过包时停下来问 —— stdio 上没人回答,握手直接挂死。
  it('launches an npx agent non-interactively', () => {
    const result = resolveAcpLaunchSpec(
      agent({
        id: 'codex-acp',
        name: 'Codex',
        distribution: { npx: { package: '@agentclientprotocol/codex-acp@1.6.2' } },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.command).toBe('npx')
    expect(result.spec.args).toEqual(['-y', '@agentclientprotocol/codex-acp@1.6.2'])
    expect(describeAcpLaunchSpec(result.spec)).toBe(
      'npx -y @agentclientprotocol/codex-acp@1.6.2',
    )
  })

  it('passes registry args and env through', () => {
    const result = resolveAcpLaunchSpec(
      agent({ distribution: { npx: { package: 'p', args: ['--acp'], env: { A: '1' } } } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.args).toEqual(['-y', 'p', '--acp'])
    expect(result.spec.env).toEqual({ A: '1' })
  })

  it('launches a uvx agent without the -y flag', () => {
    const result = resolveAcpLaunchSpec(
      agent({ distribution: { uvx: { package: 'fast-agent-acp==0.10.1' } } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.command).toBe('uvx')
    expect(result.spec.args).toEqual(['fast-agent-acp==0.10.1'])
  })

  it('prefers npx when an agent ships both npx and a binary', () => {
    const result = resolveAcpLaunchSpec(
      agent({
        distribution: {
          npx: { package: '@kilocode/cli@7.4.23' },
          binary: { 'darwin-aarch64': { archive: 'https://e.test/k.zip', cmd: 'kilo' } },
        },
      }),
      { platformKey: 'darwin-aarch64' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.distribution).toBe('npx')
  })

  // 二进制分发故意不自动装:registry 里 95 条二进制分发只有 48 条带 sha256。
  // 报告要带上校验和有没有,界面才能如实说明,而不是让用户以为下下来是验过的。
  it('reports a binary-only agent as unsupported and surfaces the missing checksum', () => {
    const result = resolveAcpLaunchSpec(
      agent({
        id: 'opencode',
        name: 'opencode',
        distribution: {
          binary: { 'darwin-aarch64': { archive: 'https://e.test/opencode.zip', cmd: 'opencode' } },
        },
      }),
      { platformKey: 'darwin-aarch64' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.reason).toBe('binary-not-supported')
    if (result.error.reason !== 'binary-not-supported') return
    expect(result.error.archive).toBe('https://e.test/opencode.zip')
    expect(result.error.checksum).toBeNull()
  })

  it('keeps a checksum when the registry provides one', () => {
    const result = resolveAcpLaunchSpec(
      agent({
        distribution: {
          binary: { 'linux-x86_64': { archive: 'https://e.test/a.tar.gz', cmd: 'a', sha256: 'ab'.repeat(32) } },
        },
      }),
      { platformKey: 'linux-x86_64' },
    )
    expect(result.ok).toBe(false)
    if (result.ok || result.error.reason !== 'binary-not-supported') return
    expect(result.error.checksum).toBe('ab'.repeat(32))
  })

  it('says so when the agent has no build for this platform', () => {
    const result = resolveAcpLaunchSpec(
      agent({
        name: 'Devin',
        distribution: { binary: { 'linux-x86_64': { archive: 'u', cmd: 'c' } } },
      }),
      { platformKey: 'darwin-aarch64' },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.reason).toBe('unsupported-platform')
    expect(result.error.message).toContain('darwin-aarch64')
  })

  it('says so when the platform itself is unknown', () => {
    const result = resolveAcpLaunchSpec(
      agent({ distribution: { binary: { 'linux-x86_64': { archive: 'u', cmd: 'c' } } } }),
      { platformKey: null },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.reason).toBe('unsupported-platform')
  })

  it('reports an agent that declares no distribution at all', () => {
    const result = resolveAcpLaunchSpec(agent({ distribution: {} }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.reason).toBe('no-distribution')
  })
})

describe('resolveManualAcpLaunchSpec', () => {
  it('takes the user command verbatim', () => {
    const spec = resolveManualAcpLaunchSpec({
      id: 'mine',
      name: 'Mine',
      command: '/opt/bin/my-acp',
      args: ['--stdio'],
      env: { TOKEN: 'x' },
    })
    expect(describeAcpLaunchSpec(spec)).toBe('/opt/bin/my-acp --stdio')
    expect(spec.source).toBe('manual')
    expect(spec.env).toEqual({ TOKEN: 'x' })
  })

  it('copies args so later edits cannot mutate a resolved spec', () => {
    const args = ['--stdio']
    const spec = resolveManualAcpLaunchSpec({ id: 'm', name: 'M', command: 'c', args })
    args.push('--leaked')
    expect(spec.args).toEqual(['--stdio'])
  })
})

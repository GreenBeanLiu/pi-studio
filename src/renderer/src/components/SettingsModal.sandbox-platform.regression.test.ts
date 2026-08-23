import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsModal = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')

// 2026-08-23: mac 上的沙箱设置页照抄了 Windows 文案 —— 承诺「整盘只读 + 域名白名单
// 代理」,但那套是 WSL/bwrap 专属(sandbox-wsl.ts)。非 Windows 只能走 Docker 回退,
// buildSandboxDockerArgs 里一个网络参数都没有,容器拿默认网络,出站完全不受限。
describe('sandbox settings copy must match the platform', () => {
  it('branches on the platform instead of hardcoding the WSL story', () => {
    expect(settingsModal).toContain("const sandboxOnWsl = api.platform === 'win32'")
  })

  it('never promises the allowlist proxy off the WSL path', () => {
    const promise = '网络收敛到主机侧域名白名单代理'
    expect(settingsModal).toContain(promise)
    // 这句话只能出现在 sandboxOnWsl 为真的那个分支里
    const idx = settingsModal.indexOf(promise)
    const branch = settingsModal.lastIndexOf('sandboxOnWsl', idx)
    expect(branch).toBeGreaterThan(-1)
    expect(settingsModal.slice(branch, idx)).not.toContain('</')
  })

  it('says out loud that the Docker fallback has no network confinement', () => {
    expect(settingsModal).toContain('没有域名白名单代理')
    expect(settingsModal).toContain('出站不受限')
  })

  it('hides the WSL distro row and prep hint on other platforms', () => {
    expect(settingsModal).toContain('{sandboxOnWsl && (')
    expect(settingsModal).toContain('{sandboxOnWsl && sandboxDetect && !sandboxDetect.wslSandboxReady && (')
  })

  it('stops calling Docker a fallback where it is the only path', () => {
    expect(settingsModal).toContain("const sandboxFallbackWord = sandboxOnWsl ? '(回退)' : ''")
    expect(settingsModal).not.toContain('回退镜像未构建')
  })
})

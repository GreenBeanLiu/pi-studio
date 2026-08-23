import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sandboxAgentPath } from './sandbox'

const piClient = readFileSync(new URL('./pi-client.ts', import.meta.url), 'utf8')

// 2026-08-24: seatbelt 沙箱下每次恢复会话都 warn:
//   EPERM: operation not permitted, mkdir '/agent/sessions/--Users-glanger-Works--'
// /agent 是 Docker 容器里的挂载点,seatbelt 用的是宿主真实路径。
// 根因是 switchSession 直接调了 sandboxSessionPathToContainer,绕过了 mode 判断。
describe('agent paths must follow the sandbox mode', () => {
  const host = '/Users/me/Library/Application Support/pi-studio/pi-agent/sessions/x.jsonl'
  const agentDir = '/Users/me/Library/Application Support/pi-studio/pi-agent'

  it('leaves the path alone under seatbelt — same filesystem', () => {
    expect(sandboxAgentPath(host, 'seatbelt', agentDir)).toBe(host)
  })

  it('maps into the container only for docker', () => {
    expect(sandboxAgentPath(host, 'docker', agentDir)).toBe('/agent/sessions/x.jsonl')
  })

  it('restores sessions through the mode-aware helper', () => {
    const start = piClient.indexOf('await client.switchSession(')
    expect(start).toBeGreaterThan(-1)
    const body = piClient.slice(start, start + 260)
    expect(body).toContain('sandboxAgentPath(restoreSessionFile, launch.sandboxMode)')
  })

  it('never calls the docker-only mapper straight from pi-client', () => {
    // 它硬编码 /agent,对 seatbelt 和 wsl 都是错的
    expect(piClient).not.toContain('sandboxSessionPathToContainer(')
  })
})

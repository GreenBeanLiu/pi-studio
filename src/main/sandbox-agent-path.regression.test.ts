import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sandboxAgentPath } from './sandbox'

// 恢复会话的 switchSession 现在归进程层(pi-agent-pool)。负向断言扫整个 agent 层 ——
// 只盯一个文件的话,代码一搬断言就静默变成永真。
const AGENT_LAYER_FILES = ['pi-client.ts', 'pi-agent-pool.ts', 'pi-event-projection.ts'] as const
const agentPool = readFileSync(new URL('./pi-agent-pool.ts', import.meta.url), 'utf8')
const agentLayer = AGENT_LAYER_FILES.map((name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'),
).join('\n')

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
    const start = agentPool.indexOf('await client.switchSession(')
    expect(start).toBeGreaterThan(-1)
    const body = agentPool.slice(start, start + 260)
    expect(body).toContain('sandboxAgentPath(restoreSessionFile, launch.sandboxMode)')
  })

  it('never calls the docker-only mapper straight from the agent layer', () => {
    // 它硬编码 /agent,对 seatbelt 和 wsl 都是错的
    expect(agentLayer).not.toContain('sandboxSessionPathToContainer(')
  })
})

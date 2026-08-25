/**
 * 真机端到端:用真实的 codex-acp 跑通 registry 解析 → 启动 → 握手 → 一轮 prompt,
 * 并检查投影出来的 pi 事件流是完整的。
 *
 * 故意不叫 *.test.ts —— 它要联网、要 spawn npx、还要烧真实的 Codex 账号额度,
 * 不能进默认测试。要跑的话:
 *
 *   cp src/main/acp-e2e.manual.ts src/main/acp-e2e.tmp.test.ts \
 *     && npx vitest run src/main/acp-e2e.tmp.test.ts; rm -f src/main/acp-e2e.tmp.test.ts
 *
 * 2026-08-25 实测通过,投影骨架:
 *   agent_start → turn_start → message_start → tool_execution_start
 *   → tool_execution_end → message_end → turn_end → agent_end → agent_settled
 *
 * 同日 session/load 恢复也实测通过:第一个连接让它记住 4271,dispose 掉进程,
 * 新连接 resume 之后历史回放正确,追问仍答出 4271 —— agent 那边的上下文确实还在。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpConnection } from './acp-connection'
import { resolveAcpLaunchSpec, describeAcpLaunchSpec } from './acp-launch-spec'
import { parseAcpRegistry } from './acp-registry'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { PiRuntimeEvent } from '../shared/ipc/contract'

describe('real codex-acp through the connection layer', () => {
  it('produces a well-formed pi turn', { timeout: 180_000 }, async () => {
    const raw = await fetch('https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json').then((r) => r.json())
    const agent = parseAcpRegistry(raw).find((a) => a.id === 'codex-acp')!
    const resolved = resolveAcpLaunchSpec(agent, { platformKey: 'darwin-aarch64' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    console.log('启动:', describeAcpLaunchSpec(resolved.spec))

    const cwd = mkdtempSync(join(tmpdir(), 'acp-e2e-'))
    writeFileSync(join(cwd, 'hello.txt'), 'pi-studio ACP 端到端测试。\n')

    const events: PiRuntimeEvent[] = []
    const conn = await AcpConnection.spawnAndOpen(resolved.spec, cwd, { agentId: 'codex-acp' })
    conn.onEvent((e) => events.push(e))
    console.log('握手 OK  sessionId=', conn.sessionId, ' agent=', JSON.stringify(conn.agentInfo))
    console.log('capabilities =', JSON.stringify(conn.capabilities.features))
    console.log('modes  =', JSON.stringify(conn.modes?.availableModes?.map((m) => m.id)))

    await conn.prompt('用一句话说明 hello.txt 写了什么。不要修改任何文件。')
    await conn.dispose()

    const skeleton = events.map((e) => e.type).filter((t) => t !== 'message_update')
    console.log('\n投影出的 pi 事件骨架:'); console.log('  ' + skeleton.join(' → '))
    const end = events.find((e) => e.type === 'turn_end')!
    if (end.type === 'turn_end') {
      const message = end.message as AssistantMessage
      console.log('\n最终 message.content:')
      for (const b of message.content) {
        const preview = b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : `${b.name}(${JSON.stringify(b.arguments).slice(0,60)})`
        console.log(`  [${b.type}] ${String(preview).replace(/\n/g,' ').slice(0, 110)}`)
      }
      console.log('  usage.totalTokens =', message.usage.totalTokens, ' stopReason =', message.stopReason)
    }
    console.log(`\nmessage_update 共 ${events.filter((e) => e.type === 'message_update').length} 条`)

    expect(skeleton[0]).toBe('agent_start')
    expect(skeleton.at(-1)).toBe('agent_settled')
    expect(events.some((e) => e.type === 'run_failed')).toBe(false)
    const starts = events.filter((e) => e.type === 'tool_execution_start').length
    const ends = events.filter((e) => e.type === 'tool_execution_end').length
    expect(starts).toBe(ends)
  })
})

describe('real codex-acp session/load', () => {
  it('replays a conversation into a fresh connection', { timeout: 240_000 }, async () => {
    const raw = await fetch(
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ).then((r) => r.json())
    const agent = parseAcpRegistry(raw).find((a) => a.id === 'codex-acp')!
    const resolved = resolveAcpLaunchSpec(agent, { platformKey: 'darwin-aarch64' })
    if (!resolved.ok) throw new Error('unresolvable')

    const cwd = mkdtempSync(join(tmpdir(), 'acp-resume-'))
    writeFileSync(join(cwd, 'hello.txt'), 'ACP 恢复测试的内容。\n')

    // ① 起一个会话,给它一个只有它知道的事实
    const first = await AcpConnection.spawnAndOpen(resolved.spec, cwd, { agentId: 'codex-acp' })
    const sessionId = first.sessionId
    await first.prompt('记住一个数字:4271。只回复"好"。')
    console.log('① 对话记录:', first.conversation().map((m) => (m as { role: string }).role).join(' → '))
    await first.dispose()

    // ② 全新连接 + session/load
    const second = await AcpConnection.spawnAndOpen(resolved.spec, cwd, {
      agentId: 'codex-acp',
      resumeSessionId: sessionId,
    })
    const after = second.conversation()
    console.log('② 恢复出的记录:', after.map((m) => (m as { role: string }).role).join(' → '))
    expect(after.length).toBeGreaterThan(0)

    // ③ 上下文真的还在吗
    await second.prompt('我刚让你记的数字是多少?只回数字。')
    const last = second.conversation().at(-1) as { content: Array<{ type: string; text?: string }> }
    const answer = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    console.log('③ 追问答案:', answer.replace(/\n/g, ' ').slice(0, 80))
    await second.dispose()
    expect(answer).toContain('4271')
  })
})

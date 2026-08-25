import { describe, expect, it, vi } from 'vitest'
import { agent as createAgent, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import { AcpConnection, AcpAuthRequiredError } from './acp-connection'
import type { AcpPermissionOutcome, AcpRequestPermissionParams } from './acp-permission-bridge'

/**
 * 进程内的假 ACP agent。SDK 的 app 可以直接对接(内存流对),于是整条链路
 * ——握手、会话、prompt、session/update、权限回调、取消——都能不 spawn 进程地跑。
 */
type PromptResult = { stopReason: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' }

type FakeAgentOptions = {
  onPrompt?: (ctx: {
    client: { notify: (m: string, p: unknown) => unknown; request: (m: string, p: unknown) => Promise<unknown> }
    sessionId: string
  }) => Promise<PromptResult | void>
  failNewSession?: { message: string; data?: unknown }
  /** AuthMethodAgent 的结构:SDK 的具名类型没从入口导出,按 schema 写。 */
  authMethods?: Array<{ id: string; name: string; description?: string }>
}

function fakeAgent(options: FakeAgentOptions = {}) {
  const cancelled: string[] = []
  const app = createAgent({ name: 'fake-acp' })
    .onRequest('initialize', async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'fake-acp', title: 'Fake', version: '9.9.9' },
      authMethods: options.authMethods ?? [],
    }))
    .onRequest('session/new', async () => {
      if (options.failNewSession) {
        // 真 agent 发的是带 data 的 JSON-RPC 错误(pi-acp 实测 -32000 + data.authMethods);
        // 抛普通 Error 会被压成 "Internal error" 并丢掉 data。
        throw options.failNewSession.data
          ? RequestError.authRequired(options.failNewSession.data, options.failNewSession.message)
          : new RequestError(-32603, options.failNewSession.message)
      }
      return {
        sessionId: 'sess-1',
        modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
      }
    })
    .onRequest('session/prompt', async (ctx) => {
      const result = await options.onPrompt?.({
        client: ctx.client as never,
        sessionId: 'sess-1',
      })
      return result ?? { stopReason: 'end_turn' as const }
    })
    .onNotification('session/cancel', async () => {
      cancelled.push('sess-1')
    })
  return { app, cancelled }
}

async function connect(
  options: FakeAgentOptions & {
    requestPermission?: (params: AcpRequestPermissionParams) => Promise<AcpPermissionOutcome>
  } = {},
) {
  const events: PiRuntimeEvent[] = []
  const { app, cancelled } = fakeAgent(options)
  let clock = 0
  const connection = await AcpConnection.open(app, '/tmp/workspace', {
    agentId: 'fake-acp',
    emit: (event) => events.push(event),
    requestPermission:
      options.requestPermission ?? (async () => ({ outcome: 'cancelled' }) as AcpPermissionOutcome),
    now: () => ++clock,
  })
  return { connection, events, cancelled }
}

function types(events: readonly PiRuntimeEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('handshake', () => {
  it('initializes, opens a session and keeps what the agent told us', async () => {
    const { connection } = await connect()
    expect(connection.sessionId).toBe('sess-1')
    expect(connection.agentInfo?.title).toBe('Fake')
    expect(connection.modes?.currentModeId).toBe('agent')
    await connection.dispose()
  })

  // agent 起来了但没登录:pi-acp 实测就是 -32000 + data.authMethods。
  // 这要能和「agent 挂了」区分开,否则界面只会说一句连接失败。
  it('raises a typed auth error when session/new needs a login', async () => {
    const authMethods = [{ id: 'pi_terminal_login', name: 'Launch pi in the terminal', type: 'terminal' }]
    await expect(
      connect({
        failNewSession: { message: 'Authentication required', data: { authMethods } },
      }),
    ).rejects.toBeInstanceOf(AcpAuthRequiredError)
  })

  it('carries the login methods on the auth error', async () => {
    const authMethods = [{ id: 'chat-gpt', name: 'ChatGPT' }]
    const error = await connect({
      failNewSession: { message: 'Authentication required', data: { authMethods } },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcpAuthRequiredError)
    expect((error as AcpAuthRequiredError).authMethods).toEqual(authMethods)
  })

  // 有的 agent 把登录方式只放在 initialize 的 authMethods 里,session/new 的错误里没有。
  it('falls back to the login methods advertised at initialize', async () => {
    const error = await connect({
      authMethods: [{ id: 'chat-gpt', name: 'ChatGPT' }],
      failNewSession: { message: 'not logged in' },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcpAuthRequiredError)
    expect((error as AcpAuthRequiredError).authMethods).toEqual([{ id: 'chat-gpt', name: 'ChatGPT' }])
  })

  it('propagates a plain failure as itself, not as an auth error', async () => {
    const error = await connect({ failNewSession: { message: 'workspace is not trusted' } }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AcpAuthRequiredError)
  })
})

describe('a prompt turn', () => {
  it('projects the agent stream into a complete pi turn', async () => {
    const { connection, events } = await connect({
      onPrompt: async ({ client }) => {
        for (const text of ['he', 'llo']) {
          await client.notify('session/update', {
            sessionId: 'sess-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          })
        }
        return { stopReason: 'end_turn' }
      },
    })
    await connection.prompt('hi')
    expect(types(events).filter((type) => type !== 'message_update')).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ])
    const end = events.find((event) => event.type === 'turn_end')
    const message = end?.type === 'turn_end' ? (end.message as AssistantMessage) : null
    expect(message?.content).toEqual([{ type: 'text', text: 'hello' }])
    await connection.dispose()
  })

  // agent 侧抛错时这一轮必须收尾并把错误摆出来,不能凭空消失。
  it('turns a prompt failure into run_failed plus a settled turn', async () => {
    const { connection, events } = await connect({
      onPrompt: async () => {
        throw new RequestError(-32603, 'model exploded')
      },
    })
    await connection.prompt('hi')
    expect(types(events)).toContain('run_failed')
    expect(types(events).at(-1)).toBe('agent_settled')
    const failure = events.find((event) => event.type === 'run_failed')
    expect(failure?.type === 'run_failed' && failure.message).toContain('model exploded')
    await connection.dispose()
  })

  it('refuses a second concurrent turn', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { connection } = await connect({
      onPrompt: async () => {
        await gate
        return { stopReason: 'end_turn' }
      },
    })
    const first = connection.prompt('one')
    await expect(connection.prompt('two')).rejects.toThrow(/turn in flight/)
    release!()
    await first
    await connection.dispose()
  })

  it('accepts a new turn once the previous one settled', async () => {
    const { connection, events } = await connect()
    await connection.prompt('one')
    await connection.prompt('two')
    expect(types(events).filter((type) => type === 'agent_settled')).toHaveLength(2)
    await connection.dispose()
  })

  // 一轮之外推来的通知不属于任何一轮,吃掉就好,别把它投影成孤立的事件。
  it('ignores session updates that arrive outside a turn', async () => {
    const { connection, events } = await connect()
    await connection.prompt('one')
    const settledCount = events.length
    // 直接喂一条轮外通知:连接内部没有 turn,应当什么都不发。
    ;(connection as unknown as { onSessionUpdate: (p: unknown) => void }).onSessionUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stray' } },
    })
    expect(events).toHaveLength(settledCount)
    await connection.dispose()
  })
})

describe('permission requests', () => {
  it('routes session/request_permission to the host and returns the outcome', async () => {
    // 参数类型要写出来,否则 mock.calls[0] 是空元组,断不到收到的 params。
    const requestPermission = vi.fn(
      (params: AcpRequestPermissionParams): Promise<AcpPermissionOutcome> => {
        void params
        return Promise.resolve({ outcome: 'selected', optionId: 'allow' })
      },
    )
    let seen: unknown = null
    const { connection } = await connect({
      requestPermission,
      onPrompt: async ({ client }) => {
        seen = await client.request('session/request_permission', {
          sessionId: 'sess-1',
          // ToolCallUpdate 里 toolCallId 是必填的,少了 SDK 会以 -32602 打回。
          toolCall: { toolCallId: 'toolu_01', title: 'Write hello.txt' },
          options: [
            { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
            { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
          ],
        })
        return { stopReason: 'end_turn' }
      },
    })
    await connection.prompt('write it')
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestPermission.mock.calls[0]![0]).toMatchObject({ toolCall: { title: 'Write hello.txt' } })
    expect(seen).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    await connection.dispose()
  })
})

describe('cancel and dispose', () => {
  it('sends session/cancel while a turn is in flight', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { connection, cancelled } = await connect({
      onPrompt: async () => {
        await gate
        return { stopReason: 'cancelled' }
      },
    })
    const turn = connection.prompt('long one')
    await connection.cancel()
    expect(cancelled).toEqual(['sess-1'])
    release!()
    await turn
    await connection.dispose()
  })

  it('does not send a cancel when nothing is running', async () => {
    const { connection, cancelled } = await connect()
    await connection.cancel()
    expect(cancelled).toEqual([])
    await connection.dispose()
  })

  // 断开时还挂着的一轮必须收尾,否则界面永远停在运行中。
  it('settles an in-flight turn on dispose', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { connection, events } = await connect({
      onPrompt: async () => {
        await gate
        return { stopReason: 'end_turn' }
      },
    })
    const turn = connection.prompt('long one')
    await connection.dispose()
    expect(types(events).at(-1)).toBe('agent_settled')
    release!()
    await turn.catch(() => {})
  })

  it('refuses a prompt after dispose', async () => {
    const { connection } = await connect()
    await connection.dispose()
    await expect(connection.prompt('hi')).rejects.toThrow(/closed/)
  })

  it('is safe to dispose twice', async () => {
    const { connection } = await connect()
    await connection.dispose()
    await expect(connection.dispose()).resolves.toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { agent as createAgent, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import { AcpConnection, AcpAuthRequiredError, acpCapabilities, acpCurrentModel } from './acp-connection'

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
  /** session/load 时回放的历史。 */
  replay?: Array<Record<string, unknown>>
  /** AuthMethodAgent 的结构:SDK 的具名类型没从入口导出,按 schema 写。 */
  authMethods?: Array<{ id: string; name: string; description?: string }>
}

function fakeAgent(options: FakeAgentOptions = {}) {
  const cancelled: string[] = []
  const newSessionCalls: string[] = []
  const app = createAgent({ name: 'fake-acp' })
    .onRequest('initialize', async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'fake-acp', title: 'Fake', version: '9.9.9' },
      authMethods: options.authMethods ?? [],
    }))
    .onRequest('session/new', async () => {
      newSessionCalls.push('new')
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
    .onRequest('session/load', async (ctx) => {
      newSessionCalls.push('load')
      for (const update of options.replay ?? []) {
        await (ctx.client as never as { notify: (m: string, p: unknown) => Promise<unknown> }).notify(
          'session/update',
          { sessionId: 'sess-1', update },
        )
      }
      return {}
    })
    .onNotification('session/cancel', async () => {
      cancelled.push('sess-1')
    })
  return { app, cancelled, newSessionCalls }
}

async function connect(options: FakeAgentOptions & { resumeSessionId?: string } = {}) {
  const events: PiRuntimeEvent[] = []
  const { app, cancelled, newSessionCalls } = fakeAgent(options)
  let clock = 0
  const connection = await AcpConnection.open(app, '/tmp/workspace', {
    agentId: 'fake-acp',
    now: () => ++clock,
    resumeSessionId: options.resumeSessionId,
  })
  connection.onEvent((event) => events.push(event))
  return { connection, events, cancelled, newSessionCalls }
}

function types(events: readonly PiRuntimeEvent[]): string[] {
  return events.map((event) => event.type)
}

/** 等一个异步出现的东西(权限请求是 agent 那边发起的,不在我们的调用栈上)。 */
async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting')
}

// 界面按 features 灰按钮,报一个做不到的 true 比报 false 更坏。
describe('acpCapabilities', () => {
  it('reports an acp engine with the version the agent gave', () => {
    const caps = acpCapabilities('codex-acp', {
      agentInfo: { name: '@agentclientprotocol/codex-acp', version: '1.6.2' },
      agentCapabilities: {},
    })
    expect(caps.engine).toBe('acp')
    expect(caps.engineVersion).toBe('codex-acp@1.6.2')
    expect(caps.protocolVersion).toBe('acp-v1')
    // 会话由外部 agent 自己存,宿主读不到文件
    expect(caps.sessionFormatVersion).toBeNull()
  })

  it('turns off what an ACP backend genuinely cannot do', () => {
    const caps = acpCapabilities('x', { agentCapabilities: {} })
    expect(caps.features).toMatchObject({
      // 子代理跑在外部 agent 内部,宿主观察不到血缘
      subagents: false,
      // 压缩是 agent 自己的事,宿主没有入口
      compact: false,
      // 宿主读不到外部 agent 的历史
      sessionRead: false,
      // session/request_permission 是 ACP 基线,一定有
      approvals: true,
    })
  })

  it('reads image support from the agent, not from wishful thinking', () => {
    expect(acpCapabilities('x', { agentCapabilities: {} }).features.images).toBe(false)
    expect(
      acpCapabilities('x', { agentCapabilities: { promptCapabilities: { image: true } } }).features
        .images,
    ).toBe(true)
  })

  // sessionCapabilities.* 是「对象或 null」不是布尔:claude-agent-acp 实测给的是
  // {"fork":{},"list":{},"resume":{}} —— 空对象就表示支持。拿 === true 去判会把
  // 它支持的能力全报成不支持。
  it('reads session capabilities as presence, not as booleans', () => {
    const caps = acpCapabilities('claude-acp', {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, fork: {}, resume: {}, delete: null },
      },
    })
    expect(caps.features.resume).toBe(true)
    expect(caps.features.fork).toBe(true)
    expect(caps.features.listSessions).toBe(true)
  })

  it('treats an explicit null capability as unsupported', () => {
    const caps = acpCapabilities('x', {
      agentCapabilities: { sessionCapabilities: { fork: null } },
    })
    expect(caps.features.fork).toBe(false)
  })

  // codex-acp 实测:没有 loadSession 布尔,但 sessionCapabilities.resume 在
  it('accepts resume from either the boolean or the session capability', () => {
    expect(acpCapabilities('x', { agentCapabilities: { loadSession: true } }).features.resume).toBe(true)
    expect(
      acpCapabilities('x', { agentCapabilities: { sessionCapabilities: { resume: {} } } }).features
        .resume,
    ).toBe(true)
    expect(acpCapabilities('x', { agentCapabilities: {} }).features.resume).toBe(false)
  })

  // 2026-08-25 从两个 agent 真实抓下来的 initialize 应答。
  it('reads codex-acp@1.6.2 correctly', () => {
    const caps = acpCapabilities('codex-acp', {
      agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '1.6.2' },
      agentCapabilities: {
        auth: { logout: {} },
        providers: {},
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, additionalDirectories: {} },
        mcpCapabilities: { acp: false, http: true, sse: false },
      },
    })
    expect(caps.features).toMatchObject({
      resume: true,
      listSessions: true,
      images: true,
      // codex 没声明 fork
      fork: false,
      compact: false,
      sessionRead: false,
    })
  })

  it('reads claude-agent-acp@0.70.0 correctly', () => {
    const caps = acpCapabilities('claude-acp', {
      agentInfo: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.70.0' },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        auth: { logout: {} },
        providers: {},
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {},
        },
      },
    })
    expect(caps.engineVersion).toBe('claude-acp@0.70.0')
    expect(caps.features).toMatchObject({ resume: true, fork: true, listSessions: true, images: true })
  })

  // 问模型「你是哪个模型」不可信:它只知道训练时的身份。codex-acp 实测自称
  // 「GPT-5」,而 session/new 报的是 gpt-5.6-sol[medium]。以协议为准。
  it('reads the current model the agent reported', () => {
    const session = {
      sessionId: 's1',
      models: {
        currentModelId: 'gpt-5.6-sol[medium]',
        availableModels: [
          { modelId: 'gpt-5.6-sol[low]', name: 'GPT-5.6-Sol (low)' },
          { modelId: 'gpt-5.6-sol[medium]', name: 'GPT-5.6-Sol (medium)' },
        ],
      },
    }
    expect(acpCurrentModel(session)).toEqual({
      id: 'gpt-5.6-sol[medium]',
      name: 'GPT-5.6-Sol (medium)',
    })
    expect(acpCapabilities('codex-acp', {}, session).model?.id).toBe('gpt-5.6-sol[medium]')
  })

  it('keeps the id when the agent lists no display name for it', () => {
    expect(acpCurrentModel({ models: { currentModelId: 'x' } })).toEqual({ id: 'x', name: undefined })
  })

  // claude-agent-acp 实测不报 models,不能因此就编一个出来。
  it('reports no model when the agent does not say', () => {
    expect(acpCurrentModel({ sessionId: 's1' })).toBeNull()
    expect(acpCurrentModel({ models: {} })).toBeNull()
    expect(acpCurrentModel({ models: { currentModelId: '' } })).toBeNull()
    expect(acpCurrentModel(null)).toBeNull()
    expect(acpCapabilities('claude-acp', {}, { sessionId: 's1' }).model).toBeNull()
  })

  it('survives a garbage initialize payload', () => {
    const caps = acpCapabilities('x', null)
    expect(caps.engineVersion).toBe('x@unknown')
    expect(caps.features.images).toBe(false)
  })
})

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
  // 完整链路:agent 请求 → 投影成 extension_ui_request 推给界面 →
  // 界面用 respondExtensionUi 应答 → agent 拿到 optionId。
  it('projects the request to the UI and settles it from the response', async () => {
    let seen: unknown = null
    const { connection, events } = await connect({
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
        return { stopReason: 'end_turn' as const }
      },
    })

    // prompt 会一直等到权限被应答,所以在后台等一个 UI 请求出现再回答。
    const turn = connection.prompt('write it')
    const request = await waitFor(() =>
      events.find(
        (event): event is Extract<PiRuntimeEvent, { type: 'extension_ui_request' }> =>
          event.type === 'extension_ui_request',
      ),
    )
    expect(request).toMatchObject({ method: 'select', title: 'Write hello.txt' })
    expect(request.method === 'select' && request.options).toEqual(['Deny', 'Allow Once'])

    connection.respondExtensionUi({
      type: 'extension_ui_response',
      id: request.id,
      value: 'Allow Once',
    })
    await turn
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

// session/load 把整段历史回放过来。那不是「一轮」—— 走轮次投影的话会 emit
// agent_start / agent_settled,界面会以为有一轮正在跑。
describe('resuming an existing session', () => {
  const REPLAY = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读一下 hello.txt' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的' } },
    { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'read', status: 'pending', rawInput: { path: 'hello.txt' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'hi' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '里面是 hi' } },
  ]

  it('loads instead of creating a new session', async () => {
    const { connection, newSessionCalls } = await connect({ resumeSessionId: 'sess-1', replay: REPLAY })
    expect(newSessionCalls).toEqual(['load'])
    expect(connection.sessionId).toBe('sess-1')
    await connection.dispose()
  })

  it('rebuilds the conversation from the replay', async () => {
    const { connection } = await connect({ resumeSessionId: 'sess-1', replay: REPLAY })
    const roles = connection.conversation().map((m) => (m as { role: string }).role)
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    await connection.dispose()
  })

  it('emits no turn events while replaying', async () => {
    const { connection, events } = await connect({ resumeSessionId: 'sess-1', replay: REPLAY })
    // onEvent 是 open 之后才订阅的,但即便如此也要确认回放没把一轮跑起来
    expect(events).toEqual([])
    await connection.dispose()
  })

  // 恢复之后接着聊,历史要连上去,不能只剩新的那轮。
  it('appends a live turn on top of the replayed history', async () => {
    const { connection } = await connect({
      resumeSessionId: 'sess-1',
      replay: REPLAY,
      onPrompt: async ({ client }) => {
        await client.notify('session/update', {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的' } },
        })
        return { stopReason: 'end_turn' as const }
      },
    })
    await connection.prompt('再看一次')
    const messages = connection.conversation()
    expect(messages.map((m) => (m as { role: string }).role)).toEqual([
      'user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant',
    ])
    // 我们自己发的那句 agent 不会回放,要靠连接自己记
    expect((messages[4] as { content: string }).content).toBe('再看一次')
    await connection.dispose()
  })

  it('reports a live session with no history as an empty conversation', async () => {
    const { connection } = await connect()
    expect(connection.conversation()).toEqual([])
    await connection.dispose()
  })
})

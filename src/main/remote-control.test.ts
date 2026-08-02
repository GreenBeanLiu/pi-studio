import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  abort: vi.fn(),
  newSession: vi.fn(),
  getState: vi.fn(),
  getMessages: vi.fn(),
  getAvailableModels: vi.fn(),
  setModel: vi.fn(),
  getWorkspacePath: vi.fn(),
  switchSession: vi.fn(),
  listSessions: vi.fn(),
}))

vi.mock('./pi-client', () => ({
  piClientManager: {
    prompt: mocks.prompt,
    steer: mocks.steer,
    followUp: mocks.followUp,
    abort: mocks.abort,
    newSession: mocks.newSession,
    getState: mocks.getState,
    getMessages: mocks.getMessages,
    getAvailableModels: mocks.getAvailableModels,
    setModel: mocks.setModel,
    getWorkspacePath: mocks.getWorkspacePath,
    switchSession: mocks.switchSession,
  },
}))
vi.mock('./pi-sessions', () => ({ listSessions: mocks.listSessions }))
vi.mock('./routine-cloud-sync', () => ({
  ensureCredential: vi.fn().mockResolvedValue({ token: 'host-token' }),
  routineSyncOrigin: vi.fn().mockReturnValue('https://relay.example'),
}))
vi.mock('./app-log', () => ({ appendAppLog: vi.fn() }))

import { remoteControl } from './remote-control'

type Listener = (event: { data?: string }) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols?: string | string[]
  readonly sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.emit('close')
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }

  receive(message: unknown): void {
    this.emit('message', JSON.stringify(message))
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>
  }
}

async function connect(): Promise<FakeWebSocket> {
  await remoteControl.enable()
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  ws.emit('open')
  return ws
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.clearAllMocks()
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
})

afterEach(() => {
  remoteControl.disable()
})

describe('remote-control command protocol', () => {
  it('sends host credentials through WebSocket protocols instead of the URL', async () => {
    const ws = await connect()

    expect(ws.url).toBe('wss://relay.example/remote/ws')
    expect(ws.protocols).toEqual(['pi-studio-role.host', 'pi-studio-token.host-token'])
  })

  it('reports the computer identity when creating a pairing code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: '123456', expires_at: 123 }),
    })
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch

    await expect(remoteControl.generatePairingCode()).resolves.toEqual({
      code: '123456',
      expiresAt: 123,
      qrPayload: 'pi-studio://pair?code=123456',
    })
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      device_name: expect.any(String),
      platform: process.platform,
    })
  })

  it('acknowledges prompt only after the agent accepts it', async () => {
    mocks.prompt.mockResolvedValue(undefined)
    const ws = await connect()

    ws.receive({ id: 'phone-a:7', type: 'prompt', text: 'ship it' })

    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledWith('ship it', undefined))
    expect(ws.lastSent()).toEqual({ type: 'result', id: 'phone-a:7', data: { ok: true } })
  })

  it('returns command failures in the top-level error field', async () => {
    mocks.prompt.mockRejectedValue(new Error('No workspace is open'))
    const ws = await connect()

    ws.receive({ id: 8, type: 'prompt', text: 'run' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 8, error: 'No workspace is open' }),
    )
  })

  it('lists sessions for the current workspace', async () => {
    const sessions = [{ path: '/sessions/a.jsonl', id: 'a' }]
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    mocks.getState.mockResolvedValue({ sessionFile: '/sessions/current.jsonl' })
    mocks.listSessions.mockResolvedValue(sessions)
    const ws = await connect()

    ws.receive({ id: 9, type: 'listSessions' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 9, data: sessions }),
    )
    expect(mocks.listSessions).toHaveBeenCalledWith('/sessions', '/workspace')
  })

  it('lists available models and applies a model selected by the phone', async () => {
    const models = [
      { provider: 'openai', id: 'gpt-5.6', contextWindow: 200_000, reasoning: true },
      { provider: 'deepseek', id: 'deepseek-chat', contextWindow: 64_000, reasoning: false },
    ]
    mocks.getAvailableModels.mockResolvedValue(models)
    mocks.setModel.mockResolvedValue({ provider: 'deepseek', id: 'deepseek-chat' })
    const ws = await connect()

    ws.receive({ id: 10, type: 'getAvailableModels' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({ type: 'result', id: 10, data: models }),
    )

    ws.receive({ id: 11, type: 'setModel', provider: 'deepseek', model: 'deepseek-chat' })
    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 11,
        data: { provider: 'deepseek', id: 'deepseek-chat' },
      }),
    )
    expect(mocks.setModel).toHaveBeenCalledWith('deepseek', 'deepseek-chat')
  })

  it('rejects remote model switching while the agent is running', async () => {
    mocks.getState.mockResolvedValue({ isStreaming: true })
    const ws = await connect()

    ws.receive({ id: 12, type: 'setModel', provider: 'openai', model: 'gpt-5.6' })

    await vi.waitFor(() =>
      expect(ws.lastSent()).toEqual({
        type: 'result',
        id: 12,
        error: 'cannot switch model while agent is running',
        code: 'MODEL_SWITCH_WHILE_RUNNING',
      }),
    )
    expect(mocks.setModel).not.toHaveBeenCalled()
  })
})

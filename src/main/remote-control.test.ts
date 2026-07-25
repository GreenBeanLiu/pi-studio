import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  abort: vi.fn(),
  newSession: vi.fn(),
  getState: vi.fn(),
  getMessages: vi.fn(),
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
  readonly sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
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
})

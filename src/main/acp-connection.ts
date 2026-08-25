import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Readable, Writable } from 'stream'
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk'
import { appendAppLog, normalizeError } from './app-log'
import type { PiRuntimeEvent } from '../shared/ipc/contract'
import type { AcpLaunchSpec } from './acp-launch-spec'
import { AcpTurnProjector, type AcpSessionUpdate, type AcpStopReason } from './acp-event-mapper'
import type { AcpPermissionOutcome, AcpRequestPermissionParams } from './acp-permission-bridge'

/**
 * 一个外部 ACP agent 的连接。
 *
 * 声明 fs / terminal 能力位是实测无用的:codex-acp 和 claude-agent-acp 都在自己进程里
 * 读写文件、跑命令,只通过 session/update 事后上报。唯一的同步控制点是
 * session/request_permission —— 所以这里只实现它,不假装能拦住文件系统。
 */

/**
 * 连接目标:线上是 stdio 的 ndJsonStream,测试里直接接一个进程内的 AgentApp,
 * 整条链路不用 spawn 就能跑。
 */
export type AcpConnectTarget = Stream | AgentApp

export type AcpAgentInfo = {
  name?: string
  title?: string
  version?: string
}

export type AcpSessionModes = {
  currentModeId?: string
  availableModes?: Array<{ id: string; name: string; description?: string }>
}

export type AcpConnectionOptions = {
  agentId: string
  /** 投影出来的 pi 事件往这里推。 */
  emit: (event: PiRuntimeEvent) => void
  /** session/request_permission 的应答方(见 AcpPermissionBridge)。 */
  requestPermission: (params: AcpRequestPermissionParams) => Promise<AcpPermissionOutcome>
  now?: () => number
}

export type AcpProcessListeners = {
  stderr?: (chunk: string) => void
  exit?: (code: number | null, signal: NodeJS.Signals | null) => void
  error?: (error: Error) => void
}

/** ACP 的认证错误:agent 起来了但没登录,`data.authMethods` 告诉你怎么登。 */
export class AcpAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly authMethods: unknown[],
  ) {
    super(message)
    this.name = 'AcpAuthRequiredError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function authMethodsOf(error: unknown): unknown[] | null {
  if (!isRecord(error)) return null
  const data = error.data
  if (!isRecord(data)) return null
  return Array.isArray(data.authMethods) ? data.authMethods : null
}

function stopReasonOf(result: unknown): AcpStopReason {
  const reason = isRecord(result) ? result.stopReason : undefined
  return typeof reason === 'string' ? (reason as AcpStopReason) : 'end_turn'
}

export class AcpConnection {
  private turn: AcpTurnProjector | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private listeners: AcpProcessListeners = {}
  private connection: ClientConnection | null = null
  private closed = false

  private constructor(
    private readonly options: AcpConnectionOptions,
    readonly sessionId: string,
    readonly agentInfo: AcpAgentInfo | null,
    readonly modes: AcpSessionModes | null,
  ) {}

  /** 从一条 launch spec 起进程并握手。 */
  static async spawnAndOpen(
    spec: AcpLaunchSpec,
    cwd: string,
    options: AcpConnectionOptions,
  ): Promise<AcpConnection> {
    const child = spawn(spec.command, spec.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
    })
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    try {
      const connection = await AcpConnection.open(stream, cwd, options)
      connection.attachChild(child)
      return connection
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  }

  /** 握手 + 建会话。传 stream 是为了测试能接进程内的假 agent。 */
  static async open(
    target: AcpConnectTarget,
    cwd: string,
    options: AcpConnectionOptions,
  ): Promise<AcpConnection> {
    let self: AcpConnection | null = null
    const app = client({ name: 'pi-studio' })
      .onNotification('session/update', ({ params }) => {
        self?.onSessionUpdate(params as { update?: unknown })
      })
      .onRequest('session/request_permission', async ({ params }) => {
        const outcome = await options.requestPermission(params as AcpRequestPermissionParams)
        return { outcome }
      })

    const connection = app.connect(target as Stream)
    const agent = connection.agent

    const init = await agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // 只声明真正会实现的东西。fs/terminal 实测两个主流 agent 都不用,
      // 声明了反而是在假装宿主拦得住文件系统。
      clientCapabilities: {},
      clientInfo: { name: 'pi-studio', version: '1' },
    })

    let session: unknown
    try {
      session = await agent.request('session/new', { cwd, mcpServers: [] })
    } catch (error) {
      connection.close()
      const authMethods =
        authMethodsOf(error) ?? (isRecord(init) && Array.isArray(init.authMethods) ? init.authMethods : null)
      if (authMethods?.length) {
        throw new AcpAuthRequiredError(
          error instanceof Error ? error.message : String(error),
          authMethods,
        )
      }
      throw error
    }

    const sessionId = isRecord(session) && typeof session.sessionId === 'string' ? session.sessionId : ''
    if (!sessionId) {
      connection.close()
      throw new Error('ACP agent did not return a sessionId')
    }
    self = new AcpConnection(
      options,
      sessionId,
      isRecord(init) && isRecord(init.agentInfo) ? (init.agentInfo as AcpAgentInfo) : null,
      isRecord(session) && isRecord(session.modes) ? (session.modes as AcpSessionModes) : null,
    )
    self.connection = connection
    return self
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.listeners.stderr?.(chunk))
    child.on('exit', (code, signal) => this.listeners.exit?.(code, signal))
    child.on('error', (error) => this.listeners.error?.(error))
  }

  observeProcess(listeners: AcpProcessListeners): void {
    this.listeners = listeners
  }

  processId(): number | null {
    return this.child?.pid ?? null
  }

  private onSessionUpdate(params: { update?: unknown }): void {
    const update = params?.update
    if (!isRecord(update) || typeof update.sessionUpdate !== 'string') return
    // 没有正在进行的一轮就丢掉:agent 有时会在 prompt 之外推
    // available_commands_update 之类的东西,那不属于任何一轮。
    const turn = this.turn
    if (!turn) return
    for (const event of turn.apply(update as AcpSessionUpdate)) this.options.emit(event)
  }

  /** 发一轮 prompt,把整轮投影成 pi 事件推出去。 */
  async prompt(text: string): Promise<void> {
    if (this.closed) throw new Error('ACP connection is closed')
    if (this.turn) throw new Error('ACP session already has a turn in flight')
    const projector = new AcpTurnProjector(this.options.agentId, this.options.now)
    this.turn = projector
    for (const event of projector.begin()) this.options.emit(event)
    try {
      const result = await this.connection!.agent.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      })
      this.settle(projector, () => projector.finish(stopReasonOf(result)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.settle(projector, () => projector.fail(message))
    }
  }

  private settle(projector: AcpTurnProjector, produce: () => PiRuntimeEvent[]): void {
    const events = produce()
    if (this.turn === projector) this.turn = null
    for (const event of events) this.options.emit(event)
  }

  /** 中止当前一轮。ACP 的 session/cancel 是通知,agent 之后会用 stopReason 回 prompt。 */
  async cancel(): Promise<void> {
    if (this.closed || !this.turn) return
    try {
      await this.connection!.agent.notify('session/cancel', { sessionId: this.sessionId })
    } catch (error) {
      appendAppLog('warn', 'acp.cancel', 'Failed to cancel ACP turn', normalizeError(error))
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // 还挂着的一轮要收尾,否则界面永远停在运行中。
    const projector = this.turn
    if (projector) {
      this.turn = null
      for (const event of projector.finish('cancelled')) this.options.emit(event)
    }
    try {
      this.connection?.close()
    } catch (error) {
      appendAppLog('warn', 'acp.dispose', 'Failed to close ACP connection', normalizeError(error))
    }
    this.child?.kill('SIGTERM')
  }
}

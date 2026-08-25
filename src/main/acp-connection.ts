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
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { appendAppLog, normalizeError } from './app-log'
import type {
  ExtensionUiResponse,
  PiRuntimeCapabilities,
  PiRuntimeEvent,
} from '../shared/ipc/contract'
import type { AgentBackend } from './pi-agent-entry'
import type { AcpLaunchSpec } from './acp-launch-spec'
import { AcpTurnProjector, type AcpSessionUpdate, type AcpStopReason } from './acp-event-mapper'
import { projectAcpHistory } from './acp-history'
import { AcpPermissionBridge, type AcpRequestPermissionParams } from './acp-permission-bridge'
import { userPath } from './shell-path'

/**
 * 一个外部 ACP agent 的连接,同时就是一个 {@link AgentBackend}。
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
  now?: () => number
  /** 权限请求的超时。默认不超时,和 pi 现有的交互式审批一致。 */
  permissionTimeoutMs?: number
  /** 非空时不新建会话,而是让 agent 回放这个会话的历史。 */
  resumeSessionId?: string
}

export type AcpProcessListeners = {
  stderr?: (chunk: Buffer | string) => void
  exit?: (code: number | null, signal: string | null) => void
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

function at(source: unknown, ...path: string[]): unknown {
  let node: unknown = source
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

/** loadSession 和 promptCapabilities.* 是布尔。 */
function boolAt(source: unknown, ...path: string[]): boolean {
  return at(source, ...path) === true
}

/**
 * sessionCapabilities.* 不是布尔,是「对象或 null」—— 键存在且非 null 就表示支持
 * (claude-agent-acp 实测给的是 `{"fork":{},"list":{},"resume":{}}`)。
 * 拿 === true 去判会把它支持的能力全报成不支持。
 */
function presentAt(source: unknown, ...path: string[]): boolean {
  const value = at(source, ...path)
  return value !== undefined && value !== null
}

/**
 * 由 initialize 的应答推出这个后端能干什么。界面按 features 灰按钮,
 * 所以宁可报 false 也不要报一个做不到的 true。
 */
/** session/new 或 session/load 报的当前模型。没报就是 null(Claude 实测不报)。 */
export function acpCurrentModel(session: unknown): { id: string; name?: string } | null {
  const models = at(session, 'models')
  const currentId = at(models, 'currentModelId')
  if (typeof currentId !== 'string' || !currentId) return null
  const available = at(models, 'availableModels')
  const match = Array.isArray(available)
    ? available.find((item) => isRecord(item) && item.modelId === currentId)
    : undefined
  const name = isRecord(match) && typeof match.name === 'string' ? match.name : undefined
  return { id: currentId, name }
}

export function acpCapabilities(
  agentId: string,
  init: unknown,
  session?: unknown,
): PiRuntimeCapabilities {
  const capabilities = isRecord(init) ? init.agentCapabilities : undefined
  const version =
    (isRecord(init) && isRecord(init.agentInfo) && typeof init.agentInfo.version === 'string'
      ? init.agentInfo.version
      : null) ?? 'unknown'
  return Object.freeze({
    engine: 'acp' as const,
    engineVersion: `${agentId}@${version}`,
    protocolVersion: 'acp-v1' as const,
    // 会话由外部 agent 自己存,宿主读不到文件。
    sessionFormatVersion: null,
    model: acpCurrentModel(session),
    handshake: Object.freeze({ verified: true, state: false, messages: false, commands: false }),
    features: Object.freeze({
      listSessions: presentAt(capabilities, 'sessionCapabilities', 'list'),
      resume:
        boolAt(capabilities, 'loadSession') ||
        presentAt(capabilities, 'sessionCapabilities', 'resume'),
      fork: presentAt(capabilities, 'sessionCapabilities', 'fork'),
      // 子代理跑在外部 agent 内部,宿主观察不到血缘。
      subagents: false,
      images: boolAt(capabilities, 'promptCapabilities', 'image'),
      // 上下文压缩是 agent 自己的事,宿主没有入口。
      compact: false,
      // session/request_permission 是 ACP 的基线客户端方法,一定有。
      approvals: true,
      // 宿主读不到外部 agent 的历史,只能看自己投影出来的这一轮。
      sessionRead: false,
    }),
  })
}

export class AcpConnection implements AgentBackend {
  private turn: AcpTurnProjector | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private processListeners: AcpProcessListeners = {}
  private readonly listeners = new Set<(event: PiRuntimeEvent) => void>()
  private readonly permissions: AcpPermissionBridge
  private connection: ClientConnection | null = null
  private closed = false
  /**
   * 这个会话见过的所有 session/update,回放来的和实时的都在里面,
   * 我们自己发出去的 prompt 也按 user_message_chunk 记一条。
   *
   * 对话记录随时从它投影出来 —— 恢复和实时走的是同一个投影函数,
   * 两边不会长出两套不一致的实现。
   */
  private readonly updates: AcpSessionUpdate[] = []
  /** session/load 回放期间为 true:那时的 update 是历史,不该投影成正在跑的一轮。 */
  private replaying = false

  private constructor(
    private readonly options: AcpConnectionOptions,
    private readonly cwd: string,
    readonly capabilities: PiRuntimeCapabilities,
    readonly sessionId: string,
    readonly agentInfo: AcpAgentInfo | null,
    readonly modes: AcpSessionModes | null,
  ) {
    this.permissions = new AcpPermissionBridge({
      present: (event) => this.emit(event),
      timeoutMs: options.permissionTimeoutMs,
    })
  }

  /** 从一条 launch spec 起进程并握手。 */
  static async spawnAndOpen(
    spec: AcpLaunchSpec,
    cwd: string,
    options: AcpConnectionOptions,
  ): Promise<AcpConnection> {
    const child = spawn(spec.command, spec.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Finder / Dock 启动的 app 只有 /usr/bin:/bin:/usr/sbin:/sbin,
      // npx 装在 /opt/homebrew/bin 之类的地方 —— 不补 PATH 就是 ENOENT。
      env: { ...process.env, PATH: userPath(), ...spec.env },
    })

    // 握手期间进程就死掉的话,SDK 只会报一句「连接断了」,什么线索都没有。
    // 这里把 stderr 和退出码接住,拼成一条能定位的错。
    let stderr = ''
    let died: string | null = null
    let onDied: (() => void) | null = null
    const note = (reason: string): void => {
      died ??= reason
      onDied?.()
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      note(
        error.code === 'ENOENT'
          ? `找不到命令 ${spec.command} —— 请确认它已安装,或在设置里改用自定义命令`
          : `启动 ${spec.command} 失败:${error.message}`,
      )
    })
    child.once('exit', (code, signal) => {
      note(`${spec.command} 在握手完成前就退出了(code=${code} signal=${signal})`)
    })

    const failed = new Promise<never>((_resolve, reject) => {
      const fail = () => {
        const detail = stderr.trim()
        reject(new Error(detail ? `${died}\n${detail}` : String(died)))
      }
      if (died) fail()
      else onDied = fail
    })

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    try {
      const connection = await Promise.race([AcpConnection.open(stream, cwd, options), failed])
      onDied = null
      connection.attachChild(child)
      return connection
    } catch (error) {
      onDied = null
      child.kill('SIGTERM')
      throw error
    }
  }

  /** 握手 + 建会话。传 AgentApp 是为了测试能接进程内的假 agent。 */
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
        // 握手期间就来要权限的话没有会话可挂,直接拒。
        if (!self) return { outcome: { outcome: 'cancelled' as const } }
        const outcome = await self.permissions.request(params as AcpRequestPermissionParams)
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

    // 认证失败和「agent 挂了」要能分开:前者带 data.authMethods,界面该引导登录。
    const asAuthError = (error: unknown): never => {
      const authMethods =
        authMethodsOf(error) ??
        (isRecord(init) && Array.isArray(init.authMethods) ? init.authMethods : null)
      if (authMethods?.length) {
        throw new AcpAuthRequiredError(
          error instanceof Error ? error.message : String(error),
          authMethods,
        )
      }
      throw error
    }

    let session: unknown = null
    if (!options.resumeSessionId) {
      try {
        session = await agent.request('session/new', { cwd, mcpServers: [] })
      } catch (error) {
        connection.close()
        asAuthError(error)
      }
    }

    const sessionId =
      options.resumeSessionId ??
      (isRecord(session) && typeof session.sessionId === 'string' ? session.sessionId : '')
    if (!sessionId) {
      connection.close()
      throw new Error('ACP agent did not return a sessionId')
    }
    self = new AcpConnection(
      options,
      cwd,
      acpCapabilities(options.agentId, init, session),
      sessionId,
      isRecord(init) && isRecord(init.agentInfo) ? (init.agentInfo as AcpAgentInfo) : null,
      isRecord(session) && isRecord(session.modes) ? (session.modes as AcpSessionModes) : null,
    )
    self.connection = connection
    // 回放要在 self 就绪之后跑 —— 通知处理器要靠它把 update 收进去。
    if (options.resumeSessionId) {
      try {
        await self.load(options.resumeSessionId)
      } catch (error) {
        connection.close()
        asAuthError(error)
      }
    }
    return self
  }

  // ---- AgentBackend ----

  onEvent(listener: (event: PiRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 界面的应答。不是这个连接的待决权限就返回,让调用方接着往别处路由。 */
  respondExtensionUi(response: ExtensionUiResponse): void {
    this.permissions.settle(response)
  }

  send(message: string, images?: ImageContent[]): Promise<void> {
    return this.prompt(message, images)
  }

  /** 把攒下来的 update 投影成对话记录。 */
  conversation(): AgentMessage[] {
    return projectAcpHistory(this.updates, { modelId: this.options.agentId })
  }

  /**
   * 恢复一个已有会话:让 agent 把整段历史回放过来。
   *
   * 回放不是「一轮」—— 不能走 AcpTurnProjector,那会 emit agent_start/agent_settled,
   * 界面会以为有一轮正在跑。这里只把 update 收进 updates,之后 conversation()
   * 自然就有内容了。
   */
  async load(sessionId: string): Promise<void> {
    if (this.closed) throw new Error('ACP connection is closed')
    this.replaying = true
    try {
      await this.connection!.agent.request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] })
    } finally {
      this.replaying = false
    }
  }

  processId(): number | null {
    return this.child?.pid ?? null
  }

  observeProcess(listeners: AcpProcessListeners): void {
    this.processListeners = listeners
  }

  forceDispose(): Promise<void> {
    this.child?.kill('SIGKILL')
    return this.dispose()
  }

  // ---- 内部 ----

  private emit(event: PiRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.processListeners.stderr?.(chunk))
    child.on('exit', (code, signal) => this.processListeners.exit?.(code, signal))
    child.on('error', (error) => this.processListeners.error?.(error))
  }

  private onSessionUpdate(params: { update?: unknown }): void {
    const update = params?.update
    if (!isRecord(update) || typeof update.sessionUpdate !== 'string') return
    // 没有正在进行的一轮就丢掉:agent 有时会在 prompt 之外推
    // available_commands_update 之类的东西,那不属于任何一轮。
    this.updates.push(update as AcpSessionUpdate)
    // 回放期间只收不投:那是历史,不是正在发生的一轮。
    if (this.replaying) return
    const turn = this.turn
    if (!turn) return
    for (const event of turn.apply(update as AcpSessionUpdate)) this.emit(event)
  }

  /** 发一轮 prompt,把整轮投影成 pi 事件推出去。 */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (this.closed) throw new Error('ACP connection is closed')
    if (this.turn) throw new Error('ACP session already has a turn in flight')
    // 我们发出去的这句也要进历史 —— agent 不会把它回放给我们。
    this.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    const projector = new AcpTurnProjector(this.options.agentId, this.options.now)
    this.turn = projector
    for (const event of projector.begin()) this.emit(event)
    try {
      const result = await this.connection!.agent.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [
          { type: 'text', text },
          // ACP 的图片块和 pi 的 ImageContent 字段一致,直接透传。
          ...(images ?? []).map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
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
    // 一轮结束后还挂着的审批没人会再回答了。
    this.permissions.cancelSession(this.sessionId)
    for (const event of events) this.emit(event)
  }

  /** 中止当前一轮。ACP 的 session/cancel 是通知,agent 之后会用 stopReason 回 prompt。 */
  async cancel(reason?: string): Promise<void> {
    void reason
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
    this.permissions.cancelSession(this.sessionId)
    // 还挂着的一轮要收尾,否则界面永远停在运行中。
    const projector = this.turn
    if (projector) {
      this.turn = null
      for (const event of projector.finish('cancelled')) this.emit(event)
    }
    try {
      this.connection?.close()
    } catch (error) {
      appendAppLog('warn', 'acp.dispose', 'Failed to close ACP connection', normalizeError(error))
    }
    this.child?.kill('SIGTERM')
    this.listeners.clear()
  }
}

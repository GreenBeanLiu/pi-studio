import { dirname } from 'path'
import { hostname } from 'os'
import { piClientManager } from './pi-client'
import { listSessions } from './pi-sessions'
import { ensureCredential, routineSyncOrigin } from './routine-cloud-sync'
import { appendAppLog, normalizeError } from './app-log'
import { ModelCatalogCoordinator } from './model-catalog'
import { NO_WORKSPACE_ERROR } from './pi-client'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  ImageGenHistoryItem,
  RemotePairingCode,
  RoutineReviewRequest,
} from '../shared/ipc/contract'
import type { RoutineSchedule, RoutineStepProgress } from './routines'
import type { Workspace } from '../shared/contracts'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 手机端要能把「桌面没开工作目录」和别的失败分开:前者是一步就能自救的
 * (发 openWorkspace),后者只能提示。笼统回一句 error 的时候,手机上只会显示
 * 「读取模型列表失败」这种看不出所以然的话。
 */
function remoteErrorCode(err: unknown): string | undefined {
  return errMsg(err) === NO_WORKSPACE_ERROR ? 'NO_WORKSPACE' : undefined
}

function cachedProviderLabels(): Record<string, string> {
  try {
    return new ModelCatalogCoordinator().loadCachedProviderLabels().providerLabels
  } catch {
    return {}
  }
}

function withProviderLabel<T extends { provider: string }>(
  model: T,
  providerLabels: Record<string, string>,
): T & { providerLabel?: string } {
  const providerLabel = providerLabels[model.provider]
  return { ...model, ...(providerLabel ? { providerLabel } : {}) }
}

export type RemoteStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export type RemoteControlSnapshot = {
  enabled: boolean
  status: RemoteStatus
  controllers: number
  lastError: string
}

/** 每隔这么久发一次 ping;超过 DEAD 还没收到任何消息就当这条链路已经死了。 */
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_DEAD_MS = 60_000

/**
 * 手机据此隐藏这台桌面还不支持的功能。指令是一条条加上去的,靠 UNKNOWN_COMMAND
 * 一个个试出来,只能在用户点下去之后才发现「这个按钮在这台电脑上没用」。
 *
 * 改动指令表时这里要一起改 —— 有回归测试盯着,漏了会红。
 */
export const SUPPORTED_COMMANDS = [
  'capabilities',
  'prompt',
  'steer',
  'followUp',
  'abort',
  'newSession',
  'getState',
  'getMessages',
  'getAvailableModels',
  'setModel',
  'getWorkspace',
  'listWorkspaces',
  'openWorkspace',
  'listRoutines',
  'runRoutine',
  'toggleRoutine',
  'imageGenHealth',
  'imageGenerate',
  'imageGenHistory',
  'listPendingReviews',
  'respondReview',
  'switchSession',
  'renameSession',
  'listSessions',
] as const

/** hostEvent 会用到的 channel。手机认不出的一律丢掉。 */
export const HOST_EVENT_CHANNELS = [
  'routines:stepProgress',
  'routines:runFinished',
  'routines:reviewRequested',
  'routines:reviewCancelled',
] as const

/**
 * 开工作区的实际逻辑在 ipc.ts(要拉 runtime 配置、装扩展、挂一堆事件回调),
 * 这里只拿注入进来的入口用 —— remote-control 反向 import ipc 会成环。
 */
export type RemoteWorkspaceHost = {
  list: () => { current: string | null; recent: Workspace[] }
  open: (path: string) => Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }>
}

/**
 * 发给手机的工作流摘要。**不能**把 store 原样搬过去:一次运行的 steps 里每步产物
 * 上限 60_000 字,还留着最近 100 次运行,整个 store 是几十 MB 级别的,塞进一帧
 * WebSocket 既慢又没用 —— 手机上要看的就是「叫什么、开没开、上次跑得怎么样」。
 */
export type RemoteRoutineSummary = {
  id: string
  name: string
  enabled: boolean
  stepCount: number
  schedule: RoutineSchedule
  workspacePath: string
  createdAt: number
  lastRunAt?: number
}

export type RemoteRoutineRunSummary = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
  triggerSource?: 'manual' | 'schedule'
  summary: string
  error?: string
}

export type RemoteRoutineHost = {
  list: () => {
    routines: RemoteRoutineSummary[]
    runs: RemoteRoutineRunSummary[]
    runningIds: string[]
    queuedIds: string[]
    progress: RoutineStepProgress[]
  }
  run: (id: string) => { ok: true } | { error: string; code: string }
  toggle: (id: string, enabled: boolean) => { ok: true } | { error: string; code: string }
}

/**
 * 生图。注意结果**只回 R2 公网链接**:桌面的 ImageGenResult 还带一个 dataUrl(整张图
 * 的 base64,一张几 MB),那个绝不能进 WebSocket 帧 —— 手机自己去 CDN 拉图就行。
 */
export type RemoteImageHost = {
  health: () => Promise<{ ok: boolean; model: string }>
  generate: (payload: {
    prompt: string
    model?: string
    n?: number
    size?: string
    aspectRatio?: string
    referenceUrls?: string[]
  }) => Promise<{ urls: string[] } | { error: string }>
  history: (limit: number) => Promise<ImageGenHistoryItem[] | { error: string }>
}

/** 同理由 routines.ts 注入:pendingReviews 归它管,反向 import 会成环。 */
export type RemoteReviewHost = {
  list: () => RoutineReviewRequest[]
  respond: (
    reviewId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ) => { ok: true } | { error: string }
}

/**
 * 手机远程控制的 host 端:用装机 token 连中转 WebSocket(role=host),把手机
 * (controller)发来的指令分发给 piClientManager,并把 agent 事件转发回手机。
 * 事件转发靠 workspace:open 的 onEvent 搭车(见 ipc.ts 调 forwardEvent),不改 piClientManager。
 */
class RemoteControlManager {
  private ws: WebSocket | null = null
  private enabled = false
  private status: RemoteStatus = 'disabled'
  private lastError = ''
  private controllers = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private statusListener: ((snap: RemoteControlSnapshot) => void) | null = null
  private workspaceHost: RemoteWorkspaceHost | null = null
  private reviewHost: RemoteReviewHost | null = null
  private routineHost: RemoteRoutineHost | null = null
  private imageHost: RemoteImageHost | null = null

  setStatusListener(cb: (snap: RemoteControlSnapshot) => void): void {
    this.statusListener = cb
  }

  setWorkspaceHost(host: RemoteWorkspaceHost): void {
    this.workspaceHost = host
  }

  private requireWorkspaceHost(): RemoteWorkspaceHost {
    if (!this.workspaceHost) throw new Error('workspace control is unavailable')
    return this.workspaceHost
  }

  setReviewHost(host: RemoteReviewHost): void {
    this.reviewHost = host
  }

  setRoutineHost(host: RemoteRoutineHost): void {
    this.routineHost = host
  }

  private requireRoutineHost(): RemoteRoutineHost {
    if (!this.routineHost) throw new Error('routine control is unavailable')
    return this.routineHost
  }

  setImageHost(host: RemoteImageHost): void {
    this.imageHost = host
  }

  private requireImageHost(): RemoteImageHost {
    if (!this.imageHost) throw new Error('image generation is unavailable')
    return this.imageHost
  }

  private requireReviewHost(): RemoteReviewHost {
    if (!this.reviewHost) throw new Error('review control is unavailable')
    return this.reviewHost
  }

  snapshot(): RemoteControlSnapshot {
    return { enabled: this.enabled, status: this.status, controllers: this.controllers, lastError: this.lastError }
  }

  private emit(): void {
    this.statusListener?.(this.snapshot())
  }

  private setStatus(status: RemoteStatus, error = ''): void {
    this.status = status
    if (error) this.lastError = error
    if (status === 'connected' || status === 'connecting') this.lastError = error
    this.emit()
  }

  async enable(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    await this.connect()
  }

  disable(): void {
    this.enabled = false
    this.clearReconnect()
    this.controllers = 0
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    this.setStatus('disabled')
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * 应用层心跳。
   *
   * 桌面这条连接的唯一重连触发本来是 close 事件,但 NAT 超时、Wi-Fi 漫游、运营商掐
   * 空闲连接都**不产生 close** —— 中转早把这个 host 踢出房间、手机显示「桌面离线」,
   * 桌面这边 socket 还是 ESTABLISHED,于是永远不重连。实测遇到过。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastInboundAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > HEARTBEAT_DEAD_MS) {
        appendAppLog('warn', 'remote', 'Remote control link went silent; reconnecting')
        this.stopHeartbeat()
        try {
          this.ws?.close()
        } catch {
          /* 关不掉也无妨,重连会顶掉它 */
        }
        return
      }
      this.send({ type: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 5000)
  }

  private async connect(): Promise<void> {
    if (!this.enabled) return
    this.setStatus('connecting')
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const wsUrl = `${origin.replace(/^http/, 'ws')}/remote/ws`
      const ws = new WebSocket(wsUrl, [
        'pi-studio-role.host',
        `pi-studio-token.${cred.token}`,
      ])
      this.ws = ws
      ws.addEventListener('open', () => {
        this.controllers = 0
        this.setStatus('connected')
        appendAppLog('info', 'remote', 'Remote control host connected')
        this.startHeartbeat()
      })
      ws.addEventListener('message', (e) => {
        this.lastInboundAt = Date.now()
        void this.onControllerMessage(typeof e.data === 'string' ? e.data : String(e.data))
      })
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null
        this.stopHeartbeat()
        this.controllers = 0
        if (this.enabled) {
          this.setStatus('connecting')
          this.scheduleReconnect()
        }
      })
      ws.addEventListener('error', () => {
        // close 事件会跟着触发重连;这里只记录
      })
    } catch (err) {
      const message = errMsg(err)
      appendAppLog('warn', 'remote', 'Remote control connect failed', { error: message })
      this.setStatus('error', message)
      this.scheduleReconnect()
    }
  }

  /** 把主工作区的 agent 事件转发给手机(由 ipc.ts 的 onEvent 回调调用)。 */
  forwardEvent(event: unknown): void {
    if (this.status !== 'connected') return
    this.send({ type: 'event', event })
  }

  /**
   * agent 之外的桌面事件(工作流进度、人工审核、生图结果)。这些不能挤进 `event`
   * 那条通道 —— 手机把它直接当成聊天消息流塞进会话里,混进去就是脏数据。
   * 带 channel 分发,手机认不出的 channel 直接丢掉,老版本手机因此天然安全降级。
   */
  forwardHostEvent(channel: string, payload: unknown): void {
    if (this.status !== 'connected') return
    this.send({ type: 'hostEvent', channel, payload })
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }

  private reply(id: unknown, data: unknown = { ok: true }): void {
    if (id !== undefined && id !== null) this.send({ type: 'result', id, data })
  }

  /** 业务错误单独走 top-level error 字段,手机端据此 reject(而不是把 {error} 当成正常结果)。 */
  private replyError(id: unknown, message: string, code?: string): void {
    if (id !== undefined && id !== null) {
      this.send({ type: 'result', id, error: message, ...(code ? { code } : {}) })
    }
  }

  private async onControllerMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(msg.type ?? '')

    // 中转的连接通知
    if (type === 'pong') return
    if (type === 'controller_online') {
      this.controllers += 1
      this.emit()
      return
    }
    if (type === 'controller_offline') {
      this.controllers = Math.max(0, this.controllers - 1)
      this.emit()
      return
    }

    // 手机指令 → piClientManager
    try {
      switch (type) {
        case 'capabilities':
          this.reply(msg.id, {
            commands: [...SUPPORTED_COMMANDS],
            hostEvents: [...HOST_EVENT_CHANNELS],
          })
          break
        case 'prompt':
          await piClientManager.prompt(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
          this.reply(msg.id)
          break
        case 'steer':
          await piClientManager.steer(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
          this.reply(msg.id)
          break
        case 'followUp':
          await piClientManager.followUp(String(msg.text ?? ''), msg.images as ImageContent[] | undefined)
          this.reply(msg.id)
          break
        case 'abort':
          await piClientManager.abort()
          this.reply(msg.id)
          break
        case 'newSession':
          this.reply(msg.id, await piClientManager.newSession())
          break
        case 'getState':
          {
            const state = await piClientManager.getState()
            this.reply(
              msg.id,
              state?.model
                ? {
                    ...state,
                    model: withProviderLabel(state.model, cachedProviderLabels()),
                  }
                : state,
            )
          }
          break
        case 'getMessages':
          this.reply(msg.id, await piClientManager.getMessages())
          break
        case 'getAvailableModels':
          {
            const models = await piClientManager.getAvailableModels()
            const providerLabels = cachedProviderLabels()
            this.reply(
              msg.id,
              models.map((model) => withProviderLabel(model, providerLabels)),
            )
          }
          break
        case 'setModel': {
          const provider = String(msg.provider ?? '').trim()
          const model = String(msg.model ?? '').trim()
          if (!provider || !model) throw new Error('provider and model are required')
          const state = await piClientManager.getState()
          if (state?.isStreaming) {
            this.replyError(
              msg.id,
              'cannot switch model while agent is running',
              'MODEL_SWITCH_WHILE_RUNNING',
            )
            break
          }
          const selected = await piClientManager.setModel(provider, model)
          this.reply(msg.id, selected)
          break
        }
        case 'getWorkspace':
          this.reply(msg.id, { workspacePath: piClientManager.getWorkspacePath() })
          break
        // 桌面冷启动后没人点「打开工作区」的话,上面每条指令都会抛 NO_WORKSPACE,
        // 而人不在电脑前 —— 这两条是手机自己把工作区开起来的唯一出路。
        case 'listWorkspaces':
          this.reply(msg.id, this.requireWorkspaceHost().list())
          break
        case 'imageGenHealth':
          this.reply(msg.id, await this.requireImageHost().health())
          break
        case 'imageGenerate': {
          const prompt = String(msg.prompt ?? '').trim()
          if (!prompt) {
            this.replyError(msg.id, 'prompt is required', 'INVALID_PROMPT')
            break
          }
          const references = Array.isArray(msg.referenceUrls)
            ? msg.referenceUrls.filter((item): item is string => typeof item === 'string')
            : undefined
          const result = await this.requireImageHost().generate({
            prompt,
            ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
            ...(typeof msg.n === 'number' ? { n: msg.n } : {}),
            ...(typeof msg.size === 'string' ? { size: msg.size } : {}),
            ...(typeof msg.aspectRatio === 'string' ? { aspectRatio: msg.aspectRatio } : {}),
            ...(references?.length ? { referenceUrls: references } : {}),
          })
          if ('error' in result) {
            this.replyError(msg.id, result.error, 'IMAGE_GEN_FAILED')
            break
          }
          // 只挑 urls,不整个透传 —— ImageGenResult 里还有个几 MB 的 dataUrl,
          // 哪天有人把原始结果塞进来,这一行是最后一道闸
          this.reply(msg.id, { urls: result.urls })
          break
        }
        case 'imageGenHistory': {
          const limit = typeof msg.limit === 'number' ? msg.limit : 40
          const history = await this.requireImageHost().history(limit)
          if ('error' in history) {
            this.replyError(msg.id, history.error, 'IMAGE_HISTORY_FAILED')
            break
          }
          this.reply(msg.id, history)
          break
        }
        // 工作流不依赖工作区(store 在 userData,agent 节点自己按需拉 RpcClient),
        // 所以这几条在桌面没开工作目录时照样可用。
        case 'listRoutines':
          this.reply(msg.id, this.requireRoutineHost().list())
          break
        case 'runRoutine':
        case 'toggleRoutine': {
          const routineId = String(msg.routineId ?? '').trim()
          if (!routineId) {
            this.replyError(msg.id, 'routineId is required', 'INVALID_ROUTINE')
            break
          }
          const host = this.requireRoutineHost()
          const result =
            type === 'runRoutine'
              ? host.run(routineId)
              : host.toggle(routineId, msg.enabled !== false)
          if ('error' in result) {
            this.replyError(msg.id, result.error, result.code)
            break
          }
          this.reply(msg.id)
          break
        }
        // reviewRequested 是广播,手机当时不在线就永远收不到。重连后靠这条补齐,
        // 否则一个还剩十几分钟才超时的审核在手机上是隐形的。
        case 'listPendingReviews':
          this.reply(msg.id, this.requireReviewHost().list())
          break
        case 'respondReview': {
          const reviewId = String(msg.reviewId ?? '').trim()
          const decision = String(msg.decision ?? '')
          if (!reviewId || (decision !== 'approve' && decision !== 'reject')) {
            this.replyError(msg.id, 'reviewId and a valid decision are required', 'INVALID_REVIEW')
            break
          }
          const comment = msg.comment === undefined ? undefined : String(msg.comment)
          const result = this.requireReviewHost().respond(reviewId, decision, comment)
          // 桌面上先点了、或者已经超时 —— 手机要能分辨出「这条已经没了」而不是失败重试
          if ('error' in result) {
            this.replyError(msg.id, result.error, 'REVIEW_GONE')
            break
          }
          this.reply(msg.id)
          break
        }
        case 'openWorkspace': {
          const path = String(msg.path ?? '').trim()
          if (!path) {
            this.replyError(msg.id, 'workspace path is required', 'INVALID_PATH')
            break
          }
          const result = await this.requireWorkspaceHost().open(path)
          if ('error' in result) {
            this.replyError(msg.id, result.error, 'OPEN_WORKSPACE_FAILED')
            break
          }
          this.reply(msg.id, { workspacePath: path, recent: result.recentWorkspaces })
          break
        }
        case 'switchSession':
          this.reply(msg.id, await piClientManager.switchSession(String(msg.path ?? '')))
          break
        // 只能重命名当前会话:pi 的 set_session_name 作用于活动会话(桌面端同理)
        case 'renameSession': {
          const name = String(msg.name ?? '').trim()
          if (!name) {
            this.replyError(msg.id, 'session name is required', 'INVALID_NAME')
            break
          }
          await piClientManager.setSessionName(name)
          this.reply(msg.id)
          break
        }
        // 会话列表只能由桌面提供:RpcClient 没有 list API,是扫 sessions 目录扫出来的
        // (同 ipc.ts 的 'sessions:list')。列表按当前工作区 cwd 过滤。
        case 'listSessions': {
          const cwd = piClientManager.getWorkspacePath()
          const state = await piClientManager.getState()
          this.reply(
            msg.id,
            cwd && state.sessionFile ? await listSessions(dirname(state.sessionFile), cwd) : [],
          )
          break
        }
        default:
          this.replyError(msg.id, `unknown command: ${type}`, 'UNKNOWN_COMMAND')
          break
      }
    } catch (err) {
      // 远程指令失败过去只回给手机、桌面这边一点痕迹都不留,手机上又只显示一句
      // 通用提示 —— 出问题时两头都查不到。这里落一条日志。
      appendAppLog('warn', 'remote.command', 'Remote command failed', {
        type,
        error: normalizeError(err),
      })
      this.replyError(msg.id, errMsg(err), remoteErrorCode(err))
    }
  }

  /** app 生成一个配对码给手机输入。 */
  async generatePairingCode(): Promise<RemotePairingCode | { error: string }> {
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const res = await fetch(`${origin}/remote/pair/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: hostname(), platform: process.platform }),
      })
      if (!res.ok) return { error: `生成配对码失败(${res.status})` }
      const body = (await res.json()) as { code: string; expires_at: number }
      return {
        code: body.code,
        expiresAt: body.expires_at,
        qrPayload: `pi-studio://pair?code=${encodeURIComponent(body.code)}`,
      }
    } catch (err) {
      return { error: errMsg(err) }
    }
  }

  async resetPairings(): Promise<{ ok: true } | { error: string }> {
    try {
      const cred = await ensureCredential()
      const origin = routineSyncOrigin().replace(/\/+$/, '')
      const res = await fetch(`${origin}/remote/pair/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}` },
      })
      if (!res.ok) return { error: `解除手机绑定失败 (${res.status})` }
      this.controllers = 0
      this.emit()
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  }
}

export const remoteControl = new RemoteControlManager()

import { dirname } from 'path'
import { hostname } from 'os'
import { piClientManager } from './pi-client'
import { listSessions } from './pi-sessions'
import { ensureCredential, routineSyncOrigin } from './routine-cloud-sync'
import { appendAppLog, normalizeError } from './app-log'
import { ModelCatalogCoordinator } from './model-catalog'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  RemotePairingCode,
  SessionProjectionChanges,
  SessionProjectionSnapshot,
  StudioAgentEvent,
} from '../shared/ipc/contract'

type ProjectionProvider = {
  snapshot: () => SessionProjectionSnapshot
  changes: (sessionId: string | null, afterSeq: number) => SessionProjectionChanges
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  private statusListener: ((snap: RemoteControlSnapshot) => void) | null = null
  private projectionProvider: ProjectionProvider | null = null

  setStatusListener(cb: (snap: RemoteControlSnapshot) => void): void {
    this.statusListener = cb
  }

  setProjectionProvider(provider: ProjectionProvider | null): void {
    this.projectionProvider = provider
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
      })
      ws.addEventListener('message', (e) => {
        void this.onControllerMessage(typeof e.data === 'string' ? e.data : String(e.data))
      })
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null
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
  forwardEvent(event: StudioAgentEvent): void {
    if (this.status !== 'connected') return
    this.send({ type: 'event', event })
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
    if (type === 'controller_online') {
      this.controllers += 1
      this.emit()
      const snapshot = this.projectionProvider?.snapshot()
      if (snapshot) this.send({ type: 'sessionProjection', snapshot })
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
        case 'getSessionProjection':
          if (!this.projectionProvider) throw new Error('session projection is unavailable')
          this.reply(msg.id, this.projectionProvider.snapshot())
          break
        case 'getSessionChanges': {
          if (!this.projectionProvider) throw new Error('session projection is unavailable')
          if (msg.sessionId !== null && typeof msg.sessionId !== 'string') {
            throw new Error('sessionId must be a string or null')
          }
          const sessionId = msg.sessionId
          const afterSeq = Number(msg.afterSeq)
          if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
            throw new Error('afterSeq must be a non-negative safe integer')
          }
          this.reply(msg.id, this.projectionProvider.changes(sessionId, afterSeq))
          break
        }
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
      this.replyError(msg.id, errMsg(err))
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

import { randomUUID } from 'crypto'
import type { ExtensionUiResponse, PiRuntimeEvent } from '../shared/ipc/contract'

/**
 * ACP 的 `session/request_permission` 桥。
 *
 * 实测下来这是外部 agent(Claude Code / Codex)唯一会同步回调宿主的钩子:
 * 声明了 `fs/*` 和 `terminal/*` 能力它们也不用,文件和命令都在自己进程里做完再
 * 通过 `session/update` 事后上报。所以这里是唯一能拦住它们的地方。
 *
 * 请求被投影成 pi 现成的 `extension_ui_request`(method: select),于是:
 * 界面不用改、`UnattendedApprovalGate` 会自动拒掉无人值守运行的审批、
 * `outstandingUi` 的记账也照常生效 —— 全都白捡。
 */

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind?: string
}

/**
 * SDK 会先按 schema 校验才交到这里:`toolCall`(含 `toolCallId`)和 `options` 都是必填,
 * `title` 才是可选的。这里仍按可选写,是因为桥同时给测试和非 SDK 路径用 ——
 * 少一个字段也不该把一轮卡死。
 */
export type AcpRequestPermissionParams = {
  sessionId: string
  toolCall?: { toolCallId?: string; title?: string; kind?: string }
  options: AcpPermissionOption[]
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

/** 投影出去的请求 id 带前缀,响应回来时一眼能认出该路由给哪个后端。 */
export const ACP_PERMISSION_ID_PREFIX = 'acp-perm:'

export function isAcpPermissionRequestId(id: string): boolean {
  return id.startsWith(ACP_PERMISSION_ID_PREFIX)
}

function optionByKind(
  options: readonly AcpPermissionOption[],
  ...kinds: AcpPermissionOptionKind[]
): AcpPermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind)
    if (found) return found
  }
  return undefined
}

/** 工具调用的标题;agent 没给就退回一句通用的,不要显示成空白对话框。 */
function permissionTitle(params: AcpRequestPermissionParams): string {
  return params.toolCall?.title?.trim() || 'Agent 请求执行一个操作'
}

/** 请求里除「允许一次」外还有什么档位,写进说明让用户知道自己放弃了什么。 */
function permissionMessage(params: AcpRequestPermissionParams): string {
  const names = params.options.map((option) => option.name).join(' / ')
  return `外部 agent 请求执行:${permissionTitle(params)}\n可选项:${names}`
}

/**
 * 把 ACP 权限请求投影成 pi 的阻塞式 UI 请求。
 *
 * 必须用 confirm。ACP 给的是一组具名选项(Deny / Allow Once / Always Allow),
 * select 看起来更贴切 —— 但 pi-studio 的界面从来没给 select / input / editor
 * 做过 UI,ChatPane 收到就直接回 cancelled。用 select 的结果是:请求发出去、
 * 界面秒拒、agent 报 "Tool use aborted"(实测)。
 *
 * confirm 是唯一真有审批弹窗的方法。代价是「永久允许」这一档拿不到 ——
 * 是非两档只能映射到允许一次 / 拒绝一次。要那一档的话得先给 select 做界面。
 */
export function toExtensionUiRequest(
  requestId: string,
  params: AcpRequestPermissionParams,
): Extract<PiRuntimeEvent, { type: 'extension_ui_request'; method: 'confirm' }> {
  return {
    type: 'extension_ui_request',
    id: requestId,
    method: 'confirm',
    title: permissionTitle(params),
    message: permissionMessage(params),
  }
}

type PendingPermission = {
  requestId: string
  sessionId: string
  params: AcpRequestPermissionParams
  resolve: (outcome: AcpPermissionOutcome) => void
  timer: ReturnType<typeof setTimeout> | null
}

export type AcpPermissionBridgeOptions = {
  /** 把投影后的请求推给界面。 */
  present: (event: ReturnType<typeof toExtensionUiRequest>, params: AcpRequestPermissionParams) => void
  /**
   * 超时毫秒数。默认不超时 —— pi 现有的交互式审批就是无限等,
   * 桥自己先超时会和界面上还挂着的对话框失步(用户点了才发现已经被拒了)。
   * 无人值守的那条路由 UnattendedApprovalGate 立刻拒掉,不靠超时。
   */
  timeoutMs?: number
  createRequestId?: () => string
}

export class AcpPermissionBridge {
  private readonly pending = new Map<string, PendingPermission>()

  constructor(private readonly options: AcpPermissionBridgeOptions) {}

  /** agent 侧调进来的 session/request_permission。 */
  request(params: AcpRequestPermissionParams): Promise<AcpPermissionOutcome> {
    if (params.options.length === 0) {
      // 没有可选项就没有「允许」可言,直接当取消,别挂住 agent。
      return Promise.resolve({ outcome: 'cancelled' })
    }
    const requestId =
      this.options.createRequestId?.() ?? `${ACP_PERMISSION_ID_PREFIX}${randomUUID()}`
    return new Promise<AcpPermissionOutcome>((resolve) => {
      const timeoutMs = this.options.timeoutMs
      const entry: PendingPermission = {
        requestId,
        sessionId: params.sessionId,
        params,
        resolve,
        timer:
          timeoutMs && timeoutMs > 0
            ? setTimeout(() => this.cancel(requestId), timeoutMs)
            : null,
      }
      this.pending.set(requestId, entry)
      try {
        this.options.present(toExtensionUiRequest(requestId, params), params)
      } catch {
        // 推不出去就没人会应答,当场取消好过让 agent 永远等着。
        this.cancel(requestId)
      }
    })
  }

  /**
   * 界面(或 UnattendedApprovalGate)的应答。返回是否确实结算了一个待决请求 ——
   * 调用方据此判断这条响应该不该继续转发给 pi 子进程。
   */
  settle(response: ExtensionUiResponse): boolean {
    const entry = this.take(response.id)
    if (!entry) return false
    entry.resolve(this.toOutcome(entry.params.options, response))
    return true
  }

  private toOutcome(
    options: readonly AcpPermissionOption[],
    response: ExtensionUiResponse,
  ): AcpPermissionOutcome {
    if ('cancelled' in response) return { outcome: 'cancelled' }
    if ('value' in response) {
      // select 回来的是选项文本,按名字找回 optionId;对不上就当取消。
      const chosen = options.find((option) => option.name === response.value)
      return chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' }
    }
    // confirm 形状的响应:是非两档各取第一个匹配的 kind。
    const chosen = response.confirmed
      ? optionByKind(options, 'allow_once', 'allow_always')
      : optionByKind(options, 'reject_once', 'reject_always')
    return chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' }
  }

  cancel(requestId: string): boolean {
    const entry = this.take(requestId)
    if (!entry) return false
    entry.resolve({ outcome: 'cancelled' })
    return true
  }

  /** 一轮被中止时,这个会话上所有还挂着的审批一起取消。返回取消了几个。 */
  cancelSession(sessionId: string): number {
    const ids = [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.requestId)
    for (const id of ids) this.cancel(id)
    return ids.length
  }

  pendingIds(): string[] {
    return [...this.pending.keys()]
  }

  private take(requestId: string): PendingPermission | undefined {
    const entry = this.pending.get(requestId)
    if (!entry) return undefined
    this.pending.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }
}

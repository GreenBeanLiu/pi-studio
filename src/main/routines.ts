import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadSettings } from './settings'
import { prepareAgentRuntime } from './agent-runtime-config'
import { embeddedNodeEnv, loadRpcClient, resolvePiCliPath } from './pi-client'
import { prepareSandboxLaunch } from './sandbox'
import { writeRoutineArtifact, type RoutineArtifactFormat } from './routine-artifact'
import { syncWebSearchExtension } from './web-search-extension'
import { syncSecurityGuardExtension } from './security-guard-extension'
import { syncWorkspaceMemoryExtension } from './workspace-memory'
import { generateImage } from './image-gen'
import { cloud3dGenerate } from './model3d'
import { generateAppIconBundle } from './app-icon-bundle'
import type { AppIconPlatform } from './app-icon-spec'
import { loadChannels, sendToChannel, createFeishuDoc, createWechatDraft, type Channel } from './channels'
import { appendAppLog, normalizeError } from './app-log'
import { parseRoutineSave } from '../shared/ipc/validators'
import { isRoutineStepComplete } from './routine-step-validation'
import { readRoutineMaterialFolder } from './routine-material-folder'
import {
  inferRoutineImageRole,
  selectWechatImageAssets,
  type RoutineImageAsset,
} from './routine-assets'
import {
  configureRoutineCloudOutbox,
  queueRoutineCloudSync,
  routineSyncOrigin,
} from './routine-cloud-sync'
import { RoutineDatabase, RoutineSqliteUnavailableError } from './routine-database'
import { JsonWorkflowDeleteOutbox } from './workflow-delete-outbox'
import {
  RoutineScheduler,
  dueSlotKey,
  type SchedulableSchedule,
} from './routine-scheduler'

/**
 * 例行任务(Routines):定时执行一条由类型化节点组成的流水线。
 * 节点类型:agent(pi 会话) / imagegen(生图) / review(人工审核) / export(工作区产物) / notify(推送到某个通知渠道)。
 * 节点间用 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} 传值。
 * agent 节点每次 run spawn 一个全新 RpcClient 子进程(独立 session),跑完即弃 ——
 * 绝不打扰用户当前打开的聊天会话。
 */

export type RoutineSchedule = SchedulableSchedule

export type RoutineNotify = 'always' | 'error' | 'never'

export type RoutineStepType = 'agent' | 'folder-input' | 'imagegen' | 'app-icon' | 'model3d' | 'review' | 'notify' | 'export' | 'feishu-doc' | 'wechat-draft'

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  /** agent / imagegen:提示词(支持 {{…}} 变量) */
  prompt?: string
  /** imagegen:引擎(本地 ComfyUI 已移除,老数据里的 'comfy' 运行时回退云端) */
  engine?: 'openai' | 'comfy'
  /** notify:目标渠道 id */
  channelId?: string
  /** notify:消息模板(支持 {{…}} 变量),空则默认发上一步输出 */
  message?: string
  /** export:工作区内的相对产物路径;没有扩展名时按 format 自动补全 */
  path?: string
  /** export:Markdown 原文或公众号 HTML 片段 */
  format?: RoutineArtifactFormat
  /** model3d:图生 3D 服务商 */
  provider?: 'tripo' | 'hi3d'
  /** model3d:输入图的模板(默认 {{prev.imageUrl}});解析成 URL 走图生 3D,否则用 prompt 文生 3D */
  imageRef?: string
  /** app-icon:导出包内显示的应用名称(支持 {{…}} 变量) */
  appName?: string
  /** app-icon:需要导出的目标平台 */
  platforms?: AppIconPlatform[]
  /** app-icon:需要不透明底图的平台使用的品牌背景色 */
  backgroundColor?: string
}

export type Routine = {
  id: string
  name: string
  /** 本次运行的固定选题/Brief,支持 {{…}} 变量。 */
  input?: string
  /** Retained only to migrate previously saved single-step routines. */
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  /** 兜底汇总通知发到哪个渠道;空 = 渠道列表第一个 */
  notifyChannelId?: string
  /** 每步跑完就把该步产出推到 notifyChannelId(在飞书/手机上跟进,替代 App 内小预览) */
  pushEachStep?: boolean
  createdAt: number
  lastRunAt?: number
  /** 上次触发的时间槽(防止同一槽位重复触发,也让错过的槽当天补跑) */
  lastSlotKey?: string
}

export type RoutineStepResult = {
  id: string
  name: string
  status: 'ok' | 'error' | 'timeout' | 'skipped'
  /** 该步骤的文本产物(截断) */
  summary: string
  /** imagegen 节点的公网图片链接 */
  imageUrl?: string
  /** export 节点写出的工作区文件 */
  artifactPath?: string
  durationMs: number
}

export type RoutineReviewRequest = {
  reviewId: string
  routineId: string
  routineName: string
  stepId: string
  stepName: string
  message: string
  artifactPath?: string
  imageUrl?: string
  preview: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
  triggerSource?: 'manual' | 'schedule'
  /** 各步骤产物拼接(截断) */
  summary: string
  steps?: RoutineStepResult[]
  error?: string
}

/** 执行过程中广播给渲染进程的单步进度(流程图实时高亮用) */
export type RoutineStepProgress = {
  routineId: string
  stepId: string
  stepIndex: number
  totalSteps: number
  status: 'running' | 'ok' | 'error' | 'timeout'
}

type Store = { routines: Routine[]; runs: RoutineRun[] }

const RUN_TIMEOUT_MS = 20 * 60 * 1000
const MAX_RUNS_KEPT = 100
const MAX_CONCURRENT = 2
const MAX_STEP_OUTPUT_CHARS = 60_000
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000

const storePath = (): string => join(app.getPath('userData'), 'routines.json')
const databasePath = (): string => join(app.getPath('userData'), 'routines.sqlite3')
const deleteOutboxPath = (): string => join(app.getPath('userData'), 'cloud-sync-outbox.json')
let routineDatabase: RoutineDatabase | null = null
let jsonDeleteOutbox: JsonWorkflowDeleteOutbox | null = null

type PendingReview = {
  routineId: string
  approve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pendingReviews = new Map<string, PendingReview>()
// 保留当前运行中工作流的最新节点状态。页面切换会卸载 RoutinesPage，
// 回来时通过 routines:state 恢复这份快照，而不是等下一次事件广播。
const liveStepProgress = new Map<string, Map<string, RoutineStepProgress>>()

function cancelPendingReviews(routineId: string, reason: string): void {
  for (const [reviewId, pending] of pendingReviews) {
    if (pending.routineId !== routineId) continue
    broadcast('routines:reviewCancelled', { reviewId, reason })
    pending.reject(new Error(reason))
    pendingReviews.delete(reviewId)
  }
}

function normalizeStep(step: Partial<RoutineStep>): RoutineStep {
  const platforms = Array.isArray(step.platforms)
    ? step.platforms.filter(
        (platform): platform is AppIconPlatform =>
          platform === 'android' ||
          platform === 'ios' ||
          platform === 'macos' ||
          platform === 'windows',
      )
    : undefined
  return {
    id: step.id || randomUUID(),
    name: step.name ?? '',
    type: step.type ?? 'agent',
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
    ...(step.engine !== undefined ? { engine: step.engine } : {}),
    ...(step.channelId !== undefined ? { channelId: step.channelId } : {}),
    ...(step.message !== undefined ? { message: step.message } : {}),
    ...(step.path !== undefined ? { path: step.path } : {}),
    ...(step.format !== undefined ? { format: step.format } : {}),
    ...(step.provider !== undefined ? { provider: step.provider } : {}),
    ...(step.imageRef !== undefined ? { imageRef: step.imageRef } : {}),
    ...(typeof step.appName === 'string' ? { appName: step.appName } : {}),
    ...(platforms !== undefined ? { platforms } : {}),
    ...(typeof step.backgroundColor === 'string' ? { backgroundColor: step.backgroundColor } : {}),
  }
}

function loadStore(): Store {
  if (routineDatabase) return routineDatabase.load()
  try {
    if (existsSync(storePath())) {
      const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<Store>
      const routines = (raw.routines ?? []).map((routine) => {
        const current = routine as Routine
        const steps =
          Array.isArray(current.steps) && current.steps.length > 0
            ? current.steps.map(normalizeStep)
            : [normalizeStep({ name: '步骤 1', prompt: current.prompt ?? '' })]
        return { ...current, steps }
      })
      return { routines, runs: raw.runs ?? [] }
    }
  } catch (err) {
    appendAppLog('warn', 'routines.load', 'Failed to load routines store', normalizeError(err))
  }
  return { routines: [], runs: [] }
}

function saveStore(
  store: Store,
  deleted?: { origin: string; workflowId: string },
): void {
  if (routineDatabase) {
    routineDatabase.save(store, deleted)
  } else {
    if (deleted) jsonDeleteOutbox?.commitDelete(store, deleted.origin, deleted.workflowId)
    else {
      jsonDeleteOutbox?.assertReady()
      writeStoreSnapshot(store)
    }
  }
  queueRoutineCloudSync(store)
}

function writeStoreSnapshot(store: Store): void {
  const target = storePath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(store, null, 2), 'utf8')
  renameSync(temporary, target)
}

export function scheduleLabel(s: RoutineSchedule): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.type) {
    case 'manual':
      return '按需（手动）'
    case 'interval':
      return `每 ${s.minutes} 分钟`
    case 'hourly':
      return `每小时 ${s.minute} 分`
    case 'daily':
      return `每天 ${s.time}`
    case 'weekly':
      return `${days[s.day] ?? '?'} ${s.time}`
  }
}

// ── 变量插值 ─────────────────────────────────────────────────────

/** 每个节点跑完后的产物,供后续节点用 {{…}} 引用 */
type StepProduct = {
  output: string
  imageUrl?: string
  imageDataUrl?: string
  artifactPath?: string
  images?: RoutineImageAsset[]
}

type RunContext = {
  routine: Routine
  triggerTime: string
  products: Map<string, StepProduct> // key = step name
  prev?: StepProduct
}

/**
 * 替换模板里的 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} /
 * {{routine.name}} / {{routine.workspace}} / {{routine.input}} / {{trigger.time}}。
 * 未知变量原样保留,让错误在结果里可见而不是被吞掉。
 */
function interpolate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token: string) => {
    if (token === 'prev.output') return ctx.prev?.output ?? whole
    if (token === 'prev.imageUrl') return ctx.prev?.imageUrl ?? whole
    if (token === 'routine.name') return ctx.routine.name
    if (token === 'routine.workspace') return ctx.routine.workspacePath
    if (token === 'routine.input') return ctx.routine.input ?? ''
    if (token === 'trigger.time') return ctx.triggerTime
    if (token.startsWith('steps.')) {
      const rest = token.slice('steps.'.length)
      const dot = rest.lastIndexOf('.')
      if (dot <= 0) return whole
      const name = rest.slice(0, dot)
      const field = rest.slice(dot + 1)
      const product = ctx.products.get(name)
      if (!product) return whole
      if (field === 'output') return product.output
      if (field === 'imageUrl') return product.imageUrl ?? whole
    }
    return whole
  })
}

const hasPreviousProductReference = (text: string): boolean =>
  /\{\{\s*(?:prev\.|steps\.)/.test(text)

// ── 执行器 ───────────────────────────────────────────────────────

function latestAssistantText(
  messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> | string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
      : typeof message.content === 'string'
        ? message.content
        : ''
    if (text.trim()) return text.trim()
  }
  return ''
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** agent 节点专属:RpcClient 只在第一次遇到 agent 节点时才拉起(纯生图/通知流程不需要 API Key) */
type AgentSession = {
  client: {
    prompt: (text: string) => Promise<void>
    getMessages: () => Promise<unknown>
    onEvent: (cb: (e: { type?: string }) => void) => () => void
    stop: () => Promise<void>
  } | null
}

async function ensureAgentClient(routine: Routine, session: AgentSession): Promise<NonNullable<AgentSession['client']>> {
  if (session.client) return session.client
  const settings = loadSettings()
  const runtime = await prepareAgentRuntime()
  syncWebSearchExtension(!!settings.tavilyApiKey)
  // 安全策略 UI 已移除(隔离交给沙箱):固定卸载 securityGuard 扩展,老装机残留的也清掉
  syncSecurityGuardExtension(false)
  syncWorkspaceMemoryExtension()
  const RpcClient = await loadRpcClient()
  const env = runtime.env
  const launch = settings.sandboxEnabled
    ? await prepareSandboxLaunch(routine.workspacePath, env)
    : { cliPath: resolvePiCliPath(), env }
  const client = new RpcClient({
    cwd: routine.workspacePath,
    // Electron 打包后 RpcClient 用 process.execPath(=pi-studio.exe)拉起子进程,
    // 不带这个标记会再开一个应用窗口而不是跑 pi CLI → 卡 30s "Timeout waiting for response"。
    env: embeddedNodeEnv(launch.env),
    provider: runtime.provider,
    model: runtime.model,
    cliPath: launch.cliPath,
  })
  await client.start()
  session.client = client
  return client
}

async function runAgentStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  session: AgentSession,
  markTimeout: () => void,
): Promise<StepProduct> {
  const client = await ensureAgentClient(routine, session)
  let prompt = interpolate(step.prompt ?? '', ctx)
  // 兼容老流程:prompt 里没写变量时,自动把上一步输出接在后面
  if (!hasPreviousProductReference(step.prompt ?? '') && ctx.prev) {
    prompt = `${prompt}\n\nPrevious step result:\n${ctx.prev.output.slice(0, MAX_STEP_OUTPUT_CHARS)}`
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      markTimeout()
      reject(new Error(`执行超时(${RUN_TIMEOUT_MS / 60000} 分钟)`))
    }, RUN_TIMEOUT_MS)
    const off = client.onEvent((e: { type?: string }) => {
      if (e?.type === 'agent_end') {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
    client.prompt(prompt).catch((err: unknown) => {
      clearTimeout(timer)
      off()
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
  const messages = (await client.getMessages()) as Array<{
    role?: string
    content?: Array<{ type?: string; text?: string }> | string
  }>
  return {
    output: (latestAssistantText(messages) || '(no text output)').slice(0, MAX_STEP_OUTPUT_CHARS),
  }
}

async function runImagegenStep(step: RoutineStep, ctx: RunContext): Promise<StepProduct> {
  const prompt = interpolate(step.prompt ?? '', ctx)
  if (!prompt.trim()) throw new Error('生图节点的提示词为空')
  const result = await generateImage({
    prompt,
    // 老 routine 数据可能还存着 'comfy':本地引擎已移除,统一回退云端
    engine: step.engine === 'comfy' || !step.engine ? 'openai' : step.engine,
    downloadResult: false,
  })
  if ('error' in result) throw new Error(result.error)
  const uri = result.publicUrl ?? result.dataUrl
  return {
    output: result.publicUrl ?? '(图片已生成,无公网链接)',
    ...(result.publicUrl ? { imageUrl: result.publicUrl } : {}),
    ...(!result.publicUrl && result.dataUrl ? { imageDataUrl: result.dataUrl } : {}),
    ...(uri
      ? {
          images: [
            {
              id: `generated:${step.id}`,
              kind: 'image' as const,
              source: 'generated' as const,
              name: step.name,
              role: inferRoutineImageRole(step.name),
              uri,
            },
          ],
        }
      : {}),
  }
}

async function runAppIconStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
): Promise<StepProduct> {
  const source = interpolate((step.imageRef ?? '{{prev.imageUrl}}').trim(), ctx).trim()
  if (!source || source.includes('{{')) throw new Error('应用图标节点需要上游生图链接或工作区内的母图路径')
  const outputPath = interpolate(
    step.path?.trim() || '.pi-studio/app-icons/app-icon-bundle',
    ctx,
  )
  const result = await generateAppIconBundle({
    source,
    workspacePath: routine.workspacePath,
    outputPath,
    appName: interpolate(step.appName?.trim() || routine.name, ctx),
    backgroundColor: interpolate(step.backgroundColor?.trim() || '#2563EB', ctx),
    platforms: step.platforms?.length
      ? step.platforms
      : ['android', 'ios', 'macos', 'windows'],
  })
  return {
    output: `已生成 ${result.fileCount} 个应用图标资源文件: ${result.outputPath}`,
    artifactPath: result.outputPath,
  }
}

function runFolderInputStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
): StepProduct {
  const folderPath = interpolate(step.path?.trim() ?? '', ctx)
  if (!folderPath) return { output: '未配置本地素材文件夹，本次仅使用后续检索和生成内容。', images: [] }
  const materials = readRoutineMaterialFolder(routine.workspacePath, folderPath)
  const warnings = materials.warnings.length
    ? `\n\n## 读取提示\n${materials.warnings.map((warning) => `- ${warning}`).join('\n')}`
    : ''
  return {
    output: `${materials.text || '素材文件夹中没有可读取的文本。'}${warnings}`,
    images: materials.images,
  }
}

async function runExportStep(routine: Routine, step: RoutineStep, ctx: RunContext): Promise<StepProduct> {
  const content = ctx.prev?.output ?? ''
  if (!content.trim()) throw new Error('导出节点没有可写入的上一步内容')
  const format = step.format ?? 'markdown'
  const requestedPath = interpolate(
    step.path?.trim() || `.pi-studio/articles/${Date.now()}-article`,
    ctx,
  )
  const artifact = writeRoutineArtifact(routine.workspacePath, requestedPath, format, content)
  return { output: artifact.path, artifactPath: artifact.path }
}

/** 图/文 → 3D 节点:有上游图(imageRef 默认 {{prev.imageUrl}})就图生 3D,否则用 prompt 文生 3D;glb 存进工作区。 */
async function runModel3dStep(step: RoutineStep, ctx: RunContext): Promise<StepProduct> {
  const prompt = interpolate(step.prompt ?? '', ctx).trim()
  const imageRef = interpolate((step.imageRef ?? '{{prev.imageUrl}}').trim(), ctx).trim()
  const imageUrl = /^https?:\/\//i.test(imageRef) ? imageRef : undefined
  if (!imageUrl && !prompt) throw new Error('3D 节点需要上游图片(imageRef)或文字提示词')
  const { modelUrl, thumbnailUrl } = await cloud3dGenerate({
    ...(imageUrl ? { imageUrl } : { prompt }),
    provider: step.provider ?? 'tripo',
    options: { texture: true },
  })
  const dir = join(ctx.routine.workspacePath, '.pi-studio', 'models')
  mkdirSync(dir, { recursive: true })
  const safe = step.name.trim().replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'model'
  const glbPath = join(dir, `${Date.now()}-${safe}.glb`)
  const res = await fetch(modelUrl, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`下载模型失败 HTTP ${res.status}`)
  writeFileSync(glbPath, Buffer.from(await res.arrayBuffer()))
  return {
    output: glbPath,
    artifactPath: glbPath,
    ...(thumbnailUrl ? { imageUrl: thumbnailUrl } : {}),
  }
}

async function runReviewStep(routine: Routine, step: RoutineStep, ctx: RunContext): Promise<StepProduct> {
  const reviewId = randomUUID()
  const previous = ctx.prev
  const request: RoutineReviewRequest = {
    reviewId,
    routineId: routine.id,
    routineName: routine.name,
    stepId: step.id,
    stepName: step.name,
    message: interpolate(step.message?.trim() || '请检查上一步生成的公众号草稿，确认后继续。', ctx),
    ...(previous?.artifactPath ? { artifactPath: previous.artifactPath } : {}),
    ...(previous?.imageUrl || previous?.imageDataUrl
      ? { imageUrl: previous.imageUrl ?? previous.imageDataUrl }
      : {}),
    preview: (previous?.output ?? '').slice(0, 8000),
  }

  return new Promise<StepProduct>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReviews.delete(reviewId)
      broadcast('routines:reviewCancelled', { reviewId, reason: '人工审核超时，工作流已停止' })
      reject(new Error('人工审核超时，工作流已停止'))
    }, REVIEW_TIMEOUT_MS)
    pendingReviews.set(reviewId, {
      routineId: routine.id,
      timer,
      approve: () => {
        clearTimeout(timer)
        pendingReviews.delete(reviewId)
        resolve(previous ?? { output: '' })
      },
      reject: (error) => {
        clearTimeout(timer)
        pendingReviews.delete(reviewId)
        reject(error)
      },
    })
    broadcast('routines:reviewRequested', request)
  })
}

async function runNotifyStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
): Promise<StepProduct> {
  const channel = channels.find((c) => c.id === step.channelId)
  if (!channel || channel.type === 'wechat-official') throw new Error('通知节点需要可发送的通知渠道,微信公众号渠道请使用草稿节点')
  const markdown = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  const imageUrls = [...ctx.products.values()].map((p) => p.imageUrl).filter((u): u is string => !!u)
  await sendToChannel(channel, {
    title: `${routine.name} · ${step.name}`,
    status: 'info',
    markdown,
    ...(imageUrls.length ? { imageUrls } : {}),
  })
  return { output: `已发送到「${channel.name}」` }
}

async function runFeishuDocStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
): Promise<StepProduct> {
  const channel =
    (step.channelId ? channels.find((c) => c.id === step.channelId) : undefined) ??
    channels.find((c) => c.type === 'feishu-app')
  if (!channel || channel.type !== 'feishu-app')
    throw new Error('存飞书文档需要一个「飞书应用」渠道(设置→通知渠道),且应用需开通 docx:document 权限')
  // 正文来源:默认上一步;模板里可用 step.message 指定,如 {{steps.写正文.output}}
  const content = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  if (!content.trim()) throw new Error('没有可写入飞书文档的正文内容')
  const title = interpolate(step.path?.trim() || `${routine.name} · {{trigger.time}}`, ctx)
  // 文章配图只来自 imagegen 节点，避免把其它节点/通知上下文中的图片带进文档。
  const imageUrls = routine.steps
    .filter((candidate) => candidate.type === 'imagegen')
    .map((candidate) => ctx.products.get(candidate.name))
    .filter((product): product is StepProduct => !!product)
    .map((product) => product.imageUrl ?? product.imageDataUrl)
    .filter((url): url is string => !!url)
  const { url } = await createFeishuDoc(channel, title, content, imageUrls)
  return { output: `[打开飞书文档](${url})`, artifactPath: url }
}

async function runWechatDraftStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
): Promise<StepProduct> {
  const channel =
    (step.channelId ? channels.find((candidate) => candidate.id === step.channelId) : undefined) ??
    channels.find((candidate) => candidate.type === 'wechat-official')
  if (!channel || channel.type !== 'wechat-official')
    throw new Error('微信公众号草稿需要一个「微信公众号」渠道(设置→通知渠道)')
  const content = interpolate(step.message?.trim() || '{{prev.output}}', ctx)
  if (!content.trim()) throw new Error('没有可写入微信公众号草稿的正文内容')
  const title = interpolate(step.path?.trim() || `${routine.name} · {{trigger.time}}`, ctx)
  const assets = routine.steps
    .map((candidate) => ctx.products.get(candidate.name))
    .filter((product): product is StepProduct => !!product)
    .flatMap((product) => product.images ?? [])
  const selected = selectWechatImageAssets(assets)
  if (!selected.cover) throw new Error('微信公众号草稿至少需要一张素材图片或生成图片作为封面')
  const draft = await createWechatDraft(channel, title, content, {
    cover: selected.cover.uri,
    inline: selected.inline.map((asset) => asset.uri),
  })
  return { output: `微信公众号草稿已创建: ${draft.title}（media_id: ${draft.mediaId}）`, artifactPath: draft.mediaId }
}

async function executeRoutine(
  store: Store,
  routine: Routine,
  triggerSource: 'manual' | 'schedule',
): Promise<void> {
  const startedAt = Date.now()
  let status: RoutineRun['status'] = 'ok'
  let timedOut = false
  let errorMsg: string | undefined
  const stepResults: RoutineStepResult[] = routine.steps.map((step) => ({
    id: step.id,
    name: step.name,
    status: 'skipped',
    summary: '',
    durationMs: 0,
  }))

  const stepProgress = (stepIndex: number, s: RoutineStepProgress['status']): void => {
    const progress = {
      routineId: routine.id,
      stepId: routine.steps[stepIndex].id,
      stepIndex,
      totalSteps: routine.steps.length,
      status: s,
    } satisfies RoutineStepProgress
    const routineProgress = liveStepProgress.get(routine.id) ?? new Map<string, RoutineStepProgress>()
    routineProgress.set(progress.stepId, progress)
    liveStepProgress.set(routine.id, routineProgress)
    broadcast('routines:stepProgress', progress)
  }

  const session: AgentSession = { client: null }
  const channels = loadChannels()
  // 每步推送目标:开了 pushEachStep 就用兜底通知那个渠道(或第一个非本地渠道)
  const pushChannel = routine.pushEachStep
    ? (channels.find((c) => c.id === routine.notifyChannelId && c.type !== 'wechat-official') ??
        channels.find((c) => c.type !== 'local' && c.type !== 'wechat-official'))
    : undefined
  const ctx: RunContext = {
    routine,
    triggerTime: new Date().toLocaleString(),
    products: new Map(),
  }

  try {
    if (!existsSync(routine.workspacePath)) {
      throw new Error(`工作区不存在: ${routine.workspacePath}`)
    }
    try {
      for (const [index, step] of routine.steps.entries()) {
        const stepStartedAt = Date.now()
        stepProgress(index, 'running')
        try {
          const product: StepProduct =
            step.type === 'folder-input'
              ? runFolderInputStep(routine, step, ctx)
              : step.type === 'imagegen'
              ? await runImagegenStep(step, ctx)
              : step.type === 'app-icon'
              ? await runAppIconStep(routine, step, ctx)
              : step.type === 'model3d'
              ? await runModel3dStep(step, ctx)
              : step.type === 'notify'
                ? await runNotifyStep(routine, step, ctx, channels)
                : step.type === 'review'
                  ? await runReviewStep(routine, step, ctx)
                : step.type === 'export'
                  ? await runExportStep(routine, step, ctx)
                  : step.type === 'feishu-doc'
                    ? await runFeishuDocStep(routine, step, ctx, channels)
                    : step.type === 'wechat-draft'
                      ? await runWechatDraftStep(routine, step, ctx, channels)
                    : await runAgentStep(routine, step, ctx, session, () => {
                        timedOut = true
                      })
          ctx.products.set(step.name, product)
          ctx.prev = product
          stepResults[index] = {
            id: step.id,
            name: step.name,
            status: 'ok',
            summary: product.output.slice(0, 4000),
            ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
            ...(product.artifactPath ? { artifactPath: product.artifactPath } : {}),
            durationMs: Date.now() - stepStartedAt,
          }
          stepProgress(index, 'ok')
          // 每步推送:跑完就把这步产出推到飞书(替代 App 内小预览)
          if (pushChannel && step.type !== 'notify') {
            void sendToChannel(pushChannel, {
              title: `${routine.name} · ${index + 1}. ${step.name}`,
              status: 'info',
              markdown: product.output.slice(0, 3000),
              ...(product.imageUrl ? { imageUrls: [product.imageUrl] } : {}),
            }).catch((err) =>
              appendAppLog('warn', 'routines.pushStep', 'Per-step push failed', {
                routine: routine.name,
                step: step.name,
                error: normalizeError(err),
              }),
            )
          }
        } catch (err) {
          if (err instanceof Error && err.message === '人工审核超时，工作流已停止') timedOut = true
          const failStatus = timedOut ? ('timeout' as const) : ('error' as const)
          stepResults[index] = {
            id: step.id,
            name: step.name,
            status: failStatus,
            summary: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - stepStartedAt,
          }
          stepProgress(index, failStatus)
          throw err
        }
      }
    } finally {
      await session.client?.stop().catch(() => {})
    }
  } catch (err) {
    status = timedOut ? 'timeout' : 'error'
    errorMsg = err instanceof Error ? err.message : String(err)
    appendAppLog('error', 'routines.run', 'Routine run failed', {
      routine: routine.name,
      error: normalizeError(err),
    })
  }

  const summary =
    stepResults
      .filter((s) => s.status !== 'skipped')
      .map((s, i) => `Step ${i + 1} - ${s.name}\n${s.summary}`)
      .join('\n\n')
      .slice(0, 4000) || '(no output)'

  const run: RoutineRun = {
    id: randomUUID(),
    routineId: routine.id,
    routineName: routine.name,
    startedAt,
    endedAt: Date.now(),
    status,
    triggerSource,
    summary,
    steps: stepResults,
    error: errorMsg,
  }
  liveStepProgress.delete(routine.id)
  store.runs = [run, ...store.runs].slice(0, MAX_RUNS_KEPT)
  saveStore(store)

  // 兜底汇总通知(notify 节点之外的保险):本地弹窗 + 默认渠道一张卡片
  const shouldNotify = routine.notify === 'always' || (routine.notify === 'error' && status !== 'ok')
  if (shouldNotify) {
    if (Notification.isSupported()) {
      new Notification({
        title: `例行任务${status === 'ok' ? '完成' : '失败'}: ${routine.name}`,
        body: (errorMsg ?? summary).slice(0, 150),
      }).show()
    }
    const target =
      channels.find((c) => c.id === routine.notifyChannelId && c.type !== 'wechat-official') ??
      channels.find((c) => c.type !== 'local' && c.type !== 'wechat-official')
    if (target) {
      const statusText = status === 'ok' ? '完成' : status === 'timeout' ? '超时' : '失败'
      const durationS = Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))
      const stepsMd = stepResults
        .map((s, i) => {
          const icon = s.status === 'ok' ? '✅' : s.status === 'skipped' ? '⏭' : '❌'
          const body = s.status === 'skipped' ? '(未执行)' : s.summary.slice(0, 300)
          return `${icon} **${i + 1}. ${s.name}**\n${body}`
        })
        .join('\n')
      const imageUrls = stepResults.map((s) => s.imageUrl).filter((u): u is string => !!u)
      sendToChannel(target, {
        title: `${status === 'ok' ? '✅' : '❌'} 例行任务${statusText}:${routine.name}`,
        status,
        markdown: `**工作区** ${routine.workspacePath} · **耗时** ${durationS}s${errorMsg ? `\n**错误** ${errorMsg.slice(0, 500)}` : ''}\n---\n${stepsMd}`,
        ...(imageUrls.length ? { imageUrls } : {}),
      }).catch((err) => {
        appendAppLog('error', 'routines.notify', 'Run summary notify failed', {
          routine: routine.name,
          channel: target.name,
          error: normalizeError(err),
        })
      })
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('routines:runFinished', run)
    if (shouldNotify && !win.isFocused()) {
      win.flashFrame(true)
      win.once('focus', () => win.flashFrame(false))
    }
  }
}

// ── 注册 ─────────────────────────────────────────────────────────

const stepIsComplete = isRoutineStepComplete

export function registerRoutines(): void {
  jsonDeleteOutbox = new JsonWorkflowDeleteOutbox(deleteOutboxPath(), storePath())
  const databaseAlreadyExists = existsSync(databasePath())
  try {
    routineDatabase = new RoutineDatabase(databasePath(), storePath())
    try {
      const legacyDeletes = jsonDeleteOutbox.readAll()
      routineDatabase.importWorkflowDeletes(legacyDeletes)
      if (legacyDeletes.length > 0) jsonDeleteOutbox.archiveAndClear()
    } catch (error) {
      appendAppLog(
        'error',
        'routines.database',
        'Failed to import the legacy cloud delete outbox',
        normalizeError(error),
      )
    }
    configureRoutineCloudOutbox(routineDatabase)
    app.once('will-quit', () => {
      routineDatabase?.close()
      routineDatabase = null
    })
  } catch (error) {
    routineDatabase?.close()
    routineDatabase = null
    if (
      !(error instanceof RoutineSqliteUnavailableError) ||
      databaseAlreadyExists ||
      existsSync(databasePath())
    ) {
      throw error
    }
    configureRoutineCloudOutbox(jsonDeleteOutbox)
    appendAppLog(
      'error',
      'routines.database',
      'Failed to initialize SQLite; using legacy JSON storage',
      normalizeError(error),
    )
  }
  const store = loadStore()
  queueRoutineCloudSync(store)
  const scheduler = new RoutineScheduler<Routine>({
    maxConcurrent: MAX_CONCURRENT,
    clock: () => new Date(),
    execute: (routine) => {
      const triggerSource = triggerSources.get(routine.id) ?? 'schedule'
      triggerSources.delete(routine.id)
      return executeRoutine(store, routine, triggerSource)
    },
    onExecutionError: (error, routine) => {
      appendAppLog('error', 'routines.scheduler', 'Routine execution escaped the scheduler', {
        routine: routine.name,
        error: normalizeError(error),
      })
    },
  })

  const triggerSources = new Map<string, 'manual' | 'schedule'>()

  setInterval(() => {
    const scheduled = scheduler.tick(store.routines)
    if (scheduled.length > 0) saveStore(store)
  }, 30_000)

  ipcMain.handle('routines:list', () => ({ routines: store.routines, runs: store.runs }))

  ipcMain.handle(
    'routines:save',
    (_e, payload: unknown) => {
      // 只放行已知字段:原来直接 Object.assign(existing, routine),
      // renderer 传什么并什么,未知字段会被持久化并同步上云
      const routine = parseRoutineSave(payload)
      const steps = (routine.steps as Partial<RoutineStep>[]).map(normalizeStep).filter(stepIsComplete)
      if (steps.length === 0) throw new Error('Workflow needs at least one complete step')
      const existing = routine.id ? store.routines.find((r) => r.id === routine.id) : undefined
      if (existing) {
        Object.assign(existing, { ...routine, steps })
      } else {
        const fresh = {
          enabled: true,
          createdAt: Date.now(),
          ...routine,
          steps,
          id: randomUUID(),
        } as Routine
        // 新任务从下一个周期开始:把"当前已过的槽"标记为已消费,
        // 否则 23:00 建一个"每天 09:00"的任务会立刻触发一次
        fresh.lastSlotKey = dueSlotKey(fresh, new Date()) ?? undefined
        if (fresh.schedule.type === 'interval') fresh.lastRunAt = Date.now()
        store.routines.push(fresh)
      }
      saveStore(store)
      return store.routines
    },
  )

  ipcMain.handle('routines:delete', (_e, id: string) => {
    const nextRoutines = store.routines.filter((routine) => routine.id !== id)
    saveStore(
      { ...store, routines: nextRoutines },
      { origin: routineSyncOrigin(), workflowId: id },
    )
    store.routines = nextRoutines
    scheduler.cancel(id)
    cancelPendingReviews(id, '工作流已删除，审核请求已取消')
    return store.routines
  })

  ipcMain.handle('routines:toggle', (_e, id: string, enabled: boolean) => {
    const r = store.routines.find((x) => x.id === id)
    if (r) {
      r.enabled = enabled
      if (!enabled) {
        scheduler.cancel(id)
        cancelPendingReviews(id, '工作流已停用，审核请求已取消')
      }
      saveStore(store)
    }
    return store.routines
  })

  ipcMain.handle('routines:runNow', (_e, id: string) => {
    const r = store.routines.find((x) => x.id === id)
    if (!r) return { error: '任务不存在' }
    if (scheduler.has(r.id)) return { error: '该任务正在执行或排队' }
    if (!scheduler.hasCapacity()) return { error: `最多同时执行 ${MAX_CONCURRENT} 个任务` }
    r.lastRunAt = Date.now()
    triggerSources.set(r.id, 'manual')
    saveStore(store)
    scheduler.enqueue(r)
    return { ok: true }
  })

  ipcMain.handle('routines:state', () => ({
    ...scheduler.getState(),
    progress: [...liveStepProgress.values()].flatMap((steps) => [...steps.values()]),
  }))

  ipcMain.handle(
    'routines:reviewRespond',
    (_e, reviewId: string, decision: 'approve' | 'reject', comment?: string) => {
      const pending = pendingReviews.get(reviewId)
      if (!pending) return { error: '审核请求已过期或工作流已结束' }
      if (decision === 'approve') {
        pending.approve()
      } else {
        pending.reject(new Error(comment?.trim() || '人工审核拒绝'))
      }
      return { ok: true }
    },
  )
}

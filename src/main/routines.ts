import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadSettings, apiKeyEnvVar, agentConfigDir } from './settings'
import { loadRpcClient, resolvePiCliPath } from './pi-client'
import { generateImage } from './image-gen'
import { loadChannels, sendToChannel, type Channel } from './channels'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 例行任务(Routines):定时执行一条由类型化节点组成的流水线。
 * 节点类型:agent(pi 会话) / imagegen(生图) / notify(推送到某个通知渠道)。
 * 节点间用 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} 传值。
 * agent 节点每次 run spawn 一个全新 RpcClient 子进程(独立 session),跑完即弃 ——
 * 绝不打扰用户当前打开的聊天会话。
 */

export type RoutineSchedule =
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string } // "09:00"
  | { type: 'weekly'; day: number; time: string } // day: 0=周日 … 6=周六

export type RoutineNotify = 'always' | 'error' | 'never'

export type RoutineStepType = 'agent' | 'imagegen' | 'notify'

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  /** agent / imagegen:提示词(支持 {{…}} 变量) */
  prompt?: string
  /** imagegen:引擎,openai=云端 gpt-image-2,comfy=本地 SDXL */
  engine?: 'openai' | 'comfy'
  /** notify:目标渠道 id */
  channelId?: string
  /** notify:消息模板(支持 {{…}} 变量),空则默认发上一步输出 */
  message?: string
}

export type Routine = {
  id: string
  name: string
  /** Retained only to migrate previously saved single-step routines. */
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  /** 兜底汇总通知发到哪个渠道;空 = 渠道列表第一个 */
  notifyChannelId?: string
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
  durationMs: number
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
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

const storePath = (): string => join(app.getPath('userData'), 'routines.json')

function normalizeStep(step: Partial<RoutineStep>): RoutineStep {
  return {
    id: step.id || randomUUID(),
    name: step.name ?? '',
    type: step.type ?? 'agent',
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
    ...(step.engine !== undefined ? { engine: step.engine } : {}),
    ...(step.channelId !== undefined ? { channelId: step.channelId } : {}),
    ...(step.message !== undefined ? { message: step.message } : {}),
  }
}

function loadStore(): Store {
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

function saveStore(store: Store): void {
  writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8')
}

// ── 调度 ──────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 返回当前应处于的触发槽 key;与 lastSlotKey 不同且时间已到即触发。
 * 槽粒度:interval 用 lastRunAt,其余用「日期+时段」字符串,错过 tick 也能当天补跑。
 */
function dueSlotKey(r: Routine, now: Date): string | null {
  const s = r.schedule
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  switch (s.type) {
    case 'interval': {
      const last = r.lastRunAt ?? 0
      return Date.now() - last >= s.minutes * 60_000 ? `interval-${Date.now()}` : null
    }
    case 'hourly': {
      if (now.getMinutes() < s.minute) return null
      return `${today} ${pad(now.getHours())}h`
    }
    case 'daily': {
      if (hhmm < s.time) return null
      return today
    }
    case 'weekly': {
      if (now.getDay() !== s.day || hhmm < s.time) return null
      return `${today} w`
    }
  }
}

export function scheduleLabel(s: RoutineSchedule): string {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.type) {
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
type StepProduct = { output: string; imageUrl?: string }

type RunContext = {
  routine: Routine
  triggerTime: string
  products: Map<string, StepProduct> // key = step name
  prev?: StepProduct
}

/**
 * 替换模板里的 {{prev.output}} / {{steps.<名字>.output}} / {{steps.<名字>.imageUrl}} /
 * {{routine.name}} / {{routine.workspace}} / {{trigger.time}}。
 * 未知变量原样保留,让错误在结果里可见而不是被吞掉。
 */
function interpolate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token: string) => {
    if (token === 'prev.output') return ctx.prev?.output ?? whole
    if (token === 'prev.imageUrl') return ctx.prev?.imageUrl ?? whole
    if (token === 'routine.name') return ctx.routine.name
    if (token === 'routine.workspace') return ctx.routine.workspacePath
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

const hasVariables = (text: string): boolean => /\{\{[^{}]+\}\}/.test(text)

// ── 执行器 ───────────────────────────────────────────────────────

const running = new Set<string>()

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
  if (!settings.apiKey) throw new Error('未配置 API Key(agent 节点需要)')
  const RpcClient = await loadRpcClient()
  const client = new RpcClient({
    cwd: routine.workspacePath,
    env: {
      [apiKeyEnvVar(settings.provider)]: settings.apiKey,
      PI_CODING_AGENT_DIR: agentConfigDir(),
      ...(settings.tavilyApiKey ? { TAVILY_API_KEY: settings.tavilyApiKey } : {}),
      ...(settings.heliconeApiKey ? { HELICONE_API_KEY: settings.heliconeApiKey } : {}),
    },
    provider: settings.provider,
    model: settings.model || undefined,
    cliPath: resolvePiCliPath(),
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
  if (!hasVariables(step.prompt ?? '') && ctx.prev) {
    prompt = `${prompt}\n\nPrevious step result:\n${ctx.prev.output.slice(0, 4000)}`
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
  return { output: (latestAssistantText(messages) || '(no text output)').slice(0, 4000) }
}

async function runImagegenStep(step: RoutineStep, ctx: RunContext): Promise<StepProduct> {
  const prompt = interpolate(step.prompt ?? '', ctx)
  if (!prompt.trim()) throw new Error('生图节点的提示词为空')
  const result = await generateImage({ prompt, engine: step.engine ?? 'openai' })
  if ('error' in result) throw new Error(result.error)
  return {
    output: result.publicUrl ?? '(图片已生成,无公网链接)',
    ...(result.publicUrl ? { imageUrl: result.publicUrl } : {}),
  }
}

async function runNotifyStep(
  routine: Routine,
  step: RoutineStep,
  ctx: RunContext,
  channels: Channel[],
): Promise<StepProduct> {
  const channel = channels.find((c) => c.id === step.channelId)
  if (!channel) throw new Error('通知渠道不存在,去 设置→通知渠道 检查')
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

async function executeRoutine(store: Store, routine: Routine): Promise<void> {
  if (running.has(routine.id) || running.size >= MAX_CONCURRENT) return
  running.add(routine.id)
  const startedAt = Date.now()
  let status: RoutineRun['status'] = 'ok'
  let errorMsg: string | undefined
  const stepResults: RoutineStepResult[] = routine.steps.map((step) => ({
    id: step.id,
    name: step.name,
    status: 'skipped',
    summary: '',
    durationMs: 0,
  }))

  const stepProgress = (stepIndex: number, s: RoutineStepProgress['status']): void =>
    broadcast('routines:stepProgress', {
      routineId: routine.id,
      stepId: routine.steps[stepIndex].id,
      stepIndex,
      totalSteps: routine.steps.length,
      status: s,
    } satisfies RoutineStepProgress)

  const session: AgentSession = { client: null }
  const channels = loadChannels()
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
            step.type === 'imagegen'
              ? await runImagegenStep(step, ctx)
              : step.type === 'notify'
                ? await runNotifyStep(routine, step, ctx, channels)
                : await runAgentStep(routine, step, ctx, session, () => {
                    status = 'timeout'
                  })
          ctx.products.set(step.name, product)
          ctx.prev = product
          stepResults[index] = {
            id: step.id,
            name: step.name,
            status: 'ok',
            summary: product.output,
            ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
            durationMs: Date.now() - stepStartedAt,
          }
          stepProgress(index, 'ok')
        } catch (err) {
          const failStatus = (status as RoutineRun['status']) === 'timeout' ? ('timeout' as const) : ('error' as const)
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
    if (status === 'ok') status = 'error'
    errorMsg = err instanceof Error ? err.message : String(err)
    appendAppLog('error', 'routines.run', 'Routine run failed', {
      routine: routine.name,
      error: normalizeError(err),
    })
  } finally {
    running.delete(routine.id)
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
    summary,
    steps: stepResults,
    error: errorMsg,
  }
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
    const target = channels.find((c) => c.id === routine.notifyChannelId) ?? channels.find((c) => c.type !== 'local')
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

const stepIsComplete = (step: RoutineStep): boolean => {
  if (!step.name.trim()) return false
  if (step.type === 'notify') return !!step.channelId
  return !!step.prompt?.trim()
}

export function registerRoutines(): void {
  const store = loadStore()

  setInterval(() => {
    const now = new Date()
    for (const r of store.routines) {
      if (!r.enabled || running.has(r.id)) continue
      const slot = dueSlotKey(r, now)
      if (!slot) continue
      if (r.schedule.type !== 'interval' && r.lastSlotKey === slot) continue
      r.lastSlotKey = slot
      r.lastRunAt = Date.now()
      saveStore(store)
      void executeRoutine(store, r)
    }
  }, 30_000)

  ipcMain.handle('routines:list', () => ({ routines: store.routines, runs: store.runs }))

  ipcMain.handle(
    'routines:save',
    (_e, routine: Partial<Routine> & Pick<Routine, 'name' | 'steps' | 'workspacePath' | 'schedule' | 'notify'>) => {
      const steps = (routine.steps ?? []).map(normalizeStep).filter(stepIsComplete)
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
    store.routines = store.routines.filter((r) => r.id !== id)
    saveStore(store)
    return store.routines
  })

  ipcMain.handle('routines:toggle', (_e, id: string, enabled: boolean) => {
    const r = store.routines.find((x) => x.id === id)
    if (r) {
      r.enabled = enabled
      saveStore(store)
    }
    return store.routines
  })

  ipcMain.handle('routines:runNow', (_e, id: string) => {
    const r = store.routines.find((x) => x.id === id)
    if (!r) return { error: '任务不存在' }
    if (running.has(r.id)) return { error: '该任务正在执行' }
    if (running.size >= MAX_CONCURRENT) return { error: `最多同时执行 ${MAX_CONCURRENT} 个任务` }
    r.lastRunAt = Date.now()
    saveStore(store)
    void executeRoutine(store, r)
    return { ok: true }
  })

  ipcMain.handle('routines:running', () => [...running])
}

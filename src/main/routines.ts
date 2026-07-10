import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadSettings, apiKeyEnvVar, agentConfigDir } from './settings'
import { loadRpcClient, resolvePiCliPath } from './pi-client'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 例行任务(Routines):定时用独立 agent 会话执行一段 prompt,结果进收件箱。
 * 每次执行 spawn 一个全新的 RpcClient 子进程(独立 session),跑完即弃 ——
 * 绝不打扰用户当前打开的聊天会话。
 */

export type RoutineSchedule =
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string } // "09:00"
  | { type: 'weekly'; day: number; time: string } // day: 0=周日 … 6=周六

export type RoutineNotify = 'always' | 'error' | 'never'

export type Routine = {
  id: string
  name: string
  prompt: string
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  createdAt: number
  lastRunAt?: number
  /** 上次触发的时间槽(防止同一槽位重复触发,也让错过的槽当天补跑) */
  lastSlotKey?: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
  /** agent 最后一条回复(截断) */
  summary: string
  error?: string
}

type Store = { routines: Routine[]; runs: RoutineRun[] }

const RUN_TIMEOUT_MS = 20 * 60 * 1000
const MAX_RUNS_KEPT = 100
const MAX_CONCURRENT = 2

const storePath = (): string => join(app.getPath('userData'), 'routines.json')

function loadStore(): Store {
  try {
    if (existsSync(storePath())) {
      const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<Store>
      return { routines: raw.routines ?? [], runs: raw.runs ?? [] }
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

// ── 执行器:独立 RpcClient 会话 ────────────────────────────────────

const running = new Set<string>()

async function executeRoutine(store: Store, routine: Routine): Promise<void> {
  if (running.has(routine.id) || running.size >= MAX_CONCURRENT) return
  running.add(routine.id)
  const startedAt = Date.now()
  let status: RoutineRun['status'] = 'ok'
  let summary = ''
  let errorMsg: string | undefined

  try {
    const settings = loadSettings()
    if (!settings.apiKey) throw new Error('未配置 API Key')
    if (!existsSync(routine.workspacePath)) {
      throw new Error(`工作区不存在: ${routine.workspacePath}`)
    }

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

    try {
      await client.start()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          status = 'timeout'
          reject(new Error(`执行超时(${RUN_TIMEOUT_MS / 60000} 分钟)`))
        }, RUN_TIMEOUT_MS)
        const off = client.onEvent((e: { type?: string }) => {
          if (e?.type === 'agent_end') {
            clearTimeout(timer)
            off()
            resolve()
          }
        })
        client.prompt(routine.prompt).catch((err: unknown) => {
          clearTimeout(timer)
          off()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })

      const messages = (await client.getMessages()) as Array<{
        role?: string
        content?: Array<{ type?: string; text?: string }> | string
      }>
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'assistant') continue
        const text = Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : ''
        if (text.trim()) {
          summary = text.trim().slice(0, 4000)
          break
        }
      }
      if (!summary) summary = '(任务完成,无文本输出)'
    } finally {
      await client.stop().catch(() => {})
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

  const run: RoutineRun = {
    id: randomUUID(),
    routineId: routine.id,
    routineName: routine.name,
    startedAt,
    endedAt: Date.now(),
    status,
    summary,
    error: errorMsg,
  }
  store.runs = [run, ...store.runs].slice(0, MAX_RUNS_KEPT)
  saveStore(store)

  const shouldNotify =
    routine.notify === 'always' || (routine.notify === 'error' && status !== 'ok')
  if (shouldNotify && Notification.isSupported()) {
    new Notification({
      title: `例行任务${status === 'ok' ? '完成' : '失败'}: ${routine.name}`,
      body: (errorMsg ?? summary).slice(0, 150),
    }).show()
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
    (_e, routine: Partial<Routine> & Pick<Routine, 'name' | 'prompt' | 'workspacePath' | 'schedule' | 'notify'>) => {
      const existing = routine.id ? store.routines.find((r) => r.id === routine.id) : undefined
      if (existing) {
        Object.assign(existing, routine)
      } else {
        const fresh = {
          enabled: true,
          createdAt: Date.now(),
          ...routine,
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

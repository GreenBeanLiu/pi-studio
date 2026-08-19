import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

type RuntimeEvent = {
  type: string
  toolName?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  method?: string
}

type TodoItem = { status?: unknown }

function todoCounts(args: unknown): AgentStatusSnapshot['todo'] | null {
  if (!args || typeof args !== 'object') return null
  const items = (args as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const counts = { pending: 0, inProgress: 0, completed: 0 }
  for (const item of items as TodoItem[]) {
    if (item?.status === 'pending') counts.pending += 1
    else if (item?.status === 'in_progress') counts.inProgress += 1
    else if (item?.status === 'completed') counts.completed += 1
  }
  return counts
}

export type AgentStatusSnapshot = {
  version: 1
  cwd: string
  phase: 'idle' | 'running' | 'awaiting_approval' | 'stopped'
  prompt: string | null
  todo: { pending: number; inProgress: number; completed: number }
  tools: Record<string, number>
  failures: number
  repeatedFailures: number
  activeApprovals: number
  startedAt: number | null
  updatedAt: string
  loopDetected: string | null
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return [record.error, record.message, record.text, record.content].map(textOf).filter(Boolean).join('\n')
  }
  return String(value)
}

export class AgentStatusTracker {
  private readonly snap: AgentStatusSnapshot
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFailureSignature: string | null = null

  constructor(private readonly file: string, cwd: string) {
    this.snap = {
      version: 1,
      cwd,
      phase: 'idle',
      prompt: null,
      todo: { pending: 0, inProgress: 0, completed: 0 },
      tools: {},
      failures: 0,
      repeatedFailures: 0,
      activeApprovals: 0,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      loopDetected: null,
    }
    this.timer = setInterval(() => this.write(), 1_000)
    this.timer.unref?.()
  }

  snapshot(): AgentStatusSnapshot {
    return {
      ...this.snap,
      todo: { ...this.snap.todo },
      tools: { ...this.snap.tools },
    }
  }

  prompt(message: string): void {
    this.snap.prompt = message.slice(0, 500)
    this.snap.phase = 'running'
    this.snap.startedAt ??= Date.now()
    this.write()
  }

  approvalResolved(): void {
    this.snap.activeApprovals = Math.max(0, this.snap.activeApprovals - 1)
    if (this.snap.phase === 'awaiting_approval' && this.snap.activeApprovals === 0) {
      this.snap.phase = 'running'
    }
    this.write()
  }

  observe(event: RuntimeEvent): void {
    if (event.type === 'agent_start') {
      this.snap.phase = 'running'
      this.snap.startedAt = Date.now()
      this.snap.loopDetected = null
    } else if (event.type === 'agent_settled') {
      this.snap.phase = 'idle'
      this.snap.startedAt = null
      this.snap.activeApprovals = 0
    } else if (
      event.type === 'extension_ui_request' &&
      ['confirm', 'select', 'input', 'editor'].includes(event.method ?? '')
    ) {
      this.snap.phase = 'awaiting_approval'
      this.snap.activeApprovals += 1
    } else if (event.type === 'tool_execution_start' && event.toolName) {
      this.snap.tools[event.toolName] = (this.snap.tools[event.toolName] ?? 0) + 1
      if (event.toolName === 'update_agent_todo') {
        const todo = todoCounts(event.args)
        if (todo) this.snap.todo = todo
      }
    } else if (event.type === 'tool_execution_end') {
      if (event.isError) {
        this.snap.failures += 1
        const signature = `${event.toolName ?? 'tool'}:${textOf(event.result).trim().slice(0, 500)}`
        if (signature === this.lastFailureSignature) this.snap.repeatedFailures += 1
        else this.lastFailureSignature = signature
      } else {
        // Repeated failures are consecutive by definition. A successful tool
        // result breaks the sequence even if the same error appears later.
        this.lastFailureSignature = null
      }
    }
    this.write()
  }

  loopDetected(message: string): void {
    this.snap.loopDetected = message
    this.snap.phase = 'stopped'
    this.write()
  }

  write(): void {
    this.snap.updatedAt = new Date().toISOString()
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.snap), 'utf8')
      try {
        renameSync(temp, this.file)
      } catch {
        // Windows cannot rename over an existing file; the fallback keeps the
        // status channel best-effort and never blocks the agent run.
        rmSync(this.file, { force: true })
        renameSync(temp, this.file)
      }
    } catch {
      try { rmSync(temp, { force: true }) } catch { /* best effort cleanup */ }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { rmSync(this.file, { force: true }) } catch { /* best effort cleanup */ }
  }
}

export function formatAgentStatus(snapshot: AgentStatusSnapshot): string {
  const tools = Object.entries(snapshot.tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}=${count}`).join(', ')
  const todo = `pending=${snapshot.todo.pending}, in_progress=${snapshot.todo.inProgress}, completed=${snapshot.todo.completed}`
  return `<agent_status>\nphase: ${snapshot.phase}\nworkspace: ${snapshot.cwd}\nprompt: ${snapshot.prompt ?? '(none)'}\ntodo: ${todo}\ntool_calls: ${tools || '(none)'}\nfailures: ${snapshot.failures}\nrepeated_failures: ${snapshot.repeatedFailures}\nactive_approvals: ${snapshot.activeApprovals}\nloop_detected: ${snapshot.loopDetected ?? 'none'}\n</agent_status>`
}

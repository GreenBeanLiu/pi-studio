/**
 * main 边界的运行时校验(见 优化.md「所有跨进程输入都在 main 边界校验」)。
 *
 * 原则:renderer 传进来的值一律当 `unknown`。TypeScript 只约束我们自己的代码,
 * 约束不了实际到达 main 的数据 —— 契约错误直接抛 TypeError,由 handler 记日志并拒绝。
 *
 * 沿用 main/ipc-contracts.ts 已有的手写 parser 风格,暂不引入 schema 库。
 */
import { resolve, sep } from 'path'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}不能为空`)
  return value.trim()
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`)
  return value
}

/** 字符串必须落在给定枚举里,否则是契约错误。 */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label}无效`)
  }
  return value as T
}

/**
 * 路径是否被 root 包含。Windows 上大小写不敏感,所以统一小写后比较
 * (与 ipc.ts 的 git:showFile 同一套判断)。
 */
export function isContainedPath(target: string, root: string): boolean {
  const rootKey = resolve(root).toLowerCase()
  const targetKey = resolve(target).toLowerCase()
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}${sep}`)
}

/**
 * 解析一个必须位于 root 之内的路径,返回绝对路径。
 *
 * 关键点:是 main 决定路径安不安全,不是 renderer。renderer 只给一个字符串,
 * 越界(`..`、绝对路径、符号链接式的拼接)一律拒绝。
 */
export function parseContainedPath(value: unknown, root: string, label: string): string {
  const raw = requiredString(value, label)
  const target = resolve(root, raw)
  if (!isContainedPath(target, root)) throw new TypeError(`${label}超出允许范围`)
  return target
}

/** 会话文件:必须在会话目录内,且是 .jsonl —— 否则就是在拿删除接口删别的文件。 */
export function parseSessionPath(value: unknown, sessionDir: string, label = '会话路径'): string {
  const target = parseContainedPath(value, sessionDir, label)
  if (!target.toLowerCase().endsWith('.jsonl')) throw new TypeError(`${label}必须是会话文件`)
  return target
}

// ── Routine 写入对象 ─────────────────────────────────────────────────
// routines:save 原来直接 Object.assign(existing, routine),renderer 传什么并什么。
// 这里只放行已知字段,并把 schedule 逐种校验 —— 一个 {type:'interval',minutes:0}
// 会让调度器空转,一个未知字段会被原样持久化并同步上云。

export type ParsedRoutineSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

function boundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label}无效`)
  }
  return value
}

export function parseRoutineSchedule(value: unknown): ParsedRoutineSchedule {
  if (!isRecord(value)) throw new TypeError('调度配置无效')
  switch (value.type) {
    case 'manual':
      return { type: 'manual' }
    case 'interval':
      return { type: 'interval', minutes: boundedInt(value.minutes, 1, 7 * 24 * 60, '间隔分钟') }
    case 'hourly':
      return { type: 'hourly', minute: boundedInt(value.minute, 0, 59, '触发分钟') }
    case 'daily': {
      const time = requiredString(value.time, '触发时间')
      if (!TIME_RE.test(time)) throw new TypeError('触发时间必须是 HH:mm')
      return { type: 'daily', time }
    }
    case 'weekly': {
      const time = requiredString(value.time, '触发时间')
      if (!TIME_RE.test(time)) throw new TypeError('触发时间必须是 HH:mm')
      return { type: 'weekly', day: boundedInt(value.day, 0, 6, '星期'), time }
    }
    default:
      throw new TypeError('调度类型无效')
  }
}

export type ParsedRoutineSave = {
  id?: string
  name: string
  input?: string
  steps: unknown[]
  workspacePath: string
  schedule: ParsedRoutineSchedule
  notify: 'always' | 'error' | 'never'
  notifyChannelId?: string
  pushEachStep?: boolean
}

/** 只放行已知字段;steps 的逐项归一化仍由 routines.ts 的 normalizeStep 负责。 */
export function parseRoutineSave(value: unknown): ParsedRoutineSave {
  if (!isRecord(value)) throw new TypeError('工作流参数无效')
  if (!Array.isArray(value.steps)) throw new TypeError('步骤列表无效')
  const out: ParsedRoutineSave = {
    name: requiredString(value.name, '工作流名称'),
    steps: value.steps,
    workspacePath: requiredString(value.workspacePath, '工作区路径'),
    schedule: parseRoutineSchedule(value.schedule),
    notify: oneOf(value.notify, ['always', 'error', 'never'] as const, '通知策略'),
  }
  const id = optionalString(value.id, '工作流 ID')
  if (id) out.id = id
  const input = optionalString(value.input, '输入')
  if (input !== undefined) out.input = input
  const channel = optionalString(value.notifyChannelId, '通知渠道')
  if (channel !== undefined) out.notifyChannelId = channel
  if (value.pushEachStep !== undefined) {
    if (typeof value.pushEachStep !== 'boolean') throw new TypeError('逐步推送开关无效')
    out.pushEachStep = value.pushEachStep
  }
  return out
}

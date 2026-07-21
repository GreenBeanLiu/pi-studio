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

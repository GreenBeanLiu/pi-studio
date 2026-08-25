/**
 * ACP 会话在会话列表里的标识。
 *
 * pi 的会话用 jsonl 文件路径当键,外部 agent 没有那个文件 —— 会话存在 agent 那边。
 * 所以给它一套自己的命名空间,和文件路径明确区分开:`sessions:switch` 拿到值先看
 * 是不是这种键,是就走 ACP 那条路,否则才交给 parseSessionPath 做路径校验。
 *
 * 放在 shared 是因为 main 要用它路由、renderer 要用它判断哪些会话不能导出/重命名。
 */

export const ACP_SESSION_KEY_PREFIX = 'acp:'

/**
 * agentId 和 sessionId 的合法字符。
 *
 * 不许带冒号(解析会歧义),也不许出现 `..` 或路径分隔符 —— registry 的 agentId
 * 是 codex-acp 这种、sessionId 是 UUID,都用不到它们。这个值来自 renderer,
 * 万一哪天有人拿它拼路径,这里就是那个洞。
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/

function isSafeSegment(value: string): boolean {
  return SEGMENT.test(value) && !value.includes('..')
}

export type AcpSessionKeyParts = {
  agentId: string
  sessionId: string
}

export function acpSessionKey(agentId: string, sessionId: string): string {
  return `${ACP_SESSION_KEY_PREFIX}${agentId}:${sessionId}`
}

export function isAcpSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ACP_SESSION_KEY_PREFIX)
}

/**
 * 解析一个 ACP 会话键。形状不对就返回 null —— 这个值是从 renderer 传进来的,
 * 不能假设它是我们自己生成的那个。
 */
export function parseAcpSessionKey(value: unknown): AcpSessionKeyParts | null {
  if (!isAcpSessionKey(value)) return null
  const body = value.slice(ACP_SESSION_KEY_PREFIX.length)
  const separator = body.indexOf(':')
  if (separator <= 0) return null
  const agentId = body.slice(0, separator)
  const sessionId = body.slice(separator + 1)
  if (!isSafeSegment(agentId) || !isSafeSegment(sessionId)) return null
  return { agentId, sessionId }
}

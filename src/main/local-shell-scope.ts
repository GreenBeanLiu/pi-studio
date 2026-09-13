export type LocalShellPermission =
  | 'shell_read'
  | 'workspace_write'
  | 'git_push'
  | 'pull_request'
  | 'production_deploy'
  | 'destructive_command'

const READ_ONLY = [
  /^pwd$/i,
  /^git\s+status(?:\s+(?:--short|--branch|--porcelain(?:=v?\d+)?|-s|-b))*$/i,
]
const SHELL_COMPOSITION = /[;&|><`\n]|\$\(/
const GIT_PUSH = /^git\s+push(?:\s|$)/i
const PULL_REQUEST = /^gh\s+pr\s+(?:create|merge|close|reopen|edit)(?:\s|$)/i
const DEPLOY =
  /(?:^|[\s/\\])(?:deploy(?:\.sh|\.ps1)?|wrangler\s+deploy|kubectl\s+(?:apply|delete)|terraform\s+apply|systemctl\s+(?:restart|start|stop))(?:\s|$)/i
const DESTRUCTIVE =
  /(?:^|[;&|]\s*|\s)(?:rm\s+-[^\n]*[rf]|git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|drop\s+(?:database|table)|format\s+[a-z]:)(?:\s|$)/i

/**
 * Shell 不是可可靠静态分析的语言。这里只免审批两种精确的只读查询；无法证明
 * 安全的命令一律要求 destructive_command，避免脚本、重定向和子 shell 伪装成写工作区。
 */
export function requiredLocalShellPermission(command: unknown): LocalShellPermission {
  const value = typeof command === 'string' ? command.trim() : ''
  if (!value) throw new Error('arguments.command is required')
  if (READ_ONLY.some((pattern) => pattern.test(value))) return 'shell_read'
  if (SHELL_COMPOSITION.test(value)) return 'destructive_command'
  if (DESTRUCTIVE.test(value)) return 'destructive_command'
  if (DEPLOY.test(value)) return 'production_deploy'
  if (GIT_PUSH.test(value)) return 'git_push'
  if (PULL_REQUEST.test(value)) return 'pull_request'
  return 'destructive_command'
}

export function isLocalShellPermission(value: unknown): value is LocalShellPermission {
  return (
    value === 'shell_read' ||
    value === 'workspace_write' ||
    value === 'git_push' ||
    value === 'pull_request' ||
    value === 'production_deploy' ||
    value === 'destructive_command'
  )
}

import type {
  AgentMessage,
  GitDiffSnapshot,
  UserMessage,
  Workspace,
} from '../../../shared/ipc/contract'
import { firstLine, runStatusLabel, shortId, textOf, uniqueList } from './chat-format'
import type { MemorySuggestion, RunRecord, RunToolRecord } from './chat-types'

export function latestUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if ((message as { role?: string }).role !== 'user') continue
    return firstLine(textOf((message as UserMessage).content))
  }
  return ''
}

export function bashCommandOf(tool: RunToolRecord): string | null {
  if (tool.toolName !== 'bash') return null
  if (!tool.args || typeof tool.args !== 'object') return null
  const command = (tool.args as Record<string, unknown>).command
  return typeof command === 'string' ? firstLine(command, 160) : null
}

/** 一次运行结束后攒一条可写进 workspace memory 的会话小结;素材不足时返回 null。 */
export function buildMemorySuggestion(
  workspace: Workspace | null,
  messages: AgentMessage[],
  run: RunRecord | undefined,
  diff: GitDiffSnapshot | null,
): MemorySuggestion | null {
  const task = latestUserText(messages)
  const changedFiles = uniqueList(diff?.files.map((file) => file.path) ?? [], 8)
  const commands = uniqueList((run?.tools ?? []).map(bashCommandOf).filter((cmd): cmd is string => !!cmd), 5)
  const tools = uniqueList((run?.tools ?? []).map((tool) => tool.toolName), 8)

  if (!task && changedFiles.length === 0 && commands.length === 0 && tools.length === 0) {
    return null
  }

  const createdAt = new Date().toISOString()
  const lines = [
    `## Session Note - ${createdAt.slice(0, 10)}`,
    workspace?.name ? `- Workspace: ${workspace.name}` : null,
    task ? `- Task: ${task}` : null,
    run ? `- Outcome: ${runStatusLabel(run.status)}` : null,
    changedFiles.length > 0 ? `- Files changed: ${changedFiles.join(', ')}` : null,
    commands.length > 0 ? `- Commands used: ${commands.join(' | ')}` : null,
    tools.length > 0 ? `- Tools used: ${tools.join(', ')}` : null,
  ].filter((line): line is string => !!line)

  return {
    id: `${createdAt}:memory:${shortId()}`,
    createdAt,
    content: lines.join('\n'),
  }
}

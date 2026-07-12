import { mkdirSync, writeFileSync } from 'fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'path'

export type RoutineArtifactFormat = 'markdown' | 'html'

export type RoutineArtifact = {
  path: string
  format: RoutineArtifactFormat
  bytes: number
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[char]
  })
}

function inlineHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** Convert the predictable Markdown emitted by the article workflow to a WeChat-safe HTML fragment. */
export function markdownToWechatHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let listOpen = false

  const closeList = (): void => {
    if (!listOpen) return
    output.push('</ul>')
    listOpen = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      closeList()
      output.push(`<h2>${inlineHtml(heading[1])}</h2>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      if (!listOpen) {
        output.push('<ul>')
        listOpen = true
      }
      output.push(`<li>${inlineHtml(bullet[1])}</li>`)
      continue
    }
    closeList()
    output.push(`<p>${inlineHtml(line)}</p>`)
  }
  closeList()
  return output.join('\n')
}

function safeRelativePath(workspacePath: string, requestedPath: string): string {
  const raw = requestedPath.trim()
  if (!raw || isAbsolute(raw)) throw new Error('产物路径必须是工作区内的相对路径')
  const root = resolve(workspacePath)
  const target = resolve(root, raw)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('产物路径不能离开当前工作区')
  }
  return target
}

export function writeRoutineArtifact(
  workspacePath: string,
  requestedPath: string,
  format: RoutineArtifactFormat,
  content: string,
): RoutineArtifact {
  const target = safeRelativePath(workspacePath, requestedPath)
  const expectedExtension = format === 'html' ? '.html' : '.md'
  const finalPath = extname(target) ? target : `${target}${expectedExtension}`
  mkdirSync(dirname(finalPath), { recursive: true })
  const body = format === 'html' ? markdownToWechatHtml(content) : content
  writeFileSync(finalPath, body, 'utf8')
  return { path: finalPath, format, bytes: Buffer.byteLength(body, 'utf8') }
}

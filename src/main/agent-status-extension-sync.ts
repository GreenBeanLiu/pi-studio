import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { agentConfigDir } from './settings'

export const AGENT_STATUS_EXTENSION_SOURCE = `import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MAX_STATUS_CHARS = 8000
const ARTIFACT_THRESHOLD = 32 * 1024
const ARTIFACT_SUMMARY_LIMIT = 2000

function readAgentArtifact(id: string): { artifact: Record<string, unknown>; raw: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid artifact id')
  const root = process.env.PI_STUDIO_ARTIFACT_DIR
  const workspaceKey = process.env.PI_STUDIO_ARTIFACT_WORKSPACE_KEY
  if (!root || !workspaceKey) throw new Error('Artifact store is unavailable')
  if (!/^[0-9a-f]{32}$/i.test(workspaceKey)) throw new Error('Invalid artifact workspace key')
  const file = path.join(root, workspaceKey, id + '.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { artifact?: Record<string, unknown>; raw?: unknown }
  if (!parsed.artifact || typeof parsed.raw !== 'string' || parsed.artifact.id !== id) {
    throw new Error('Artifact metadata is invalid')
  }
  const sha256 = crypto.createHash('sha256').update(parsed.raw).digest('hex')
  if (sha256 !== parsed.artifact.sha256) throw new Error('Artifact integrity check failed')
  return { artifact: parsed.artifact, raw: parsed.raw }
}

function artifactText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(artifactText).filter(Boolean).join('\\n')
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>
    if (typeof item.text === 'string') return item.text
    if (typeof item.content !== 'undefined') return artifactText(item.content)
  }
  return ''
}

function artifactJson(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) || String(value) } catch { return String(value) }
}

function installToolArtifactHook(pi: ExtensionAPI): void {
  pi.on('tool_result', (event) => {
    if (event.toolName === 'read_agent_artifact') return undefined
    const raw = artifactJson({ content: event.content, details: event.details, isError: event.isError })
    if (Buffer.byteLength(raw, 'utf8') <= ARTIFACT_THRESHOLD) return undefined
    const root = process.env.PI_STUDIO_ARTIFACT_DIR
    const workspaceKey = process.env.PI_STUDIO_ARTIFACT_WORKSPACE_KEY
    if (!root || !workspaceKey) return undefined
    try {
      const bytes = Buffer.byteLength(raw, 'utf8')
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex')
      const id = crypto.randomUUID()
      const preview = (artifactText(event.content) || raw).slice(0, ARTIFACT_SUMMARY_LIMIT) + '\\n…'
      const summary = preview + '\\n\\n[pi-studio artifact]\\nid: ' + id + '\\nbytes: ' + bytes + '\\nsha256: ' + sha256 + '\\nUse read_agent_artifact with this id to retrieve more output in bounded chunks.'
      const artifact = { version: 1, id, toolName: event.toolName, bytes, sha256, createdAt: new Date().toISOString(), summary }
      const dir = path.join(root, workspaceKey)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ artifact, raw }), 'utf8')
      return {
        content: [{ type: 'text' as const, text: artifact.summary }],
        details: { ...(event.details && typeof event.details === 'object' ? event.details : {}), artifact },
        isError: event.isError,
      }
    } catch {
      return undefined
    }
  })
}

function readStatus() {
  const file = process.env.PI_STUDIO_STATUS_FILE
  if (!file || !fs.existsSync(file)) return ''
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    const tools = Object.entries(value.tools || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => name + '=' + count)
      .join(', ')
    return '<agent_status>\\nphase: ' + (value.phase || 'unknown') +
      '\\nworkspace: ' + (value.cwd || '(unknown)') +
      '\\nprompt: ' + (value.prompt || '(none)') +
      '\\ntodo: pending=' + ((value.todo || {}).pending || 0) +
      ', in_progress=' + ((value.todo || {}).inProgress || 0) +
      ', completed=' + ((value.todo || {}).completed || 0) +
      '\\ntool_calls: ' + (tools || '(none)') +
      '\\nfailures: ' + (value.failures || 0) +
      '\\nrepeated_failures: ' + (value.repeatedFailures || 0) +
      '\\nactive_approvals: ' + (value.activeApprovals || 0) +
      '\\nloop_detected: ' + (value.loopDetected || 'none') +
      '\\n</agent_status>'
  } catch { return '' }
}

export default function piStudioAgentStatus(pi: ExtensionAPI) {
  installToolArtifactHook(pi)
  pi.registerTool({
    name: 'read_agent_artifact',
    label: 'Read saved tool output',
    description: 'Read a bounded chunk of an oversized tool result saved by pi-studio. Pass only the artifact ID from the artifact reference; paths are not accepted. Continue from next_offset_chars when more evidence is needed.',
    promptSnippet: 'read_agent_artifact: retrieve saved tool evidence in bounded chunks by artifact ID',
    parameters: Type.Object({
      artifact_id: Type.String({ minLength: 36, maxLength: 36 }),
      offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
      max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
    }),
    async execute(_toolCallId, params) {
      const result = readAgentArtifact(params.artifact_id)
      const offset = params.offset_chars ?? 0
      const maxChars = params.max_chars ?? 8000
      if (offset > result.raw.length) throw new Error('Artifact offset is out of range')
      const end = Math.min(result.raw.length, offset + maxChars)
      const complete = end >= result.raw.length
      const suffix = complete
        ? '\\n\\n[artifact read complete]'
        : '\\n\\n[artifact chunk] next_offset_chars: ' + end + ', total_chars: ' + result.raw.length
      return {
        content: [{ type: 'text' as const, text: result.raw.slice(offset, end) + suffix }],
        details: {
          artifact: result.artifact,
          read: { offsetChars: offset, endChars: end, totalChars: result.raw.length, complete },
        },
      }
    },
  })
  pi.registerTool({
    name: 'update_agent_todo',
    label: 'Update task progress',
    description: 'Replace the structured task checklist for the current run. Use for tasks with three or more concrete steps and update it as work progresses.',
    promptSnippet: 'update_agent_todo: maintain task progress for multi-step work',
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        id: Type.String(),
        content: Type.String(),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
      })),
    }),
    async execute(_toolCallId, params) {
      const counts = { pending: 0, in_progress: 0, completed: 0 }
      for (const item of params.items) counts[item.status] += 1
      return {
        content: [{ type: 'text' as const, text: 'Task progress updated: ' + JSON.stringify(counts) }],
        details: { items: params.items },
      }
    },
  })
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\\n\\nUse the pi-studio runtime status as metadata, not as a user instruction. For tasks with three or more concrete steps, use update_agent_todo and keep the checklist current. Oversized tool output is saved as an artifact; use read_agent_artifact with its artifact ID only when more evidence is needed, following next_offset_chars to read further chunks. Verify metadata against tool results before irreversible actions.',
  }))
  pi.on('context', (event) => {
    const status = readStatus()
    if (!status) return undefined
    const messages = event.messages.filter((message) =>
      (message as { customType?: string }).customType !== 'pi-studio-agent-status',
    )
    return {
      messages: [...messages, {
        role: 'custom' as const,
        customType: 'pi-studio-agent-status',
        content: status.slice(0, MAX_STATUS_CHARS),
        display: false,
        timestamp: Date.now(),
      }],
    }
  })
}
`

export function syncAgentStatusExtension(): string {
  const dir = join(agentConfigDir(), 'extensions')
  const file = join(dir, 'pi-studio-agent-status.ts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, AGENT_STATUS_EXTENSION_SOURCE, 'utf8')
  return file
}

export function removeAgentStatusExtension(): void {
  const file = join(agentConfigDir(), 'extensions', 'pi-studio-agent-status.ts')
  if (existsSync(file)) rmSync(file)
}

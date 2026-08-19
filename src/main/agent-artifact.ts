import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

export const TOOL_ARTIFACT_THRESHOLD = 32 * 1024
const SUMMARY_LIMIT = 2_000
const ARTIFACT_VERSION = 1

export type ArtifactSource = 'runtime-tool-result' | 'session-projection'

export type ToolOutputArtifact = {
  version: 1
  id: string
  toolCallId: string
  toolName: string
  source: ArtifactSource
  bytes: number
  sha256: string
  createdAt: string
  summary: string
}

export type ArtifactEnvelope = {
  __piStudioArtifact: true
  artifact: ToolOutputArtifact
}

type ToolResultLike = {
  content?: unknown
  details?: unknown
  [key: string]: unknown
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>
    if (typeof item.text === 'string') return item.text
    if (typeof item.content !== 'undefined') return textOf(item.content)
  }
  return ''
}

function jsonOf(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function shortSummary(raw: string): string {
  const compact = raw.replace(/\r\n?/g, '\n')
  return compact.length > SUMMARY_LIMIT
    ? `${compact.slice(0, SUMMARY_LIMIT)}\n…`
    : compact
}

function artifactReference(
  preview: string,
  id: string,
  bytes: number,
  sha256: string,
): string {
  return `${preview}\n\n[pi-studio artifact]\nid: ${id}\nbytes: ${bytes}\nsha256: ${sha256}\nUse read_agent_artifact with this id to retrieve more output in bounded chunks.`
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** Create a UUID-shaped call identity so repeated projection loads reuse one file. */
export function stableArtifactId(toolCallId: string, toolName: string, sha256: string): string {
  const identity = toolCallId === 'unknown' ? `${toolCallId}\u0000${sha256}` : toolCallId
  const bytes = createHash('sha256')
    .update(identity)
    .update('\u0000')
    .update(toolName)
    .digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function envelopeOf(value: unknown): ArtifactEnvelope | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ArtifactEnvelope>
  return candidate.__piStudioArtifact === true && candidate.artifact?.version === 1
    ? (value as ArtifactEnvelope)
    : null
}

function artifactInResult(value: unknown): ToolOutputArtifact | null {
  if (!value || typeof value !== 'object') return null
  const item = value as ToolResultLike & { artifact?: unknown }
  const direct = envelopeOf(item.artifact)?.artifact
  if (direct) return direct
  if (item.details && typeof item.details === 'object') {
    const nested = (item.details as { artifact?: unknown }).artifact
    return envelopeOf(nested)?.artifact ?? null
  }
  return null
}

/**
 * Keeps full tool evidence outside the conversation/projection payload while
 * retaining a small, content-addressed reference in the latter.
 *
 * The store is deliberately independent from Electron so it can be tested in
 * isolation and used by the main-process event boundary and cold projection
 * loader alike.
 */
export class AgentArtifactStore {
  constructor(private readonly root: string) {}

  private directory(workspace: string): string {
    // Artifact files are scoped to a workspace. The random id plus integrity
    // check prevents cross-session guessing, while this also lets the Pi
    // subprocess write through the same directory when it runs in a sandbox.
    return join(this.root, safeKey(workspace))
  }

  write(
    workspace: string,
    toolCallId: string,
    toolName: string,
    value: unknown,
    source: ArtifactSource = 'runtime-tool-result',
  ): ToolOutputArtifact {
    const raw = jsonOf(value)
    const bytes = Buffer.byteLength(raw, 'utf8')
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const id = stableArtifactId(toolCallId, toolName, sha256)
    const dir = this.directory(workspace)
    mkdirSync(dir, { recursive: true })
    try {
      const existing = readAgentArtifactFile(this.root, safeKey(workspace), id)
      if (existing.artifact.sha256 === sha256) return existing.artifact
    } catch {
      // Missing or corrupt entries are safely replaced below.
    }
    const artifact: ToolOutputArtifact = {
      version: ARTIFACT_VERSION,
      id,
      toolCallId,
      toolName,
      source,
      bytes,
      sha256,
      createdAt: new Date().toISOString(),
      summary: artifactReference(shortSummary(textOf(value) || raw), id, bytes, sha256),
    }
    writeFileSync(join(dir, `${artifact.id}.json`), JSON.stringify({ artifact, raw }), 'utf8')
    // The metadata is intentionally returned, not the host path. Host paths
    // must never enter model context or be exposed to a sandboxed agent.
    return artifact
  }

  read(workspace: string, id: string): { artifact: ToolOutputArtifact; raw: string } {
    return readAgentArtifactFile(this.root, safeKey(workspace), id)
  }

  /** Replace only oversized completed tool results. Small results retain Pi's original shape. */
  materializeResult(
    workspace: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    source: ArtifactSource = 'runtime-tool-result',
  ): unknown {
    if (artifactInResult(result)) return result
    const bytes = Buffer.byteLength(jsonOf(result), 'utf8')
    if (bytes <= TOOL_ARTIFACT_THRESHOLD) return result
    const artifact = this.write(workspace, toolCallId, toolName, result, source)
    const original = result && typeof result === 'object' ? (result as ToolResultLike) : null
    return {
      ...(original ?? {}),
      content: [{ type: 'text', text: artifact.summary }],
      details: {
        ...(original?.details && typeof original.details === 'object' ? original.details : {}),
        artifact,
      },
      artifact: { __piStudioArtifact: true, artifact },
    }
  }

  materializeMessages(
    workspace: string,
    messages: unknown[],
  ): unknown[] {
    return messages.map((message) => {
      if (!message || typeof message !== 'object' || (message as { role?: string }).role !== 'toolResult') {
        return message
      }
      const item = message as Record<string, unknown>
      if (envelopeOf(item.artifact) || envelopeOf(item.details && { __piStudioArtifact: true, artifact: (item.details as Record<string, unknown>).artifact })) {
        return message
      }
      return this.materializeResult(
        workspace,
        String(item.toolCallId ?? 'unknown'),
        String(item.toolName ?? 'tool'),
        item,
        'session-projection',
      )
    })
  }
}

export function artifactWorkspaceKey(workspace: string): string {
  return safeKey(workspace)
}

export function readAgentArtifactFile(
  root: string,
  workspaceKey: string,
  id: string,
): { artifact: ToolOutputArtifact; raw: string } {
  if (!/^[0-9a-f]{32}$/i.test(workspaceKey)) throw new Error('Invalid artifact workspace key')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid artifact id')
  }
  const file = join(root, workspaceKey, `${basename(id)}.json`)
  if (!existsSync(file)) throw new Error('Artifact not found')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { artifact?: ToolOutputArtifact; raw?: unknown }
  if (!parsed.artifact || typeof parsed.raw !== 'string' || parsed.artifact.id !== id) {
    throw new Error('Artifact metadata is invalid')
  }
  const digest = createHash('sha256').update(parsed.raw).digest('hex')
  if (digest !== parsed.artifact.sha256) throw new Error('Artifact integrity check failed')
  return { artifact: parsed.artifact, raw: parsed.raw }
}

/** Normalize a runtime event without mutating the Pi event object. */
export function materializeToolEvent(
  store: AgentArtifactStore,
  workspace: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (event.type !== 'tool_execution_end') return event
  try {
    return {
      ...event,
      result: store.materializeResult(
        workspace,
        String(event.toolCallId ?? 'unknown'),
        String(event.toolName ?? 'tool'),
        event.result,
        'runtime-tool-result',
      ),
    }
  } catch {
    // Artifact persistence is observability only. A disk or permission error
    // must leave the original tool result available to the agent/UI.
    return event
  }
}

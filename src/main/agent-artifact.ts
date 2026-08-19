import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

export const TOOL_ARTIFACT_THRESHOLD = 32 * 1024
const SUMMARY_LIMIT = 2_000
const ARTIFACT_VERSION = 1

export type ToolOutputArtifact = {
  version: 1
  id: string
  toolName: string
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
    ? `${compact.slice(0, SUMMARY_LIMIT)}\n… (完整输出见 artifact)`
    : compact
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function envelopeOf(value: unknown): ArtifactEnvelope | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ArtifactEnvelope>
  return candidate.__piStudioArtifact === true && candidate.artifact?.version === 1
    ? (value as ArtifactEnvelope)
    : null
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
  ): ToolOutputArtifact {
    const raw = jsonOf(value)
    const bytes = Buffer.byteLength(raw, 'utf8')
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const createdAt = new Date().toISOString()
    const artifact: ToolOutputArtifact = {
      version: ARTIFACT_VERSION,
      id: randomUUID(),
      toolName,
      bytes,
      sha256,
      createdAt,
      summary: shortSummary(textOf(value) || raw),
    }
    const dir = this.directory(workspace)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${artifact.id}.json`), JSON.stringify({ artifact, raw }), 'utf8')
    // The metadata is intentionally returned, not the host path. Host paths
    // must never enter model context or be exposed to a sandboxed agent.
    void toolCallId
    return artifact
  }

  read(workspace: string, id: string): { artifact: ToolOutputArtifact; raw: string } {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid artifact id')
    const file = join(this.directory(workspace), `${basename(id)}.json`)
    if (!existsSync(file)) throw new Error('Artifact not found')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { artifact?: ToolOutputArtifact; raw?: unknown }
    if (!parsed.artifact || typeof parsed.raw !== 'string' || parsed.artifact.id !== id) {
      throw new Error('Artifact metadata is invalid')
    }
    const digest = createHash('sha256').update(parsed.raw).digest('hex')
    if (digest !== parsed.artifact.sha256) throw new Error('Artifact integrity check failed')
    return { artifact: parsed.artifact, raw: parsed.raw }
  }

  /** Replace only oversized completed tool results. Small results retain Pi's original shape. */
  materializeResult(
    workspace: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
  ): unknown {
    const existing = envelopeOf(result)
    if (existing) return result
    const bytes = Buffer.byteLength(jsonOf(result), 'utf8')
    if (bytes <= TOOL_ARTIFACT_THRESHOLD) return result
    const artifact = this.write(workspace, toolCallId, toolName, result)
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
      )
    })
  }
}

export function artifactWorkspaceKey(workspace: string): string {
  return safeKey(workspace)
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
      ),
    }
  } catch {
    // Artifact persistence is observability only. A disk or permission error
    // must leave the original tool result available to the agent/UI.
    return event
  }
}

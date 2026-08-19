import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_UI_CHUNK_CHARS,
  AgentArtifactStore,
  TOOL_ARTIFACT_THRESHOLD,
  artifactWorkspaceKey,
  stableArtifactId,
} from './agent-artifact'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AgentArtifactStore', () => {
  it('keeps small tool results unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const result = { content: [{ type: 'text', text: 'small' }], details: { ok: true } }
    expect(store.materializeResult('workspace', 'call', 'read', result)).toBe(result)
  })

  it('stores oversized results and returns a short verified reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const rawText = 'x'.repeat(TOOL_ARTIFACT_THRESHOLD + 10)
    const result = { content: [{ type: 'text', text: rawText }], details: { source: 'test' } }
    const compact = store.materializeResult('workspace', 'call', 'bash', result) as {
      content: Array<{ text: string }>
      details: { artifact: { id: string; bytes: number; toolCallId: string; source: string } }
      artifact: { __piStudioArtifact: boolean }
    }

    expect(compact.content[0].text.length).toBeLessThan(rawText.length)
    expect(compact.details.artifact.bytes).toBeGreaterThan(TOOL_ARTIFACT_THRESHOLD)
    expect(compact.content[0].text).toContain(`id: ${compact.details.artifact.id}`)
    expect(compact.content[0].text).toContain('sha256: ')
    expect(compact.content[0].text).toContain('Use read_agent_artifact')
    expect(compact.artifact.__piStudioArtifact).toBe(true)
    expect(compact.details.artifact.toolCallId).toBe('call')
    expect(compact.details.artifact.source).toBe('runtime-tool-result')
    const restored = store.read('workspace', compact.details.artifact.id)
    expect(restored.raw).toContain(rawText)
  })

  it('does not wrap an artifact returned by the runtime hook a second time', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const value = 'x'.repeat(TOOL_ARTIFACT_THRESHOLD + 1)
    const first = store.materializeResult('workspace', 'call', 'bash', value) as {
      details: { artifact: { id: string } }
      artifact: { __piStudioArtifact: true }
    }
    const runtimeResult = {
      content: [{ type: 'text', text: first.details.artifact.id }],
      details: { artifact: first.details.artifact },
    }
    expect(store.materializeResult('workspace', 'call', 'bash', runtimeResult)).toBe(runtimeResult)
  })

  it('reuses a stable artifact for repeated materialization', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const value = 'x'.repeat(TOOL_ARTIFACT_THRESHOLD + 1)
    const first = store.materializeResult('workspace', 'call', 'bash', value) as {
      details: { artifact: { id: string; createdAt: string } }
    }
    const second = store.materializeResult('workspace', 'call', 'bash', value) as {
      details: { artifact: { id: string; createdAt: string } }
    }
    expect(second.details.artifact.id).toBe(first.details.artifact.id)
    expect(second.details.artifact.createdAt).toBe(first.details.artifact.createdAt)
    expect(stableArtifactId('call', 'bash', 'digest')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('returns bounded UI chunks without accumulating the complete output', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const raw = 'x'.repeat(ARTIFACT_UI_CHUNK_CHARS + 123)
    const artifact = store.write('workspace', 'call', 'bash', raw)
    const first = store.readChunk('workspace', artifact.id, 0)
    expect(first.text).toHaveLength(ARTIFACT_UI_CHUNK_CHARS)
    expect(first).toMatchObject({
      offsetChars: 0,
      endChars: ARTIFACT_UI_CHUNK_CHARS,
      totalChars: raw.length,
      complete: false,
    })
    const second = store.readChunk('workspace', artifact.id, first.endChars)
    expect(second.text).toHaveLength(123)
    expect(second.complete).toBe(true)
    expect(() => store.readChunk('workspace', artifact.id, raw.length + 1)).toThrow(
      'Artifact offset is out of range',
    )
    expect(() => store.readChunk('workspace', artifact.id, -1)).toThrow(
      'Artifact offset must be a non-negative safe integer',
    )
  })

  it('prunes oldest artifacts by count while preserving a protected artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root, {
      maxFiles: 2,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      pruneIntervalMs: 60_000,
    })
    const ids = ['first', 'second', 'third'].map((call) =>
      store.write('workspace', call, 'bash', `${call}-${'x'.repeat(100)}`).id,
    )
    const dir = join(root, artifactWorkspaceKey('workspace'))
    ids.forEach((id, index) => {
      const timestamp = new Date(Date.now() - (ids.length - index) * 1_000)
      utimesSync(join(dir, `${id}.json`), timestamp, timestamp)
    })
    store.prune('workspace', new Set([ids[2]]))
    const remaining = readdirSync(dir).map((file) => file.replace(/\.json$/, ''))
    expect(remaining).toHaveLength(2)
    expect(remaining).not.toContain(ids[0])
    expect(remaining).toContain(ids[2])
  })

  it('prunes expired artifacts and reports reclaimed bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root, {
      maxFiles: 10,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 1_000,
      pruneIntervalMs: 60_000,
    })
    const old = store.write('workspace', 'old', 'read', 'old evidence')
    const oldFile = join(root, artifactWorkspaceKey('workspace'), `${old.id}.json`)
    const expired = new Date(Date.now() - 2_000)
    utimesSync(oldFile, expired, expired)
    const current = store.write('workspace', 'current', 'read', 'current evidence')
    const result = store.prune('workspace', new Set([current.id]))
    expect(result.removedFiles).toBe(1)
    expect(result.removedBytes).toBeGreaterThan(0)
    expect(() => store.read('workspace', old.id)).toThrow('Artifact not found')
    expect(store.read('workspace', current.id).raw).toBe('current evidence')
  })

  it('rejects artifact content that no longer matches its digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const compact = store.materializeResult(
      'workspace',
      'call',
      'bash',
      'x'.repeat(TOOL_ARTIFACT_THRESHOLD + 1),
    ) as { details: { artifact: { id: string } } }
    const id = compact.details.artifact.id
    const file = join(root, artifactWorkspaceKey('workspace'), `${id}.json`)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { raw: string }
    stored.raw = `${stored.raw}tampered`
    writeFileSync(file, JSON.stringify(stored), 'utf8')
    expect(() => store.read('workspace', id)).toThrow('Artifact integrity check failed')
  })

  it('rejects artifact metadata with an incorrect byte count', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const artifact = store.write('workspace', 'call', 'read', 'evidence')
    const file = join(root, artifactWorkspaceKey('workspace'), `${artifact.id}.json`)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { artifact: { bytes: number } }
    stored.artifact.bytes += 1
    writeFileSync(file, JSON.stringify(stored), 'utf8')
    expect(() => store.read('workspace', artifact.id)).toThrow('Artifact metadata is invalid')
  })

  it('isolates artifacts by workspace and session and rejects invalid ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-studio-artifact-'))
    roots.push(root)
    const store = new AgentArtifactStore(root)
    const result = store.materializeResult('a', 'call', 'read', 'x'.repeat(TOOL_ARTIFACT_THRESHOLD + 1)) as {
      details: { artifact: { id: string } }
    }
    expect(() => store.read('b', result.details.artifact.id)).toThrow('Artifact not found')
    expect(() => store.read('a', '../outside')).toThrow('Invalid artifact id')
  })
})

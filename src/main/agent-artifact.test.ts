import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentArtifactStore,
  TOOL_ARTIFACT_THRESHOLD,
  artifactWorkspaceKey,
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
      details: { artifact: { id: string; bytes: number } }
      artifact: { __piStudioArtifact: boolean }
    }

    expect(compact.content[0].text.length).toBeLessThan(rawText.length)
    expect(compact.details.artifact.bytes).toBeGreaterThan(TOOL_ARTIFACT_THRESHOLD)
    expect(compact.content[0].text).toContain(`id: ${compact.details.artifact.id}`)
    expect(compact.content[0].text).toContain('sha256: ')
    expect(compact.content[0].text).toContain('Use read_agent_artifact')
    expect(compact.artifact.__piStudioArtifact).toBe(true)
    const restored = store.read('workspace', compact.details.artifact.id)
    expect(restored.raw).toContain(rawText)
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

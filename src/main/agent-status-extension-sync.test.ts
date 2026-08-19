import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_EXTENSION_SOURCE } from './agent-status-extension-sync'

describe('pi-studio agent status extension source', () => {
  it('is valid TypeScript after being generated', () => {
    const result = ts.transpileModule(AGENT_STATUS_EXTENSION_SOURCE, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
    expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('registers a workspace-scoped artifact reader that accepts IDs rather than paths', () => {
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("name: 'read_agent_artifact'")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('artifact_id: Type.String')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('PI_STUDIO_ARTIFACT_WORKSPACE_KEY')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("throw new Error('Artifact integrity check failed')")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain("'\\nUse read_agent_artifact with this id")
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('max_chars: Type.Optional')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('maximum: 12000')
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain('next_offset_chars')
    expect(AGENT_STATUS_EXTENSION_SOURCE).not.toContain('file_path: Type.String')
  })

  it('does not artifactize the artifact reader result again', () => {
    expect(AGENT_STATUS_EXTENSION_SOURCE).toContain(
      "if (event.toolName === 'read_agent_artifact') return undefined",
    )
  })
})

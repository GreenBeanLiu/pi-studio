import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  getWorkspacePath: vi.fn(),
  bash: vi.fn(),
}))

vi.mock('./pi-client', () => ({
  piClientManager: {
    getWorkspacePath: mocks.getWorkspacePath,
    bash: mocks.bash,
  },
}))

import { executeLocalToolOperation, TOOL_GATEWAY_MANIFEST } from './tool-gateway'

const FIXTURES_DIR = join(process.cwd(), 'docs/contracts/fixtures')
const SCHEMAS_DIR = join(process.cwd(), 'docs/contracts/schemas')

const ERROR_CODES = [
  'INVALID_TOOL_OPERATION',
  'INVALID_TOOL_ARGUMENTS',
  'UNSUPPORTED_TOOL',
  'UNSUPPORTED_TOOL_PROTOCOL',
  'INVALID_DEADLINE',
  'DEADLINE_EXPIRED',
  'SCOPE_MISMATCH',
  'WORKSPACE_MISMATCH',
  'EEXIST',
  'ENOENT',
  'LOCAL_FILE_ERROR',
] as const

const ToolErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
})

const ToolOperationRequestSchema = z
  .object({
    contract_version: z.literal(1),
    protocol_version: z.union([z.literal(1), z.literal(2)]),
    operation_id: z.string().min(1),
    task_id: z.string().min(1),
    subtask_id: z.string().min(1),
    call_id: z.string().min(1),
    source: z.string().min(1),
    target_id: z.string().min(1),
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    idempotency_key: z.string().min(1).optional(),
    deadline_at: z.string().min(1).optional(),
    scope: z
      .object({
        workspace: z.string().min(1).optional(),
        permissions: z.array(z.string().min(1)).optional(),
        permission: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    audit: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.protocol_version !== 2) return
    if (!value.idempotency_key) {
      ctx.addIssue({ code: 'custom', message: 'v2 requires idempotency_key', path: ['idempotency_key'] })
    }
    if (!value.deadline_at) {
      ctx.addIssue({ code: 'custom', message: 'v2 requires deadline_at', path: ['deadline_at'] })
    }
    if (!value.scope?.workspace) {
      ctx.addIssue({ code: 'custom', message: 'v2 requires scope.workspace', path: ['scope', 'workspace'] })
    }
    if (!value.scope?.permissions) {
      ctx.addIssue({ code: 'custom', message: 'v2 requires scope.permissions', path: ['scope', 'permissions'] })
    }
  })

const ToolOperationResultSchema = z
  .object({
    contract_version: z.literal(1),
    protocol_version: z.union([z.literal(1), z.literal(2)]),
    operation_id: z.string().min(1),
    task_id: z.string().min(1),
    subtask_id: z.string().min(1),
    call_id: z.string().min(1),
    source: z.string().min(1),
    target_id: z.string().min(1),
    tool_name: z.string().min(1),
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()),
    error: ToolErrorSchema.nullable(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.ok && value.error !== null) {
      ctx.addIssue({ code: 'custom', message: 'ok:true requires error:null', path: ['error'] })
    }
    if (!value.ok && value.error === null) {
      ctx.addIssue({ code: 'custom', message: 'ok:false requires error object', path: ['error'] })
    }
  })

const ToolCapabilitiesSchema = z
  .object({
    manifest_version: z.literal(1),
    operation_protocols: z.array(z.union([z.literal(1), z.literal(2)])).min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            scope_version: z.number().int().min(1),
            requires_workspace: z.boolean(),
            max_bytes: z.number().int().min(1).optional(),
            max_entries: z.number().int().min(1).optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()

const ResumeEnvelopeSchema = z
  .object({
    operation_id: z.string().min(1),
    call_id: z.string().min(1),
    tool_name: z.string().min(1),
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()),
    error: ToolErrorSchema.nullable(),
  })
  .passthrough()

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

describe('Tool Gateway Contract SoT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps JSON Schema files checked in for cross-repo consumers', () => {
    const expected = [
      'tool-capabilities.schema.json',
      'tool-operation-request.schema.json',
      'tool-operation-result.schema.json',
      'resume-envelope.schema.json',
    ]
    const present = readdirSync(SCHEMAS_DIR).sort()
    expect(present).toEqual(expected.sort())
  })

  it('validates positive fixtures against the TS contract mirror', () => {
    expect(ToolCapabilitiesSchema.safeParse(readJson(join(FIXTURES_DIR, 'tool-capabilities-v1.json'))).success).toBe(true)
    expect(
      ToolOperationRequestSchema.safeParse(readJson(join(FIXTURES_DIR, 'tool-operation-v2-request.json'))).success,
    ).toBe(true)
    expect(
      ToolOperationResultSchema.safeParse(readJson(join(FIXTURES_DIR, 'tool-operation-v2-result.json'))).success,
    ).toBe(true)
    expect(
      ToolOperationResultSchema.safeParse(readJson(join(FIXTURES_DIR, 'tool-operation-v2-result-error.json'))).success,
    ).toBe(true)
    expect(
      ResumeEnvelopeSchema.safeParse(readJson(join(FIXTURES_DIR, 'tool-operation-resume-envelope.json'))).success,
    ).toBe(true)
  })

  it('maps the desktop capability manifest onto the canonical capabilities shape', () => {
    const canonical = {
      manifest_version: TOOL_GATEWAY_MANIFEST.manifestVersion,
      operation_protocols: [...TOOL_GATEWAY_MANIFEST.operationProtocols],
      tools: TOOL_GATEWAY_MANIFEST.tools.map((tool) => ({
        name: tool.name,
        scope_version: tool.scopeVersion,
        requires_workspace: tool.requiresWorkspace,
        ...('maxBytes' in tool ? { max_bytes: tool.maxBytes } : {}),
        ...('maxEntries' in tool ? { max_entries: tool.maxEntries } : {}),
      })),
    }
    expect(ToolCapabilitiesSchema.safeParse(canonical).success).toBe(true)
  })

  it('rejects scope-mismatch fixture at the tool gateway boundary', async () => {
    mocks.getWorkspacePath.mockReturnValue('/Users/example/Works/demo')
    const fixture = readJson(join(FIXTURES_DIR, 'tool-operation-v2-request-scope-mismatch.json')) as Record<
      string,
      unknown
    >
    await expect(executeLocalToolOperation(fixture)).resolves.toMatchObject({
      code: 'SCOPE_MISMATCH',
    })
  })

  it('ignores unknown optional fields on a valid v2 request', async () => {
    mocks.getWorkspacePath.mockReturnValue('/workspace')
    const reply = await executeLocalToolOperation({
      operation_id: 'toolop-unknown-fields',
      tool_name: 'local.read',
      protocol_version: 2,
      deadline_at: '2099-01-01T00:00:00Z',
      arguments: { workspace: '/workspace', path: 'missing.txt' },
      scope: { workspace: '/workspace', permissions: ['local.read'] },
      future_optional_field: { nested: true },
    })
    expect(reply).toMatchObject({ code: 'ENOENT' })
  })
})

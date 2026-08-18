import { createHash, randomUUID } from 'crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { StudioAgentEvent } from '../shared/ipc/contract'
import { SessionProjectionTracker } from './session-projection'
import { terminateProcessTree } from './process-tree'

const execFileAsync = promisify(execFile)
export const EVAL_WORKSPACE_TOKEN = '${PI_STUDIO_EVAL_WORKSPACE}'

export type EvalEngineProfile = {
  type: 'pi'
  provider: string
  model?: string
  security: 'host-full-access'
  env?: Record<string, { fromEnv: string }>
  args?: string[]
}

export type EvalGrader =
  | { type: 'exit-code'; expected: number }
  | { type: 'file'; path: string; exists?: boolean; contains?: string; equals?: string }
  | {
      type: 'command'
      executable: string
      args?: string[]
      expectedExitCode?: number
      timeoutMs?: number
      env?: Record<string, { fromEnv: string }>
    }
  | { type: 'diff'; allow?: string[]; deny?: string[]; maxChangedFiles?: number }

export type EvalCase = {
  version: 1
  id: string
  fixture: string
  prompt: string
  engine: EvalEngineProfile
  timeoutMs: number
  graders: EvalGrader[]
  artifacts?: string[]
}

export type EvalEngineEvent = {
  raw: Record<string, unknown>
  normalized?: StudioAgentEvent
  /** Replay-only monotonic timestamp retained from the recording. */
  recordedAtMs?: number
  /** Wall-clock timestamp used by the projector for stable replay fields. */
  observedAt?: string
}

export type EvalEngineResult = {
  finalResponse: string
  finishReason: 'settled' | 'error' | 'timeout' | 'cancelled'
  exitCode: number
  sessionId: string
  messages?: unknown[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
  }
  error?: string
}

export type EvalEngineRequest = {
  caseId: string
  workspacePath: string
  sessionId: string
  prompt: string
  profile: EvalEngineProfile
  timeoutMs: number
}

export interface EvalEngine {
  run(
    request: EvalEngineRequest,
    emit: (event: EvalEngineEvent) => void,
    signal: AbortSignal,
  ): Promise<EvalEngineResult>
  /** Resolve only after this run can no longer mutate its workspace or emit events. */
  cleanup(): Promise<void>
}

export type EvalEventFrame = Omit<EvalEngineEvent, 'recordedAtMs'> & { atMs: number; observedAt: string }

export type WorkspaceChange = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  beforeHash?: string
  afterHash?: string
}

export type EvalGraderResult = {
  grader: EvalGrader
  passed: boolean
  message: string
  details?: unknown
}

export type EvalRunReport = {
  version: 1
  caseId: string
  sessionId: string
  workspacePath: string
  startedAt: string
  durationMs: number
  finalResponse: string
  finishReason: EvalEngineResult['finishReason']
  exitCode: number
  usage?: EvalEngineResult['usage']
  messages?: unknown[]
  error?: string
  events: EvalEventFrame[]
  toolCalls: unknown[]
  workspaceDiff: WorkspaceChange[]
  artifacts: string[]
  graders: EvalGraderResult[]
  passed: boolean
}

export type EvalRecording = {
  version: 1
  caseId: string
  engineResult: EvalEngineResult
  events: EvalEventFrame[]
  replay?: {
    providerSteps: Array<
      | { kind: 'recorded-stream' }
      | { kind: 'throw'; message: string }
      | { kind: 'hang' }
      | { kind: 'cancel'; message?: string }
    >
  }
}

type WorkspaceSnapshot = Map<string, string>

export class EvalCaseValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalCaseValidationError'
  }
}

export class EvalTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Evaluation did not settle within ${timeoutMs}ms`)
    this.name = 'EvalTimeoutError'
  }
}

export class EvalWorkspaceOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EvalWorkspaceOwnershipError'
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecordedUsage(value: unknown): boolean {
  const usage = objectValue(value)
  const cost = objectValue(usage?.cost)
  return !!usage && !!cost &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((field) =>
      typeof usage[field] === 'number' && Number.isFinite(usage[field])) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((field) =>
      typeof cost[field] === 'number' && Number.isFinite(cost[field]))
}

function isRecordedContent(value: unknown, allowed: readonly string[]): boolean {
  const content = objectValue(value)
  if (!content || typeof content.type !== 'string' || !allowed.includes(content.type)) return false
  if (content.type === 'text') return typeof content.text === 'string'
  if (content.type === 'thinking') return typeof content.thinking === 'string'
  if (content.type === 'image') return typeof content.data === 'string' && typeof content.mimeType === 'string'
  return content.type === 'toolCall' && typeof content.id === 'string' && typeof content.name === 'string' && !!objectValue(content.arguments)
}

function isRecordedAssistantMessage(value: unknown): boolean {
  const message = objectValue(value)
  return !!message && message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.every((content) => isRecordedContent(content, ['text', 'thinking', 'image', 'toolCall'])) &&
    typeof message.api === 'string' && typeof message.provider === 'string' && typeof message.model === 'string' &&
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) &&
    typeof message.stopReason === 'string' && ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason) &&
    isRecordedUsage(message.usage)
}

function isRecordedAgentMessage(value: unknown): boolean {
  const message = objectValue(value)
  if (!message || typeof message.role !== 'string' || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
    return false
  }
  if (message.role === 'assistant') return isRecordedAssistantMessage(message)
  if (message.role === 'user') {
    return typeof message.content === 'string' || (
      Array.isArray(message.content) && message.content.every((content) => isRecordedContent(content, ['text', 'image']))
    )
  }
  if (message.role === 'toolResult') {
    return typeof message.toolCallId === 'string' && typeof message.toolName === 'string' &&
      typeof message.isError === 'boolean' && Array.isArray(message.content) &&
      message.content.every((content) => isRecordedContent(content, ['text', 'image']))
  }
  return false
}

function assertRelativeCasePath(path: string, label: string): void {
  const normalized = normalize(path)
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new EvalCaseValidationError(`${label} must stay within the evaluation workspace`)
  }
}

function parseGrader(value: unknown, index: number): EvalGrader {
  const item = objectValue(value)
  if (!item || typeof item.type !== 'string') {
    throw new EvalCaseValidationError(`graders[${index}] must be an object with a type`)
  }
  if (item.type === 'exit-code' && typeof item.expected === 'number') {
    return { type: 'exit-code', expected: item.expected }
  }
  if (item.type === 'file' && typeof item.path === 'string') {
    assertRelativeCasePath(item.path, `graders[${index}].path`)
    return {
      type: 'file',
      path: item.path,
      ...(typeof item.exists === 'boolean' ? { exists: item.exists } : {}),
      ...(typeof item.contains === 'string' ? { contains: item.contains } : {}),
      ...(typeof item.equals === 'string' ? { equals: item.equals } : {}),
    }
  }
  if (item.type === 'command' && typeof item.executable === 'string') {
    const env = objectValue(item.env)
    const parsedEnv = env
      ? Object.fromEntries(Object.entries(env).map(([name, entry]) => {
          const binding = objectValue(entry)
          if (!binding || typeof binding.fromEnv !== 'string' || !binding.fromEnv) {
            throw new EvalCaseValidationError(`graders[${index}].env.${name} must name a source environment variable`)
          }
          return [name, { fromEnv: binding.fromEnv }]
        }))
      : undefined
    return {
      type: 'command', executable: item.executable,
      ...(Array.isArray(item.args) && item.args.every((arg) => typeof arg === 'string') ? { args: item.args as string[] } : {}),
      ...(typeof item.expectedExitCode === 'number' ? { expectedExitCode: item.expectedExitCode } : {}),
      ...(typeof item.timeoutMs === 'number' ? { timeoutMs: item.timeoutMs } : {}),
      ...(parsedEnv ? { env: parsedEnv } : {}),
    }
  }
  if (item.type === 'diff') {
    const strings = (entry: unknown): string[] | undefined =>
      Array.isArray(entry) && entry.every((part) => typeof part === 'string') ? entry as string[] : undefined
    return {
      type: 'diff',
      ...(strings(item.allow) ? { allow: strings(item.allow) } : {}),
      ...(strings(item.deny) ? { deny: strings(item.deny) } : {}),
      ...(typeof item.maxChangedFiles === 'number' ? { maxChangedFiles: item.maxChangedFiles } : {}),
    }
  }
  throw new EvalCaseValidationError(`graders[${index}] is not a supported grader`)
}

export function parseEvalCase(value: unknown, sourcePath = join(process.cwd(), 'eval-case.json')): EvalCase {
  const item = objectValue(value)
  if (!item || item.version !== 1 || typeof item.id !== 'string' || !item.id.trim()) {
    throw new EvalCaseValidationError('case must have version 1 and a non-empty id')
  }
  if (typeof item.fixture !== 'string' || typeof item.prompt !== 'string') {
    throw new EvalCaseValidationError('case fixture and prompt must be strings')
  }
  if (typeof item.timeoutMs !== 'number' || item.timeoutMs <= 0) {
    throw new EvalCaseValidationError('case timeoutMs must be positive')
  }
  const engine = objectValue(item.engine)
  if (
    !engine || engine.type !== 'pi' || typeof engine.provider !== 'string' || !engine.provider.trim() ||
    engine.security !== 'host-full-access'
  ) {
    throw new EvalCaseValidationError('case engine must be an explicit Pi host-full-access profile')
  }
  const env = objectValue(engine.env)
  const parsedEnv = env
    ? Object.fromEntries(Object.entries(env).map(([name, entry]) => {
        const binding = objectValue(entry)
        if (!binding || typeof binding.fromEnv !== 'string' || !binding.fromEnv) {
          throw new EvalCaseValidationError(`engine.env.${name} must name a source environment variable`)
        }
        return [name, { fromEnv: binding.fromEnv }]
      }))
    : undefined
  const fixture = isAbsolute(item.fixture) ? item.fixture : resolve(dirname(sourcePath), item.fixture)
  return {
    version: 1,
    id: item.id.trim(),
    fixture,
    prompt: item.prompt,
    engine: {
      type: 'pi', provider: engine.provider.trim(),
      ...(typeof engine.model === 'string' ? { model: engine.model } : {}),
      security: 'host-full-access',
      ...(parsedEnv ? { env: parsedEnv } : {}),
      ...(Array.isArray(engine.args) && engine.args.every((arg) => typeof arg === 'string') ? { args: engine.args as string[] } : {}),
    },
    timeoutMs: item.timeoutMs,
    graders: Array.isArray(item.graders) ? item.graders.map(parseGrader) : [],
    ...(Array.isArray(item.artifacts) && item.artifacts.every((entry) => typeof entry === 'string')
      ? { artifacts: item.artifacts as string[] }
      : {}),
  }
}

function safeWorkspacePath(workspace: string, requested: string): string {
  const target = resolve(workspace, requested)
  const prefix = `${resolve(workspace)}${sep}`
  if (target !== resolve(workspace) && !target.startsWith(prefix)) {
    throw new EvalCaseValidationError(`path escapes evaluation workspace: ${requested}`)
  }
  return target
}

async function isGitRepository(path: string): Promise<boolean> {
  try {
    await stat(join(path, '.git'))
    return true
  } catch {
    return false
  }
}

async function prepareWorkspace(fixture: string): Promise<{ root: string; workspace: string }> {
  const fixtureStat = await stat(fixture).catch(() => null)
  if (!fixtureStat?.isDirectory()) throw new EvalCaseValidationError(`fixture does not exist: ${fixture}`)
  const root = await mkdtemp(join(tmpdir(), 'pi-studio-eval-'))
  const workspace = join(root, basename(fixture) || 'workspace')
  try {
    if (await isGitRepository(fixture)) {
      await execFileAsync('git', ['clone', '--quiet', '--no-hardlinks', fixture, workspace], { windowsHide: true })
    } else {
      await cp(fixture, workspace, { recursive: true, errorOnExist: true })
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return { root, workspace }
}

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function snapshotWorkspace(workspace: string): Promise<WorkspaceSnapshot> {
  const result = new Map<string, string>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new EvalCaseValidationError(`symbolic links are not allowed in evaluation workspaces: ${relative(workspace, absolute)}`)
      }
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) result.set(relative(workspace, absolute).replaceAll('\\', '/'), await fileHash(absolute))
    }
  }
  await visit(workspace)
  return result
}

function workspaceChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  return paths.flatMap((path) => {
    const beforeHash = before.get(path)
    const afterHash = after.get(path)
    if (beforeHash === afterHash) return []
    return [{
      path,
      status: beforeHash === undefined ? 'added' as const : afterHash === undefined ? 'deleted' as const : 'modified' as const,
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
    }]
  })
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesAny(path: string, patterns: readonly string[] | undefined): boolean {
  return !!patterns?.some((pattern) => globRegex(pattern).test(path))
}

type CommandGradeExecution =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout' | 'spawn-error' | 'output-limit' | 'cleanup-error'; stdout: string; stderr: string }

function graderEnvironment(grader: Extract<EvalGrader, { type: 'command' }>): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...Object.fromEntries(Object.entries(grader.env ?? {}).map(([target, source]) => {
      const value = process.env[source.fromEnv]
      if (value === undefined) throw new EvalCaseValidationError(`Missing grader environment variable: ${source.fromEnv}`)
      return [target, value]
    })),
  }
}

async function runCommandGrader(
  workspace: string,
  grader: Extract<EvalGrader, { type: 'command' }>,
): Promise<CommandGradeExecution> {
  return new Promise((resolveResult) => {
    const windowsStatusPath = process.platform === 'win32'
      ? join(tmpdir(), `pi-studio-eval-command-${randomUUID()}.json`)
      : null
    const encodedSpec = Buffer.from(JSON.stringify({ executable: grader.executable, args: grader.args ?? [] }), 'utf8').toString('base64')
    const executable = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : grader.executable
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/eval-command-job.ps1'), encodedSpec, windowsStatusPath!]
      : grader.args ?? []
    const child = spawn(executable, args, {
      cwd: workspace,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: graderEnvironment(grader),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const maxOutputBytes = 2 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let infrastructureFailure: Exclude<CommandGradeExecution['kind'], 'exit'> | null = null
    let terminationError: Error | null = null
    let settled = false
    let terminating: Promise<void> | null = null
    const terminate = (kind: Exclude<CommandGradeExecution['kind'], 'exit'>): void => {
      if (infrastructureFailure) return
      infrastructureFailure = kind
      if (!child.pid) return
      terminating = terminateProcessTree(child.pid, { detachedGroup: process.platform !== 'win32' })
        .catch((error) => {
          terminationError = error instanceof Error ? error : new Error(String(error))
          if (!settled && process.platform !== 'win32') {
            settled = true
            clearTimeout(timeout)
            resolveResult({ kind: 'cleanup-error', stdout, stderr: `${stderr}${stderr ? '\n' : ''}${terminationError.message}` })
          }
        })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) terminate('output-limit')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) terminate('output-limit')
    })
    child.on('error', (error) => {
      infrastructureFailure = 'spawn-error'
      stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`
    })
    const timeout = setTimeout(() => terminate('timeout'), grader.timeoutMs ?? 60_000)
    child.on('close', async (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (terminating) await terminating
      // The Windows helper owns its target in a kill-on-close Job Object. Once
      // the helper itself has closed, the OS has closed that job and killed all
      // descendants even if taskkill raced with helper exit.
      if (process.platform === 'win32' && terminating) terminationError = null
      if (windowsStatusPath && (terminationError || infrastructureFailure)) {
        await rm(windowsStatusPath, { force: true }).catch(() => {})
      }
      if (!infrastructureFailure && process.platform !== 'win32' && child.pid) {
        try {
          await terminateProcessTree(child.pid, { detachedGroup: true })
        } catch (error) {
          terminationError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (terminationError) {
        resolveResult({ kind: 'cleanup-error', stdout, stderr: `${stderr}${stderr ? '\n' : ''}${terminationError.message}` })
      } else if (infrastructureFailure) {
        resolveResult({ kind: infrastructureFailure, stdout, stderr })
      } else if (windowsStatusPath) {
        const status = objectValue(JSON.parse(await readFile(windowsStatusPath, 'utf8').catch(() => '{}')))
        await rm(windowsStatusPath, { force: true }).catch(() => {})
        if (status?.kind === 'exit' && Number.isInteger(status.exitCode)) {
          resolveResult({ kind: 'exit', exitCode: status.exitCode as number, stdout, stderr })
        } else {
          const detail = typeof status?.message === 'string' ? status.message : 'Windows command job did not report a terminal status'
          resolveResult({ kind: 'spawn-error', stdout, stderr: `${stderr}${stderr ? '\n' : ''}${detail}` })
        }
      } else if (typeof code === 'number') {
        resolveResult({ kind: 'exit', exitCode: code, stdout, stderr })
      } else {
        resolveResult({ kind: 'spawn-error', stdout, stderr: `${stderr}${stderr ? '\n' : ''}process exited by signal ${signal ?? 'unknown'}` })
      }
    })
  })
}

async function grade(
  grader: EvalGrader,
  workspace: string,
  engine: EvalEngineResult,
  diff: WorkspaceChange[],
): Promise<EvalGraderResult> {
  if (grader.type === 'exit-code') {
    const passed = engine.exitCode === grader.expected
    return { grader, passed, message: passed ? 'exit code matched' : `expected ${grader.expected}, got ${engine.exitCode}` }
  }
  if (grader.type === 'command') {
    const result = await runCommandGrader(workspace, grader)
    if (result.kind === 'cleanup-error') {
      throw new EvalWorkspaceOwnershipError(
        `Command grader cleanup could not be verified; workspace retained at ${workspace}: ${result.stderr}`,
      )
    }
    const expected = grader.expectedExitCode ?? 0
    const passed = result.kind === 'exit' && result.exitCode === expected
    const message = passed
      ? 'command passed'
      : result.kind === 'exit'
        ? `command exited ${result.exitCode}, expected ${expected}`
        : `command infrastructure failure: ${result.kind}`
    return { grader, passed, message, details: result }
  }
  if (grader.type === 'file') {
    const target = safeWorkspacePath(workspace, grader.path)
    const resolvedTarget = await realpath(target).catch(() => null)
    if (resolvedTarget) {
      const resolvedWorkspace = await realpath(workspace)
      const prefix = `${resolvedWorkspace}${sep}`
      if (resolvedTarget !== resolvedWorkspace && !resolvedTarget.startsWith(prefix)) {
        throw new EvalCaseValidationError(`file grader resolves outside evaluation workspace: ${grader.path}`)
      }
    }
    const content = await readFile(target, 'utf8').catch(() => null)
    const expectedExists = grader.exists ?? true
    const passed = expectedExists
      ? content !== null && (grader.contains === undefined || content.includes(grader.contains)) && (grader.equals === undefined || content === grader.equals)
      : content === null
    return { grader, passed, message: passed ? 'file assertion passed' : `file assertion failed: ${grader.path}` }
  }
  const unexpected = diff.filter((entry) => grader.allow !== undefined && !matchesAny(entry.path, grader.allow))
  const denied = diff.filter((entry) => matchesAny(entry.path, grader.deny))
  const overLimit = grader.maxChangedFiles !== undefined && diff.length > grader.maxChangedFiles
  const passed = unexpected.length === 0 && denied.length === 0 && !overLimit
  return { grader, passed, message: passed ? 'diff rules passed' : 'diff rules failed', details: { unexpected, denied, changedFiles: diff.length } }
}

async function gradeInIsolatedWorkspace(
  grader: EvalGrader,
  workspace: string,
  engine: EvalEngineResult,
  diff: WorkspaceChange[],
): Promise<EvalGraderResult> {
  if (grader.type !== 'command') return grade(grader, workspace, engine, diff)
  const root = await mkdtemp(join(tmpdir(), 'pi-studio-eval-grader-'))
  const copyPath = join(root, 'workspace')
  let ownershipUnverified = false
  try {
    await cp(workspace, copyPath, { recursive: true, errorOnExist: true })
    return await grade(grader, copyPath, engine, diff)
  } catch (error) {
    ownershipUnverified = error instanceof EvalWorkspaceOwnershipError
    throw error
  } finally {
    if (!ownershipUnverified) await rm(root, { recursive: true, force: true })
  }
}

function toolCalls(events: EvalEventFrame[]): unknown[] {
  return events
    .filter((frame) => frame.normalized?.type === 'tool.started')
    .map((frame) => frame.normalized?.data.tool)
    .filter((value) => value !== undefined)
}

function normalizeWorkspaceString(value: string, workspace: string): string {
  const variants = [...new Set([resolve(workspace), resolve(workspace).replaceAll('\\', '/')])]
  let normalized = value
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    normalized = normalized.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, process.platform === 'win32' ? 'gi' : 'g'), EVAL_WORKSPACE_TOKEN)
  }
  return normalized
}

function normalizeRecordedWorkspace<T>(value: T, workspace: string): T {
  if (typeof value === 'string') return normalizeWorkspaceString(value, workspace) as T
  if (Array.isArray(value)) return value.map((entry) => normalizeRecordedWorkspace(entry, workspace)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeRecordedWorkspace(entry, workspace)])) as T
  }
  return value
}

function remapRecordedSession<T>(value: T, recordedSessionId: string, sessionId: string): T {
  if (typeof value === 'string') {
    return (value === recordedSessionId
      ? sessionId
      : value.startsWith(`${recordedSessionId}:`)
        ? `${sessionId}${value.slice(recordedSessionId.length)}`
        : value) as T
  }
  if (Array.isArray(value)) return value.map((entry) => remapRecordedSession(entry, recordedSessionId, sessionId)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remapRecordedSession(entry, recordedSessionId, sessionId)])) as T
  }
  return value
}

export class EvalDriver {
  constructor(private readonly keepWorkspace = false) {}

  async run(evalCase: EvalCase, engine: EvalEngine): Promise<EvalRunReport> {
    const prepared = await prepareWorkspace(evalCase.fixture)
    let ownershipUnverified = false
    try {
      const sessionId = `eval:${evalCase.id}:${randomUUID()}`
      const startedAt = new Date().toISOString()
      const start = Date.now()
      const before = await snapshotWorkspace(prepared.workspace)
      const events: EvalEventFrame[] = []
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      let engineResult: EvalEngineResult
      let acceptEvents = true
      try {
        const running = engine.run({
          caseId: evalCase.id,
          workspacePath: prepared.workspace,
          sessionId,
          prompt: evalCase.prompt,
          profile: evalCase.engine,
          timeoutMs: evalCase.timeoutMs,
        }, (event) => {
          const { recordedAtMs, ...frame } = normalizeRecordedWorkspace(event, prepared.workspace)
          if (acceptEvents) events.push({ ...frame, atMs: recordedAtMs ?? Date.now() - start, observedAt: frame.observedAt ?? new Date().toISOString() })
        }, controller.signal)
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort(new EvalTimeoutError(evalCase.timeoutMs))
            reject(new EvalTimeoutError(evalCase.timeoutMs))
          }, evalCase.timeoutMs)
        })
        engineResult = await Promise.race([running, deadline])
      } catch (error) {
        engineResult = {
          finalResponse: '',
          finishReason: error instanceof EvalTimeoutError ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error',
          exitCode: 1,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      try {
        await engine.cleanup()
        acceptEvents = false
      } catch (cleanupError) {
        ownershipUnverified = true
        throw new EvalWorkspaceOwnershipError(
          `Evaluation cleanup could not be verified; workspace retained at ${prepared.workspace}`,
          { cause: cleanupError },
        )
      }
      const after = await snapshotWorkspace(prepared.workspace)
      const diff = workspaceChanges(before, after)
      const graders: EvalGraderResult[] = []
      for (const grader of evalCase.graders) {
        graders.push(await gradeInIsolatedWorkspace(grader, prepared.workspace, engineResult, diff))
      }
      const afterGraders = await snapshotWorkspace(prepared.workspace)
      if (workspaceChanges(after, afterGraders).length > 0) {
        ownershipUnverified = true
        throw new EvalWorkspaceOwnershipError(
          `Evaluation workspace changed during grading; workspace retained at ${prepared.workspace}`,
        )
      }
      const report: EvalRunReport = {
        version: 1,
        caseId: evalCase.id,
        sessionId: engineResult.sessionId || sessionId,
        workspacePath: prepared.workspace,
        startedAt,
        durationMs: Date.now() - start,
        finalResponse: normalizeRecordedWorkspace(engineResult.finalResponse, prepared.workspace),
        finishReason: engineResult.finishReason,
        exitCode: engineResult.exitCode,
        ...(engineResult.usage ? { usage: engineResult.usage } : {}),
        ...(engineResult.messages ? { messages: normalizeRecordedWorkspace(engineResult.messages, prepared.workspace) } : {}),
        ...(engineResult.error ? { error: normalizeRecordedWorkspace(engineResult.error, prepared.workspace) } : {}),
        events,
        toolCalls: toolCalls(events),
        workspaceDiff: diff,
        artifacts: diff.filter((entry) => entry.status !== 'deleted' && matchesAny(entry.path, evalCase.artifacts)).map((entry) => entry.path),
        graders,
        passed:
          graders.every((result) => result.passed) &&
          (engineResult.exitCode === 0 || evalCase.graders.some((grader) => grader.type === 'exit-code')),
      }
      if (!this.keepWorkspace) {
        await rm(prepared.root, { recursive: true, force: true })
        report.workspacePath = '(removed)'
      }
      return report
    } catch (error) {
      if (error instanceof EvalWorkspaceOwnershipError) ownershipUnverified = true
      if (!this.keepWorkspace && !ownershipUnverified) await rm(prepared.root, { recursive: true, force: true })
      throw error
    }
  }
}

/** Replays recorded runtime events through the main-process projector only. */
export class ProjectionReplayEvalEngine implements EvalEngine {
  constructor(private readonly recording: EvalRecording) {}

  async run(request: EvalEngineRequest, emit: (event: EvalEngineEvent) => void, signal: AbortSignal): Promise<EvalEngineResult> {
    if (this.recording.version !== 1 || this.recording.caseId !== request.caseId) {
      throw new EvalCaseValidationError('recording does not match evaluation case')
    }
    const tracker = new SessionProjectionTracker()
    const recordedSessionId = this.recording.engineResult.sessionId
    const sessionId = request.sessionId
    tracker.beginLoad(request.workspacePath, null, sessionId)
    for (const frame of this.recording.events) {
      signal.throwIfAborted()
      const raw = remapRecordedSession(frame.raw, recordedSessionId, sessionId)
      const projected = tracker.ingest(sessionId, raw as { type: string }, frame.observedAt).event
      const expected = frame.normalized
        ? remapRecordedSession(frame.normalized, recordedSessionId, sessionId)
        : undefined
      if (expected && (
        projected.seq !== expected.seq ||
        projected.sessionId !== expected.sessionId ||
        projected.type !== expected.type ||
        JSON.stringify(projected.data) !== JSON.stringify(expected.data)
      )) {
        throw new Error(`replay projection diverged at event ${expected.seq}`)
      }
      emit({ raw, normalized: projected, recordedAtMs: frame.atMs, observedAt: frame.observedAt })
    }
    if (this.recording.engineResult.messages) {
      const durableLoad = tracker.beginLoad(request.workspacePath, null, sessionId)
      tracker.commit(durableLoad, this.recording.engineResult.messages as never[])
    }
    return { ...this.recording.engineResult, sessionId }
  }

  cleanup(): Promise<void> { return Promise.resolve() }
}

export async function readEvalCase(path: string): Promise<EvalCase> {
  return parseEvalCase(JSON.parse(await readFile(path, 'utf8')), resolve(path))
}

export async function readEvalRecording(path: string): Promise<EvalRecording> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  const recording = objectValue(value)
  const result = objectValue(recording?.engineResult)
  const finishReasons = new Set<EvalEngineResult['finishReason']>(['settled', 'error', 'timeout', 'cancelled'])
  if (
    !recording || recording.version !== 1 || typeof recording.caseId !== 'string' || !recording.caseId ||
    !result || typeof result.finalResponse !== 'string' ||
    typeof result.finishReason !== 'string' || !finishReasons.has(result.finishReason as EvalEngineResult['finishReason']) ||
    !Number.isInteger(result.exitCode) || typeof result.sessionId !== 'string' || !result.sessionId || !Array.isArray(recording.events)
  ) {
    throw new EvalCaseValidationError('recording is not a valid version 1 evaluation recording')
  }
  if (result.messages !== undefined && (
    !Array.isArray(result.messages) || !result.messages.every(isRecordedAgentMessage)
  )) {
    throw new EvalCaseValidationError('recording engineResult.messages must contain valid agent messages')
  }
  if (result.error !== undefined && typeof result.error !== 'string') {
    throw new EvalCaseValidationError('recording engineResult.error must be a string')
  }
  if (result.usage !== undefined) {
    const usage = objectValue(result.usage)
    const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
    if (!usage || fields.some((field) => usage[field] !== undefined && (
      typeof usage[field] !== 'number' || !Number.isFinite(usage[field]) || (usage[field] as number) < 0
    ))) {
      throw new EvalCaseValidationError('recording engineResult.usage contains an invalid token count')
    }
  }
  if (recording.replay !== undefined) {
    const replay = objectValue(recording.replay)
    if (!replay || !Array.isArray(replay.providerSteps) || replay.providerSteps.some((entry) => {
      const step = objectValue(entry)
      return !step || (
        step.kind !== 'recorded-stream' && step.kind !== 'hang' &&
        (step.kind !== 'cancel' || (step.message !== undefined && typeof step.message !== 'string')) &&
        (step.kind !== 'throw' || typeof step.message !== 'string')
      )
    })) {
      throw new EvalCaseValidationError('recording replay sidecar is invalid')
    }
  }
  const normalizedTypes = new Set<StudioAgentEvent['type']>([
    'session.changed', 'session.cleared', 'conversation.replaced', 'approvals.replaced',
    'agent.started', 'agent.ended', 'agent.settled', 'message.started', 'message.updated',
    'message.finished', 'tool.started', 'tool.updated', 'tool.finished', 'approval.requested',
    'approval.decided', 'run.failed', 'agent.event',
  ])
  const providerEventTypes = new Set([
    'start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta',
    'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error',
  ])
  for (const [index, frame] of recording.events.entries()) {
    const event = objectValue(frame)
    const raw = objectValue(event?.raw)
    if (
      !event || typeof event.atMs !== 'number' || !Number.isFinite(event.atMs) || event.atMs < 0 ||
      typeof event.observedAt !== 'string' || !Number.isFinite(Date.parse(event.observedAt)) ||
      !raw || typeof raw.type !== 'string' || !raw.type
    ) {
      throw new EvalCaseValidationError(`recording event ${index} is invalid`)
    }
    if (event.normalized !== undefined) {
      const normalized = objectValue(event.normalized)
      if (
        !normalized || !Number.isInteger(normalized.seq) || (normalized.seq as number) < 0 ||
        typeof normalized.sessionId !== 'string' || typeof normalized.type !== 'string' ||
        !normalizedTypes.has(normalized.type as StudioAgentEvent['type']) || !objectValue(normalized.data)
      ) {
        throw new EvalCaseValidationError(`recording event ${index} has an invalid normalized event`)
      }
    }
    if (raw.assistantMessageEvent !== undefined) {
      const providerEvent = objectValue(raw.assistantMessageEvent)
      if (!providerEvent || typeof providerEvent.type !== 'string' || !providerEventTypes.has(providerEvent.type)) {
        throw new EvalCaseValidationError(`recording event ${index} has an invalid provider event`)
      }
      const terminalMessage = providerEvent.type === 'done' ? providerEvent.message : providerEvent.type === 'error' ? providerEvent.error : undefined
      const partial = providerEvent.type === 'done' || providerEvent.type === 'error' ? terminalMessage : providerEvent.partial
      if (!isRecordedAssistantMessage(partial)) {
        throw new EvalCaseValidationError(`recording event ${index} provider event has no message payload`)
      }
      if (providerEvent.type !== 'start' && providerEvent.type !== 'done' && providerEvent.type !== 'error' && !Number.isInteger(providerEvent.contentIndex)) {
        throw new EvalCaseValidationError(`recording event ${index} provider event has no content index`)
      }
      if ((providerEvent.type === 'text_delta' || providerEvent.type === 'thinking_delta' || providerEvent.type === 'toolcall_delta') && typeof providerEvent.delta !== 'string') {
        throw new EvalCaseValidationError(`recording event ${index} provider delta is invalid`)
      }
      if (providerEvent.type === 'toolcall_end' && !objectValue(providerEvent.toolCall)) {
        throw new EvalCaseValidationError(`recording event ${index} tool call is invalid`)
      }
    }
    if (raw.type === 'message_start' || raw.type === 'message_end') {
      const message = objectValue(raw.message)
      if (!message || typeof message.role !== 'string') {
        throw new EvalCaseValidationError(`recording event ${index} has an invalid message payload`)
      }
      if (message.role === 'assistant' && !isRecordedAssistantMessage(message)) {
        throw new EvalCaseValidationError(`recording event ${index} has an invalid assistant message`)
      }
    }
    if (raw.type === 'tool_execution_start' && (
      typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string'
    )) {
      throw new EvalCaseValidationError(`recording event ${index} has an invalid tool start payload`)
    }
  }
  return value as EvalRecording
}

export async function writeEvalRecording(path: string, report: EvalRunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const engineResult: EvalEngineResult = {
    finalResponse: report.finalResponse,
    finishReason: report.finishReason,
    exitCode: report.exitCode,
    sessionId: report.sessionId,
    ...(report.messages ? { messages: report.messages } : {}),
    ...(report.usage ? { usage: report.usage } : {}),
    ...(report.error ? { error: report.error } : {}),
  }
  const recording: EvalRecording = { version: 1, caseId: report.caseId, engineResult, events: report.events }
  await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
}

export async function writeEvalEventsJsonl(path: string, events: EvalEventFrame[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8')
}

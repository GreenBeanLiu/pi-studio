import { app, safeStorage } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAppLog, normalizeError } from './app-log'
import type { Routine, RoutineRun, RoutineStep, RoutineStepResult } from './routines'
import type { WorkflowDeleteOutbox } from './workflow-delete-outbox'

declare const __TRAILAI_API_URL__: string

type RoutineStoreSnapshot = { routines: Routine[]; runs: RoutineRun[] }
type InstallationCredential = { installationId: string; token: string }
type StoredCredential = { origin: string; installationId: string; tokenEncrypted: string }
function iso(timestamp: number | undefined): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function cloudStepId(workflowId: string, stepId: string): string {
  if (UUID_PATTERN.test(stepId)) return stepId.toLowerCase()
  const bytes = createHash('sha256').update(`${workflowId}:${stepId}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function stepPayload(workflowId: string, step: RoutineStep): Record<string, unknown> {
  return {
    id: cloudStepId(workflowId, step.id),
    name: step.name,
    type: step.type,
    prompt: step.prompt ?? null,
    engine: step.engine ?? null,
    channel_id: step.channelId ?? null,
    message: step.message ?? null,
    path: step.path ?? null,
    format: step.format ?? null,
    config: {},
  }
}

export function routineWorkflowPayload(routine: Routine): Record<string, unknown> {
  return {
    name: routine.name,
    input: routine.input ?? null,
    workspace_path: routine.workspacePath,
    schedule: routine.schedule,
    enabled: routine.enabled,
    notify_mode: routine.notify,
    notify_channel_id: routine.notifyChannelId ?? null,
    push_each_step: routine.pushEachStep ?? false,
    last_run_at: iso(routine.lastRunAt),
    last_slot_key: routine.lastSlotKey ?? null,
    created_at: iso(routine.createdAt),
    steps: routine.steps.map((step) => stepPayload(routine.id, step)),
  }
}

function stepRunPayload(
  step: RoutineStepResult,
  routine: Routine | undefined,
): Record<string, unknown> {
  const definition = routine?.steps.find((candidate) => candidate.id === step.id)
  return {
    workflow_step_id: definition ? cloudStepId(routine!.id, definition.id) : null,
    name: step.name,
    type: definition?.type ?? 'agent',
    status: step.status,
    summary: step.summary,
    image_url: step.imageUrl ?? null,
    artifact_path: step.artifactPath ?? null,
    error: step.status === 'error' || step.status === 'timeout' ? step.summary : null,
    duration_ms: step.durationMs,
  }
}

export function routineRunPayload(
  run: RoutineRun,
  routines: ReadonlyMap<string, Routine>,
): Record<string, unknown> {
  const routine = routines.get(run.routineId)
  return {
    workflow_id: routine?.id ?? null,
    workflow_name: run.routineName,
    trigger_source: run.triggerSource ?? 'manual',
    status: run.status,
    input_snapshot: routine?.input ?? null,
    summary: run.summary,
    error: run.error ?? null,
    started_at: iso(run.startedAt),
    ended_at: iso(run.endedAt),
    created_at: iso(run.startedAt),
    steps: (run.steps ?? []).map((step) => stepRunPayload(step, routine)),
  }
}

function credentialPath(): string {
  return join(app.getPath('userData'), 'cloud-sync.json')
}

export function routineSyncOrigin(): string {
  const value = process.env.PI_STUDIO_SYNC_URL?.trim() || __TRAILAI_API_URL__
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Cloud sync requires HTTPS')
  }
  return url.toString().replace(/\/$/, '')
}

function loadCredential(): InstallationCredential | null {
  if (!safeStorage.isEncryptionAvailable() || !existsSync(credentialPath())) return null
  try {
    const stored = JSON.parse(readFileSync(credentialPath(), 'utf8')) as StoredCredential
    if (stored.origin !== routineSyncOrigin()) return null
    return {
      installationId: stored.installationId,
      token: safeStorage.decryptString(Buffer.from(stored.tokenEncrypted, 'base64')),
    }
  } catch {
    return null
  }
}

function saveCredential(credential: InstallationCredential): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected credential storage is unavailable')
  }
  const stored: StoredCredential = {
    origin: routineSyncOrigin(),
    installationId: credential.installationId,
    tokenEncrypted: safeStorage.encryptString(credential.token).toString('base64'),
  }
  writeFileSync(credentialPath(), JSON.stringify(stored, null, 2), 'utf8')
}

async function cloudRequest(
  path: string,
  options: RequestInit = {},
  credential?: InstallationCredential,
): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.body) headers.set('Content-Type', 'application/json')
  if (credential) headers.set('Authorization', `Bearer ${credential.token}`)
  return fetch(`${routineSyncOrigin()}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15_000),
  })
}

export type { InstallationCredential }

/** 注册/复用装机凭据(installation token)。remote-control 也用它连中转 WS。 */
export async function ensureCredential(): Promise<InstallationCredential> {
  const existing = loadCredential()
  if (existing) return existing
  const response = await cloudRequest('/pi/installations', {
    method: 'POST',
    body: JSON.stringify({ display_name: app.getName(), app_version: app.getVersion() }),
  })
  if (!response.ok) throw new Error(`Installation registration failed (${response.status})`)
  const body = (await response.json()) as { installation_id: string; token: string }
  const credential = { installationId: body.installation_id, token: body.token }
  saveCredential(credential)
  return credential
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (response.ok) return
  const detail = await response.text().catch(() => '')
  throw new Error(`${action} failed (${response.status}): ${detail.slice(0, 300)}`)
}

async function syncSnapshot(snapshot: RoutineStoreSnapshot): Promise<void> {
  const credential = await ensureCredential()
  for (const routine of snapshot.routines) {
    await expectOk(
      await cloudRequest(
        `/pi/workflows/${encodeURIComponent(routine.id)}`,
        { method: 'PUT', body: JSON.stringify(routineWorkflowPayload(routine)) },
        credential,
      ),
      'Saving remote workflow',
    )
  }

  const routines = new Map(snapshot.routines.map((routine) => [routine.id, routine]))
  for (const run of snapshot.runs) {
    await expectOk(
      await cloudRequest(
        `/pi/workflow-runs/${encodeURIComponent(run.id)}`,
        { method: 'PUT', body: JSON.stringify(routineRunPayload(run, routines)) },
        credential,
      ),
      'Saving remote workflow run',
    )
  }

  for (const intent of deleteOutbox?.claimWorkflowDeletes(
    routineSyncOrigin(),
    credential.installationId,
  ) ?? []) {
    await expectOk(
      await cloudRequest(
        `/pi/workflows/${encodeURIComponent(intent.workflowId)}`,
        { method: 'DELETE' },
        credential,
      ),
      'Deleting remote workflow',
    )
    deleteOutbox?.ackWorkflowDelete(intent.id)
  }
}

let pendingSnapshot: RoutineStoreSnapshot | null = null
let syncLoop: Promise<void> | null = null
let deleteOutbox: WorkflowDeleteOutbox | null = null
let retryTimer: NodeJS.Timeout | null = null
let retryDelayMs = 15_000
const MAX_RETRY_DELAY_MS = 5 * 60_000

function scheduleRetry(): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    startSyncLoop()
  }, retryDelayMs)
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
}

function recordSyncState(key: string, value: string): void {
  try {
    deleteOutbox?.setSyncState(key, value)
  } catch (error) {
    appendAppLog('warn', 'routines.cloudSyncState', 'Failed to persist cloud sync state', {
      key,
      error: normalizeError(error),
    })
  }
}

async function drainSyncQueue(): Promise<void> {
  while (pendingSnapshot) {
    const snapshot = pendingSnapshot
    pendingSnapshot = null
    try {
      await syncSnapshot(snapshot)
      appendAppLog('info', 'routines.cloudSync', 'Routine snapshot synced', {
        workflows: snapshot.routines.length,
        runs: snapshot.runs.length,
      })
      recordSyncState('last_success_at', new Date().toISOString())
      recordSyncState('last_error', '')
      retryDelayMs = 15_000
    } catch (error) {
      pendingSnapshot ??= snapshot
      recordSyncState(
        'last_error',
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      )
      appendAppLog('warn', 'routines.cloudSync', 'Routine snapshot sync failed', normalizeError(error))
      scheduleRetry()
      return
    }
  }
}

function startSyncLoop(): void {
  if (syncLoop || !pendingSnapshot) return
  syncLoop = drainSyncQueue().finally(() => {
    syncLoop = null
    if (pendingSnapshot && !retryTimer) startSyncLoop()
  })
}

/** Queue a non-blocking full snapshot. Newer snapshots replace stale queued work. */
export function queueRoutineCloudSync(snapshot: RoutineStoreSnapshot): void {
  pendingSnapshot = JSON.parse(JSON.stringify(snapshot)) as RoutineStoreSnapshot
  startSyncLoop()
}

export function configureRoutineCloudOutbox(outbox: WorkflowDeleteOutbox): void {
  deleteOutbox = outbox
}

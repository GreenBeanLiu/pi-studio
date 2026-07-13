import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAppLog, normalizeError } from './app-log'
import type { Routine, RoutineRun, RoutineStep, RoutineStepResult } from './routines'

declare const __TRAILAI_API_URL__: string

type RoutineStoreSnapshot = { routines: Routine[]; runs: RoutineRun[] }
type InstallationCredential = { installationId: string; token: string }
type StoredCredential = { origin: string; installationId: string; tokenEncrypted: string }
type DeleteIntent = { origin: string; installationId: string | null; workflowId: string }

function iso(timestamp: number | undefined): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null
}

function stepPayload(step: RoutineStep): Record<string, unknown> {
  return {
    id: step.id,
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
    steps: routine.steps.map(stepPayload),
  }
}

function stepRunPayload(
  step: RoutineStepResult,
  routine: Routine | undefined,
): Record<string, unknown> {
  const definition = routine?.steps.find((candidate) => candidate.id === step.id)
  return {
    workflow_step_id: definition?.id ?? null,
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

function outboxPath(): string {
  return join(app.getPath('userData'), 'cloud-sync-outbox.json')
}

function syncOrigin(): string {
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
    if (stored.origin !== syncOrigin()) return null
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
    origin: syncOrigin(),
    installationId: credential.installationId,
    tokenEncrypted: safeStorage.encryptString(credential.token).toString('base64'),
  }
  writeFileSync(credentialPath(), JSON.stringify(stored, null, 2), 'utf8')
}

function loadPendingDeletes(): DeleteIntent[] {
  if (!existsSync(outboxPath())) return []
  try {
    const entries = JSON.parse(readFileSync(outboxPath(), 'utf8')) as unknown
    if (!Array.isArray(entries)) throw new Error('delete outbox must be an array')
    return entries.filter(
      (entry): entry is DeleteIntent =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as DeleteIntent).origin === 'string' &&
        ((entry as DeleteIntent).installationId === null ||
          typeof (entry as DeleteIntent).installationId === 'string') &&
        typeof (entry as DeleteIntent).workflowId === 'string',
    )
  } catch (error) {
    throw new Error(`Cloud sync delete outbox is damaged: ${String(error)}`)
  }
}

function savePendingDeletes(entries: readonly DeleteIntent[]): void {
  const unique = new Map(
    entries.map((entry) => [`${entry.origin}\n${entry.installationId}\n${entry.workflowId}`, entry]),
  )
  const target = outboxPath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify([...unique.values()], null, 2), 'utf8')
  renameSync(temporary, target)
}

export function pendingDeletesForCredential(
  entries: readonly DeleteIntent[],
  credential: InstallationCredential,
  origin: string,
): DeleteIntent[] {
  return entries.filter(
    (entry) => entry.origin === origin && entry.installationId === credential.installationId,
  )
}

function claimPendingDeletes(credential: InstallationCredential): DeleteIntent[] {
  const origin = syncOrigin()
  const claimed = loadPendingDeletes().map((entry) =>
    entry.origin === origin && entry.installationId === null
      ? { ...entry, installationId: credential.installationId }
      : entry,
  )
  savePendingDeletes(claimed)
  return pendingDeletesForCredential(claimed, credential, origin)
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
  return fetch(`${syncOrigin()}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15_000),
  })
}

async function ensureCredential(): Promise<InstallationCredential> {
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

  for (const intent of claimPendingDeletes(credential)) {
    await expectOk(
      await cloudRequest(
        `/pi/workflows/${encodeURIComponent(intent.workflowId)}`,
        { method: 'DELETE' },
        credential,
      ),
      'Deleting remote workflow',
    )
    savePendingDeletes(
      loadPendingDeletes().filter(
        (candidate) =>
          candidate.origin !== intent.origin ||
          candidate.installationId !== intent.installationId ||
          candidate.workflowId !== intent.workflowId,
      ),
    )
  }
}

let pendingSnapshot: RoutineStoreSnapshot | null = null
let syncLoop: Promise<void> | null = null
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
      retryDelayMs = 15_000
    } catch (error) {
      pendingSnapshot ??= snapshot
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

/** Persist an explicit delete so absence or a damaged local store can never imply deletion. */
export function queueRoutineCloudDelete(workflowId: string): void {
  const credential = loadCredential()
  savePendingDeletes([
    ...loadPendingDeletes(),
    { origin: syncOrigin(), installationId: credential?.installationId ?? null, workflowId },
  ])
}

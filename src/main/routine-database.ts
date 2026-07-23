import { copyFileSync, existsSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import type { Routine, RoutineRun, RoutineStep, RoutineStepResult } from './routines'
import type { WorkflowDeleteIntent } from './workflow-delete-outbox'

type SqlValue = string | number | bigint | null | Uint8Array
type SqlRow = Record<string, SqlValue>

type StatementSync = {
  run: (...params: SqlValue[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
  get: (...params: SqlValue[]) => SqlRow | undefined
  all: (...params: SqlValue[]) => SqlRow[]
}

type DatabaseSyncInstance = {
  exec: (sql: string) => void
  prepare: (sql: string) => StatementSync
  close: () => void
}

export type RoutineStoreData = { routines: Routine[]; runs: RoutineRun[] }

export class RoutineSqliteUnavailableError extends Error {}

type PendingWorkflowDelete = {
  origin: string
  workflowId: string
}

function optionalString(value: SqlValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: SqlValue): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function requiredString(value: SqlValue): string {
  if (typeof value !== 'string') throw new Error('Routine database contains an invalid string value')
  return value
}

function requiredNumber(value: SqlValue): number {
  if (typeof value !== 'number') throw new Error('Routine database contains an invalid number value')
  return value
}

function openDatabase(path: string): DatabaseSyncInstance {
  // Keep this lookup inside the constructor path so unsupported Electron runtimes
  // can still load the routines module and fall back to JSON storage.
  let DatabaseSync: new (databasePath: string) => DatabaseSyncInstance
  try {
    // ESM 下没有裸 require;createRequire 保持同步加载(此处不能 await import)
    const cjsRequire = createRequire(import.meta.url)
    ;({ DatabaseSync } = cjsRequire('node:sqlite') as {
      DatabaseSync: new (databasePath: string) => DatabaseSyncInstance
    })
  } catch (error) {
    throw new RoutineSqliteUnavailableError('This Electron runtime does not provide node:sqlite', {
      cause: error,
    })
  }
  return new DatabaseSync(path)
}

function normalizeLegacyStore(value: unknown): RoutineStoreData {
  const raw = value && typeof value === 'object' ? (value as Partial<RoutineStoreData>) : {}
  const routines = (Array.isArray(raw.routines) ? raw.routines : []).map((routine) => {
    const legacy = routine as Routine & { prompt?: string }
    const steps =
      Array.isArray(legacy.steps) && legacy.steps.length > 0
        ? legacy.steps.map((step) => ({
            ...step,
            id: step.id || randomUUID(),
            name: step.name ?? '',
            type: step.type ?? 'agent',
          }))
        : [
            {
              id: randomUUID(),
              name: 'Step 1',
              type: 'agent' as const,
              prompt: legacy.prompt ?? '',
            },
          ]
    return { ...legacy, steps }
  })
  return { routines, runs: Array.isArray(raw.runs) ? raw.runs : [] }
}

export class RoutineDatabase {
  private readonly db: DatabaseSyncInstance

  constructor(
    databasePath: string,
    private readonly legacyJsonPath: string,
  ) {
    this.db = openDatabase(databasePath)
    try {
      this.initialize()
      this.importLegacyOnce()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  load(): RoutineStoreData {
    const workflowRows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at, id').all()
    const stepRows = this.db
      .prepare('SELECT * FROM workflow_steps ORDER BY workflow_id, position')
      .all()
    const runRows = this.db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC, id').all()
    const stepRunRows = this.db
      .prepare('SELECT * FROM workflow_step_runs ORDER BY workflow_run_id, position')
      .all()

    const stepsByWorkflow = new Map<string, RoutineStep[]>()
    for (const row of stepRows) {
      const workflowId = requiredString(row.workflow_id)
      const step: RoutineStep = {
        id: requiredString(row.id),
        name: requiredString(row.name),
        type: requiredString(row.type) as RoutineStep['type'],
        ...(optionalString(row.prompt) !== undefined ? { prompt: optionalString(row.prompt) } : {}),
        ...(optionalString(row.engine) !== undefined
          ? { engine: optionalString(row.engine) as RoutineStep['engine'] }
          : {}),
        ...(optionalString(row.channel_id) !== undefined
          ? { channelId: optionalString(row.channel_id) }
          : {}),
        ...(optionalString(row.message) !== undefined ? { message: optionalString(row.message) } : {}),
        ...(optionalString(row.path) !== undefined ? { path: optionalString(row.path) } : {}),
        ...(optionalString(row.format) !== undefined
          ? { format: optionalString(row.format) as RoutineStep['format'] }
          : {}),
        ...(optionalString(row.provider) !== undefined
          ? { provider: optionalString(row.provider) as RoutineStep['provider'] }
          : {}),
        ...(optionalString(row.image_ref) !== undefined ? { imageRef: optionalString(row.image_ref) } : {}),
      }
      const steps = stepsByWorkflow.get(workflowId) ?? []
      steps.push(step)
      stepsByWorkflow.set(workflowId, steps)
    }

    const routines: Routine[] = workflowRows.map((row) => {
      const pushEachStep = optionalNumber(row.push_each_step)
      return {
        id: requiredString(row.id),
        name: requiredString(row.name),
        ...(optionalString(row.input) !== undefined ? { input: optionalString(row.input) } : {}),
        steps: stepsByWorkflow.get(requiredString(row.id)) ?? [],
        workspacePath: requiredString(row.workspace_path),
        schedule: JSON.parse(requiredString(row.schedule_json)) as Routine['schedule'],
        enabled: requiredNumber(row.enabled) === 1,
        notify: requiredString(row.notify) as Routine['notify'],
        ...(optionalString(row.notify_channel_id) !== undefined
          ? { notifyChannelId: optionalString(row.notify_channel_id) }
          : {}),
        ...(pushEachStep !== undefined ? { pushEachStep: pushEachStep === 1 } : {}),
        createdAt: requiredNumber(row.created_at),
        ...(optionalNumber(row.last_run_at) !== undefined ? { lastRunAt: optionalNumber(row.last_run_at) } : {}),
        ...(optionalString(row.last_slot_key) !== undefined
          ? { lastSlotKey: optionalString(row.last_slot_key) }
          : {}),
      }
    })

    const stepRunsByRun = new Map<string, RoutineStepResult[]>()
    for (const row of stepRunRows) {
      const runId = requiredString(row.workflow_run_id)
      const result: RoutineStepResult = {
        id: requiredString(row.step_id),
        name: requiredString(row.name),
        status: requiredString(row.status) as RoutineStepResult['status'],
        summary: requiredString(row.summary),
        ...(optionalString(row.image_url) !== undefined ? { imageUrl: optionalString(row.image_url) } : {}),
        ...(optionalString(row.artifact_path) !== undefined
          ? { artifactPath: optionalString(row.artifact_path) }
          : {}),
        durationMs: requiredNumber(row.duration_ms),
      }
      const steps = stepRunsByRun.get(runId) ?? []
      steps.push(result)
      stepRunsByRun.set(runId, steps)
    }

    const runs: RoutineRun[] = runRows.map((row) => {
      const id = requiredString(row.id)
      const steps = stepRunsByRun.get(id)
      return {
        id,
        routineId: requiredString(row.workflow_id),
        routineName: requiredString(row.workflow_name),
        startedAt: requiredNumber(row.started_at),
        endedAt: requiredNumber(row.ended_at),
        status: requiredString(row.status) as RoutineRun['status'],
        ...(optionalString(row.trigger_source) !== undefined
          ? { triggerSource: optionalString(row.trigger_source) as RoutineRun['triggerSource'] }
          : {}),
        summary: requiredString(row.summary),
        ...(steps ? { steps } : {}),
        ...(optionalString(row.error) !== undefined ? { error: optionalString(row.error) } : {}),
      }
    })

    return { routines, runs }
  }

  save(store: RoutineStoreData, deleted?: PendingWorkflowDelete): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM workflow_step_runs;
        DELETE FROM workflow_runs;
        DELETE FROM workflow_steps;
        DELETE FROM workflows;
      `)
      this.insertStore(store)
      if (deleted) {
        this.db
          .prepare(
            `INSERT INTO sync_outbox (kind, origin, entity_id)
             SELECT 'workflow_delete', ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM sync_outbox
               WHERE kind = 'workflow_delete' AND origin = ? AND entity_id = ?
             )`,
          )
          .run(deleted.origin, deleted.workflowId, deleted.origin, deleted.workflowId)
      }
    })
  }

  claimWorkflowDeletes(origin: string, installationId: string): WorkflowDeleteIntent[] {
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE sync_outbox SET installation_id = ?
           WHERE kind = 'workflow_delete' AND origin = ? AND installation_id IS NULL`,
        )
        .run(installationId, origin)
      return this.db
        .prepare(
          `SELECT id, origin, installation_id, entity_id FROM sync_outbox
           WHERE kind = 'workflow_delete' AND origin = ? AND installation_id = ?
           ORDER BY id`,
        )
        .all(origin, installationId)
        .map((row) => ({
          id: requiredNumber(row.id),
          origin: requiredString(row.origin),
          installationId: requiredString(row.installation_id),
          workflowId: requiredString(row.entity_id),
        }))
    })
  }

  ackWorkflowDelete(id: number): void {
    this.db.prepare("DELETE FROM sync_outbox WHERE id = ? AND kind = 'workflow_delete'").run(id)
  }

  importWorkflowDeletes(entries: readonly WorkflowDeleteIntent[]): void {
    if (entries.length === 0) return
    this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO sync_outbox (kind, origin, installation_id, entity_id)
         VALUES ('workflow_delete', ?, ?, ?)`,
      )
      for (const entry of entries) {
        insert.run(entry.origin, entry.installationId, entry.workflowId)
      }
    })
  }

  setSyncState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now())
  }

  getSyncState(key: string): string | undefined {
    return optionalString(this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null)
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    const currentVersion = optionalNumber(
      this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null,
    ) ?? 0
    if (currentVersion < 1) this.migrateToVersion1()
    if (currentVersion < 2) this.migrateToVersion2()
    if (currentVersion < 3) this.migrateToVersion3()
  }

  private migrateToVersion1(): void {
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        input TEXT,
        workspace_path TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        notify TEXT NOT NULL,
        notify_channel_id TEXT,
        push_each_step INTEGER,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_slot_key TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_steps (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT,
        engine TEXT,
        channel_id TEXT,
        message TEXT,
        path TEXT,
        format TEXT,
        PRIMARY KEY (workflow_id, id),
        UNIQUE (workflow_id, position)
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        trigger_source TEXT,
        summary TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_step_runs (
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        image_url TEXT,
        artifact_path TEXT,
        duration_ms INTEGER NOT NULL,
        PRIMARY KEY (workflow_run_id, position)
      );
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        installation_id TEXT,
        entity_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
      );
      CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx
        ON sync_outbox (kind, origin, installation_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_workflow_delete_unique_idx
        ON sync_outbox (kind, origin, entity_id);
      INSERT INTO schema_migrations (version, applied_at)
        VALUES (1, unixepoch('subsec') * 1000);
    `))
  }

  private migrateToVersion2(): void {
    this.transaction(() => this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_workflow_delete_unique_idx
        ON sync_outbox (kind, origin, entity_id);
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
        VALUES (2, unixepoch('subsec') * 1000);
    `))
  }

  private migrateToVersion3(): void {
    // model3d 步骤的两个字段:图生 3D 服务商 + 输入图模板
    this.transaction(() => this.db.exec(`
      ALTER TABLE workflow_steps ADD COLUMN provider TEXT;
      ALTER TABLE workflow_steps ADD COLUMN image_ref TEXT;
      INSERT INTO schema_migrations (version, applied_at)
        VALUES (3, unixepoch('subsec') * 1000);
    `))
  }

  private importLegacyOnce(): void {
    const imported = this.db.prepare("SELECT value FROM metadata WHERE key = 'legacy_json_imported'").get()
    if (imported) return
    const store: RoutineStoreData = existsSync(this.legacyJsonPath)
      ? normalizeLegacyStore(JSON.parse(readFileSync(this.legacyJsonPath, 'utf8')))
      : { routines: [], runs: [] }
    if (existsSync(this.legacyJsonPath) && !existsSync(`${this.legacyJsonPath}.backup-v1`)) {
      copyFileSync(this.legacyJsonPath, `${this.legacyJsonPath}.backup-v1`)
    }
    this.transaction(() => {
      this.insertStore(store)
      this.db
        .prepare("INSERT INTO metadata (key, value) VALUES ('legacy_json_imported', ?)")
        .run(new Date().toISOString())
    })
  }

  private insertStore(store: RoutineStoreData): void {
    const insertWorkflow = this.db.prepare(`
      INSERT INTO workflows (
        id, name, input, workspace_path, schedule_json, enabled, notify,
        notify_channel_id, push_each_step, created_at, last_run_at, last_slot_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertStep = this.db.prepare(`
      INSERT INTO workflow_steps (
        workflow_id, id, position, name, type, prompt, engine, channel_id, message, path, format, provider, image_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const routine of store.routines) {
      insertWorkflow.run(
        routine.id,
        routine.name,
        routine.input ?? null,
        routine.workspacePath,
        JSON.stringify(routine.schedule),
        routine.enabled ? 1 : 0,
        routine.notify,
        routine.notifyChannelId ?? null,
        routine.pushEachStep === undefined ? null : routine.pushEachStep ? 1 : 0,
        routine.createdAt,
        routine.lastRunAt ?? null,
        routine.lastSlotKey ?? null,
      )
      routine.steps.forEach((step, position) => {
        insertStep.run(
          routine.id,
          step.id,
          position,
          step.name,
          step.type,
          step.prompt ?? null,
          step.engine ?? null,
          step.channelId ?? null,
          step.message ?? null,
          step.path ?? null,
          step.format ?? null,
          step.provider ?? null,
          step.imageRef ?? null,
        )
      })
    }

    const insertRun = this.db.prepare(`
      INSERT INTO workflow_runs (
        id, workflow_id, workflow_name, started_at, ended_at, status,
        trigger_source, summary, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertStepRun = this.db.prepare(`
      INSERT INTO workflow_step_runs (
        workflow_run_id, position, step_id, name, status, summary,
        image_url, artifact_path, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const run of store.runs) {
      insertRun.run(
        run.id,
        run.routineId,
        run.routineName,
        run.startedAt,
        run.endedAt,
        run.status,
        run.triggerSource ?? null,
        run.summary,
        run.error ?? null,
      )
      run.steps?.forEach((step, position) => {
        insertStepRun.run(
          run.id,
          position,
          step.id,
          step.name,
          step.status,
          step.summary,
          step.imageUrl ?? null,
          step.artifactPath ?? null,
          step.durationMs,
        )
      })
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

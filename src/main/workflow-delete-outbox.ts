import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

export type WorkflowDeleteIntent = {
  id: number
  origin: string
  installationId: string | null
  workflowId: string
}

export type WorkflowDeleteOutbox = {
  claimWorkflowDeletes: (origin: string, installationId: string) => WorkflowDeleteIntent[]
  ackWorkflowDelete: (id: number) => void
  setSyncState: (key: string, value: string) => void
}

/** Durable fallback and migration reader for the pre-SQLite delete queue. */
export class JsonWorkflowDeleteOutbox implements WorkflowDeleteOutbox {
  constructor(
    private readonly path: string,
    private readonly storePath?: string,
  ) {
    this.recoverPendingTransaction()
  }

  commitDelete(store: unknown, origin: string, workflowId: string): void {
    if (!this.storePath) throw new Error('JSON delete transaction requires a workflow store path')
    this.assertReady()
    const entries = this.withDelete(this.readAll(), origin, workflowId)
    const journal = JSON.stringify({ storeJson: JSON.stringify(store, null, 2), entries })
    this.atomicWrite(this.journalPath(), journal)
    this.recoverPendingTransaction()
  }

  add(origin: string, workflowId: string): void {
    const entries = this.readAll()
    this.writeAll(this.withDelete(entries, origin, workflowId))
  }

  readAll(): WorkflowDeleteIntent[] {
    if (!existsSync(this.path)) return []
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!Array.isArray(raw)) throw new Error('delete outbox must be an array')
      let nextId = raw.reduce(
        (maximum, entry) =>
          typeof entry === 'object' &&
          entry &&
          typeof (entry as { id?: unknown }).id === 'number' &&
          Number.isInteger((entry as { id: number }).id) &&
          (entry as { id: number }).id > 0
            ? Math.max(maximum, (entry as { id: number }).id)
            : maximum,
        0,
      )
      return raw.map((entry) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof (entry as { origin?: unknown }).origin !== 'string' ||
          !(
            (entry as { installationId?: unknown }).installationId === null ||
            typeof (entry as { installationId?: unknown }).installationId === 'string'
          ) ||
          typeof (entry as { workflowId?: unknown }).workflowId !== 'string'
        ) {
          throw new Error('delete outbox contains an invalid entry')
        }
        const candidate = entry as Omit<WorkflowDeleteIntent, 'id'> & { id?: unknown }
        return {
          id:
            typeof candidate.id === 'number' && Number.isInteger(candidate.id) && candidate.id > 0
              ? candidate.id
              : ++nextId,
          origin: candidate.origin,
          installationId: candidate.installationId,
          workflowId: candidate.workflowId,
        }
      })
    } catch (error) {
      throw new Error(`Cloud sync delete outbox is damaged: ${String(error)}`)
    }
  }

  claimWorkflowDeletes(origin: string, installationId: string): WorkflowDeleteIntent[] {
    const entries = this.readAll().map((entry) =>
      entry.origin === origin && entry.installationId === null
        ? { ...entry, installationId }
        : entry,
    )
    this.writeAll(entries)
    return entries.filter(
      (entry) => entry.origin === origin && entry.installationId === installationId,
    )
  }

  ackWorkflowDelete(id: number): void {
    this.writeAll(this.readAll().filter((entry) => entry.id !== id))
  }

  archiveAndClear(): void {
    if (existsSync(this.path) && !existsSync(`${this.path}.backup-v1`)) {
      copyFileSync(this.path, `${this.path}.backup-v1`)
    }
    this.writeAll([])
  }

  assertReady(): void {
    if (existsSync(this.journalPath())) {
      throw new Error('A workflow delete transaction needs restart recovery before more changes')
    }
  }

  // JSON fallback has no telemetry table. Sync-state persistence is best-effort.
  setSyncState(key: string, value: string): void {
    // Deliberately unavailable in JSON fallback mode.
    void key
    void value
  }

  private writeAll(entries: readonly WorkflowDeleteIntent[]): void {
    this.atomicWrite(this.path, JSON.stringify(entries, null, 2))
  }

  private withDelete(
    entries: readonly WorkflowDeleteIntent[],
    origin: string,
    workflowId: string,
  ): WorkflowDeleteIntent[] {
    if (entries.some((entry) => entry.origin === origin && entry.workflowId === workflowId)) {
      return [...entries]
    }
    const nextId = entries.reduce((maximum, entry) => Math.max(maximum, entry.id), 0) + 1
    return [...entries, { id: nextId, origin, installationId: null, workflowId }]
  }

  private recoverPendingTransaction(): void {
    const journalPath = this.journalPath()
    if (!existsSync(journalPath)) return
    if (!this.storePath) throw new Error('Workflow delete transaction journal has no store path')
    try {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        storeJson?: unknown
        entries?: unknown
      }
      if (typeof journal.storeJson !== 'string' || !Array.isArray(journal.entries)) {
        throw new Error('invalid transaction journal')
      }
      this.atomicWrite(this.storePath, journal.storeJson)
      this.writeAll(journal.entries as WorkflowDeleteIntent[])
      unlinkSync(journalPath)
    } catch (error) {
      throw new Error(`Cloud sync delete transaction recovery failed: ${String(error)}`)
    }
  }

  private journalPath(): string {
    return `${this.path}.transaction`
  }

  private atomicWrite(path: string, content: string): void {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  }
}

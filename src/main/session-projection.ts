import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionProjectionSnapshot } from '../shared/ipc/contract'

export type SessionProjectionLoad = {
  generation: number
  workspacePath: string
  sessionFile: string | null
}

const INITIAL_SNAPSHOT: SessionProjectionSnapshot = {
  revision: 0,
  workspacePath: null,
  sessionFile: null,
  source: 'durable-session',
  messages: [],
  updatedAt: null,
}

export class SessionProjectionTracker {
  private generation = 0
  private snap: SessionProjectionSnapshot = INITIAL_SNAPSHOT

  snapshot(): SessionProjectionSnapshot {
    return this.snap
  }

  beginLoad(workspacePath: string, sessionFile: string | null): SessionProjectionLoad {
    const generation = ++this.generation
    if (this.snap.workspacePath !== workspacePath || this.snap.sessionFile !== sessionFile) {
      this.snap = {
        revision: this.snap.revision + 1,
        workspacePath,
        sessionFile,
        source: 'durable-session',
        messages: [],
        updatedAt: null,
      }
    }
    return { generation, workspacePath, sessionFile }
  }

  commit(load: SessionProjectionLoad, messages: AgentMessage[]): SessionProjectionSnapshot {
    if (load.generation !== this.generation) return this.snap
    this.snap = {
      revision: this.snap.revision + 1,
      workspacePath: load.workspacePath,
      sessionFile: load.sessionFile,
      source: 'durable-session',
      messages,
      updatedAt: new Date().toISOString(),
    }
    return this.snap
  }

  clear(): SessionProjectionSnapshot {
    this.generation++
    if (
      this.snap.workspacePath === null &&
      this.snap.sessionFile === null &&
      this.snap.messages.length === 0
    ) {
      return this.snap
    }
    this.snap = {
      ...INITIAL_SNAPSHOT,
      revision: this.snap.revision + 1,
    }
    return this.snap
  }
}

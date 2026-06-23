import type { RpcClient as RpcClientType } from '@earendil-works/pi-coding-agent'
import type { AgentEvent } from '@earendil-works/pi-agent-core'

export type PiEventListener = (event: AgentEvent) => void

type RpcClient = RpcClientType

// `@earendil-works/pi-coding-agent` ships ESM-only (no "require" export
// condition), but electron-vite compiles the main process to CJS. A static
// `import` would become a `require()` that Node's exports resolution
// rejects, so we load it lazily via dynamic `import()` instead — that always
// goes through ESM resolution regardless of the caller's module format.
async function loadRpcClient(): Promise<typeof RpcClientType> {
  const mod = await import('@earendil-works/pi-coding-agent')
  return mod.RpcClient
}

/**
 * Owns the single active RpcClient (one `pi` CLI subprocess running RPC mode)
 * for the currently open workspace. Switching workspaces stops the old
 * subprocess and starts a fresh one — conversations within a workspace are
 * pi's own session concept (new_session/switch_session), not separate
 * subprocesses.
 */
class PiClientManager {
  private client: RpcClient | null = null
  private workspacePath: string | null = null
  private unsubscribe: (() => void) | null = null

  async startWorkspace(
    cwd: string,
    env: Record<string, string>,
    onEvent: PiEventListener,
  ): Promise<void> {
    await this.stop()

    const RpcClient = await loadRpcClient()
    const client = new RpcClient({ cwd, env })
    await client.start()

    this.client = client
    this.workspacePath = cwd
    this.unsubscribe = client.onEvent(onEvent)
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.client) {
      await this.client.stop().catch(() => {})
    }
    this.client = null
    this.workspacePath = null
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  private require(): RpcClient {
    if (!this.client) throw new Error('No workspace is open')
    return this.client
  }

  prompt(message: string): Promise<void> {
    return this.require().prompt(message)
  }

  steer(message: string): Promise<void> {
    return this.require().steer(message)
  }

  followUp(message: string): Promise<void> {
    return this.require().followUp(message)
  }

  abort(): Promise<void> {
    return this.require().abort()
  }

  bash(command: string): ReturnType<RpcClient['bash']> {
    return this.require().bash(command)
  }

  newSession(): ReturnType<RpcClient['newSession']> {
    return this.require().newSession()
  }

  getState(): ReturnType<RpcClient['getState']> {
    return this.require().getState()
  }

  getMessages(): ReturnType<RpcClient['getMessages']> {
    return this.require().getMessages()
  }

  getAvailableModels(): ReturnType<RpcClient['getAvailableModels']> {
    return this.require().getAvailableModels()
  }

  setModel(provider: string, modelId: string): ReturnType<RpcClient['setModel']> {
    return this.require().setModel(provider, modelId)
  }
}

export const piClientManager = new PiClientManager()

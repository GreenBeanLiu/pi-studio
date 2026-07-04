import { existsSync } from 'fs'
import { join } from 'path'
import type { RpcClient as RpcClientType } from '@earendil-works/pi-coding-agent'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'

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

// RpcClient's default cliPath is the *relative* string "dist/cli.js",
// resolved against the spawned process's `cwd` — which for us is the user's
// workspace directory, not pi-coding-agent's own install location. Has to be
// passed explicitly as an absolute path. `require.resolve()` can't be used
// here either (same exports-map problem as the dynamic import above), so we
// walk the plain node_modules search paths instead — that mechanism doesn't
// consult the package's "exports" map at all.
function resolvePiCliPath(): string {
  const searchPaths = require.resolve.paths('@earendil-works/pi-coding-agent') ?? []
  for (const base of searchPaths) {
    const candidate = join(base, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent/dist/cli.js')
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
    provider: string | undefined,
    model: string | undefined,
    onEvent: PiEventListener,
  ): Promise<void> {
    await this.stop()

    const RpcClient = await loadRpcClient()
    const client = new RpcClient({ cwd, env, provider, model, cliPath: resolvePiCliPath() })
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

  prompt(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().prompt(message, images)
  }

  steer(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().steer(message, images)
  }

  followUp(message: string, images?: ImageContent[]): Promise<void> {
    return this.require().followUp(message, images)
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

  switchSession(sessionPath: string): ReturnType<RpcClient['switchSession']> {
    return this.require().switchSession(sessionPath)
  }

  getCommands(): ReturnType<RpcClient['getCommands']> {
    return this.require().getCommands()
  }

  setSessionName(name: string): ReturnType<RpcClient['setSessionName']> {
    return this.require().setSessionName(name)
  }
}

export const piClientManager = new PiClientManager()

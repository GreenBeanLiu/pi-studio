import type { ImageContent } from '@earendil-works/pi-ai'
import type { RpcClient as RpcClientType } from '@earendil-works/pi-coding-agent'
import type { CompiledRunProfile } from './run-profile'
import { embeddedNodeEnv, loadRpcClient, resolveEmbeddedNodePath } from './pi-process'
import { DEFAULT_THINKING_LEVEL } from '../shared/agent-defaults'

type StartablePiClient = {
  start: () => Promise<void>
  setThinkingLevel: (level: typeof DEFAULT_THINKING_LEVEL) => Promise<void>
}
type PiClientConstructor<C extends StartablePiClient> = new (options: {
  cwd: string
  env: Record<string, string>
  runtimePath: string
  provider: string
  model?: string
  cliPath: string
  args: string[]
}) => C

type StartPiRuntimeDependencies<C extends StartablePiClient> = {
  loadClient: () => Promise<PiClientConstructor<C>>
  runtimePath: () => string
  nodeEnv: (env: Record<string, string>) => Record<string, string>
}

const DEFAULT_START_DEPENDENCIES: StartPiRuntimeDependencies<RpcClientType> = {
  loadClient: loadRpcClient,
  runtimePath: resolveEmbeddedNodePath,
  nodeEnv: embeddedNodeEnv,
}

/** Start a Pi process from one compiled, auditable launch profile. */
export function startPiRuntime(profile: CompiledRunProfile): Promise<RpcClientType>
export function startPiRuntime<C extends StartablePiClient>(
  profile: CompiledRunProfile,
  dependencies: StartPiRuntimeDependencies<C>,
): Promise<C>
export async function startPiRuntime(
  profile: CompiledRunProfile,
  dependencies?: StartPiRuntimeDependencies<StartablePiClient>,
): Promise<StartablePiClient> {
  const resolved = dependencies ?? DEFAULT_START_DEPENDENCIES
  const RpcClient = await resolved.loadClient()
  const client = new RpcClient({
    cwd: profile.cwd,
    env: resolved.nodeEnv(profile.env),
    runtimePath: resolved.runtimePath(),
    provider: profile.provider,
    model: profile.model,
    cliPath: profile.cliPath,
    args: profile.args,
  })
  await client.start()
  await client.setThinkingLevel(profile.thinkingLevel)
  return client
}

export type SettleAwarePiClient = {
  prompt: (message: string, images?: ImageContent[]) => Promise<void>
  waitForIdle: (timeout?: number) => Promise<void>
  abort: () => Promise<void>
}

export class PiRunTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Pi run did not settle within ${timeoutMs}ms`)
    this.name = 'PiRunTimeoutError'
  }
}

/** Run one headless Pi prompt through its real terminal condition. */
export async function runPromptToSettled(
  client: SettleAwarePiClient,
  message: string,
  timeoutMs: number,
  images?: ImageContent[],
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const run = (async () => {
      await client.prompt(message, images)
      // RpcClient defaults this helper to 60 seconds. Keep its cleanup timer
      // behind our owned deadline so longer run profiles retain their budget.
      await client.waitForIdle(timeoutMs + 1_000)
    })()
    await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PiRunTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } catch (error) {
    await client.abort().catch(() => {})
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

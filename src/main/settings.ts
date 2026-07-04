import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type PiProvider = 'anthropic' | 'openai'

export type Workspace = {
  path: string
  name: string
  lastOpenedAt: string
}

type SettingsData = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
  /** Comma/newline-separated model ids to show in the switcher; empty = auto */
  favoriteModels: string
  recentWorkspaces: Workspace[]
}

const DEFAULTS: SettingsData = {
  provider: 'anthropic',
  apiKey: '',
  model: '',
  baseUrl: '',
  favoriteModels: '',
  recentWorkspaces: [],
}

const MAX_RECENT_WORKSPACES = 10

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readRaw(): Record<string, unknown> {
  const p = settingsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeRaw(data: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function loadSettings(): SettingsData {
  const raw = readRaw()
  let apiKey = ''

  if (raw.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted as string, 'base64'))
    } catch {
      apiKey = ''
    }
  } else if (typeof raw.apiKey === 'string') {
    apiKey = raw.apiKey
  }

  return {
    provider: (raw.provider as PiProvider) ?? DEFAULTS.provider,
    apiKey,
    model: (raw.model as string) ?? DEFAULTS.model,
    baseUrl: (raw.baseUrl as string) ?? DEFAULTS.baseUrl,
    favoriteModels: (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? (raw.recentWorkspaces as Workspace[])
      : DEFAULTS.recentWorkspaces,
  }
}

export function saveSettings(
  settings: Pick<SettingsData, 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'favoriteModels'>,
): void {
  const raw = readRaw()

  if (safeStorage.isEncryptionAvailable() && settings.apiKey) {
    raw.apiKeyEncrypted = safeStorage.encryptString(settings.apiKey).toString('base64')
    delete raw.apiKey
  } else {
    raw.apiKey = settings.apiKey
    delete raw.apiKeyEncrypted
  }

  raw.provider = settings.provider
  raw.model = settings.model
  raw.baseUrl = settings.baseUrl
  raw.favoriteModels = settings.favoriteModels

  writeRaw(raw)
}

export function addRecentWorkspace(path: string): Workspace[] {
  const current = loadSettings().recentWorkspaces.filter((w) => w.path !== path)
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const next = [{ path, name, lastOpenedAt: new Date().toISOString() }, ...current].slice(
    0,
    MAX_RECENT_WORKSPACES,
  )
  const raw = readRaw()
  raw.recentWorkspaces = next
  writeRaw(raw)
  return next
}

export function removeRecentWorkspace(path: string): Workspace[] {
  const next = loadSettings().recentWorkspaces.filter((w) => w.path !== path)
  const raw = readRaw()
  raw.recentWorkspaces = next
  writeRaw(raw)
  return next
}

/** Provider env var name pi's RpcClient subprocess needs for auth. */
export function apiKeyEnvVar(provider: PiProvider): string {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
}

/**
 * pi's config (auth.json, models.json) normally lives at ~/.pi/agent — global
 * and shared with any other `pi` CLI install the user has. Point the spawned
 * subprocess at an app-private directory instead via PI_CODING_AGENT_DIR, so
 * pi-studio's third-party-gateway override below never leaks into / conflicts
 * with the user's own pi setup.
 */
export function agentConfigDir(): string {
  return join(app.getPath('userData'), 'pi-agent')
}

/**
 * Built-in providers support an "override-only" models.json entry — just a
 * baseUrl, no custom model list — that redirects every built-in model id for
 * that provider through a different (e.g. third-party OpenAI-compatible)
 * endpoint. Auth still comes from the provider's normal env var.
 */
export function writeModelsOverride(provider: PiProvider, baseUrl: string): void {
  const dir = agentConfigDir()
  mkdirSync(dir, { recursive: true })
  const modelsPath = join(dir, 'models.json')
  if (!baseUrl.trim()) {
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), 'utf-8')
    return
  }
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { [provider]: { baseUrl: baseUrl.trim() } } }, null, 2),
    'utf-8',
  )
}

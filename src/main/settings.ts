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
  /** Tavily API key enabling the web_search agent tool; empty = disabled */
  tavilyApiKey: string
  /** Helicone API key: routes LLM calls through Helicone for logging; empty = off */
  heliconeApiKey: string
  recentWorkspaces: Workspace[]
}

const DEFAULTS: SettingsData = {
  provider: 'anthropic',
  apiKey: '',
  model: '',
  baseUrl: '',
  favoriteModels: '',
  tavilyApiKey: '',
  heliconeApiKey: '',
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

function decryptField(raw: Record<string, unknown>, plainKey: string, encKey: string): string {
  if (raw[encKey] && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(raw[encKey] as string, 'base64'))
    } catch {
      return ''
    }
  }
  return typeof raw[plainKey] === 'string' ? (raw[plainKey] as string) : ''
}

function encryptField(
  raw: Record<string, unknown>,
  plainKey: string,
  encKey: string,
  value: string,
): void {
  if (safeStorage.isEncryptionAvailable() && value) {
    raw[encKey] = safeStorage.encryptString(value).toString('base64')
    delete raw[plainKey]
  } else {
    raw[plainKey] = value
    delete raw[encKey]
  }
}

export function loadSettings(): SettingsData {
  const raw = readRaw()
  const apiKey = decryptField(raw, 'apiKey', 'apiKeyEncrypted')

  return {
    provider: (raw.provider as PiProvider) ?? DEFAULTS.provider,
    apiKey,
    model: (raw.model as string) ?? DEFAULTS.model,
    baseUrl: (raw.baseUrl as string) ?? DEFAULTS.baseUrl,
    favoriteModels: (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
    tavilyApiKey: decryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted'),
    heliconeApiKey: decryptField(raw, 'heliconeApiKey', 'heliconeApiKeyEncrypted'),
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? (raw.recentWorkspaces as Workspace[])
      : DEFAULTS.recentWorkspaces,
  }
}

export function saveSettings(
  settings: Pick<
    SettingsData,
    'provider' | 'apiKey' | 'model' | 'baseUrl' | 'favoriteModels' | 'tavilyApiKey' | 'heliconeApiKey'
  >,
): void {
  const raw = readRaw()

  encryptField(raw, 'apiKey', 'apiKeyEncrypted', settings.apiKey)
  encryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted', settings.tavilyApiKey)
  encryptField(raw, 'heliconeApiKey', 'heliconeApiKeyEncrypted', settings.heliconeApiKey)

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

const DEFAULT_TARGET: Record<PiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
}

/**
 * Built-in providers support an "override-only" models.json entry (baseUrl +
 * headers, no custom model list) that redirects every built-in model id for
 * that provider through a different endpoint. Two uses here:
 *
 *  - Third-party OpenAI-compatible gateway: just a baseUrl override.
 *  - Helicone logging: route through Helicone's universal gateway
 *    (gateway.helicone.ai) with `Helicone-Auth` (the key, via the
 *    HELICONE_API_KEY env var so it never lands in models.json) and
 *    `Helicone-Target-Url` pointing at the *real* endpoint (the user's
 *    gateway if set, else the provider default). pi forwards its normal
 *    provider auth headers through, so Helicone just observes + relays.
 *
 * Auth for the model itself still comes from the provider's normal env var.
 */
export function writeModelsOverride(
  provider: PiProvider,
  baseUrl: string,
  heliconeEnabled: boolean,
): void {
  const dir = agentConfigDir()
  mkdirSync(dir, { recursive: true })
  const modelsPath = join(dir, 'models.json')

  let providerConfig: Record<string, unknown> | null = null

  if (heliconeEnabled) {
    const realTarget = baseUrl.trim() || DEFAULT_TARGET[provider]
    providerConfig = {
      baseUrl: 'https://gateway.helicone.ai',
      headers: {
        'Helicone-Auth': 'Bearer ${HELICONE_API_KEY}',
        'Helicone-Target-Url': realTarget,
      },
    }
  } else if (baseUrl.trim()) {
    providerConfig = { baseUrl: baseUrl.trim() }
  }

  const providers = providerConfig ? { [provider]: providerConfig } : {}
  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8')
}

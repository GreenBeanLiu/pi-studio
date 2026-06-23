import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

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
  recentWorkspaces: Workspace[]
}

const DEFAULTS: SettingsData = {
  provider: 'anthropic',
  apiKey: '',
  model: '',
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
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? (raw.recentWorkspaces as Workspace[])
      : DEFAULTS.recentWorkspaces,
  }
}

export function saveSettings(settings: Pick<SettingsData, 'provider' | 'apiKey' | 'model'>): void {
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

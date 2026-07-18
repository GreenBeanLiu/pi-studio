import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import {
  buildGatewayProviderConfigs,
  type LlmProviderProfile,
} from './llm-gateway'
import {
  parseFavoriteModelRoutes,
  type ModelRoute,
} from '../shared/model-route'
import {
  createDefaultSettingsForm,
  type PiProvider,
  type SettingsForm,
  type Workspace,
} from '../shared/contracts'

export type { PiProvider, Workspace } from '../shared/contracts'

export type SettingsData = SettingsForm & {
  favoriteModelRoutes: ModelRoute[]
  selectedModelRoute: ModelRoute | null
  customModelIds: string[]
  recentWorkspaces: Workspace[]
}

const DEFAULTS: SettingsData = {
  ...createDefaultSettingsForm(),
  favoriteModelRoutes: [],
  selectedModelRoute: null,
  customModelIds: [],
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
  const legacyImageProviderKeys = [
    'imageProviderMode',
    'imageSecondaryBaseUrl',
    'imageSecondaryKey',
    'imageSecondaryKeyEncrypted',
  ]
  if (legacyImageProviderKeys.some((key) => key in raw)) {
    for (const key of legacyImageProviderKeys) delete raw[key]
    writeRaw(raw)
  }
  const apiKey = decryptField(raw, 'apiKey', 'apiKeyEncrypted')

  const provider = (raw.provider as PiProvider) ?? DEFAULTS.provider
  const selectedModelRoute = raw.selectedModelRoute as Partial<ModelRoute> | undefined

  return {
    provider,
    apiKey,
    model: (raw.model as string) ?? DEFAULTS.model,
    baseUrl: (raw.baseUrl as string) ?? DEFAULTS.baseUrl,
    favoriteModels: (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
    favoriteModelRoutes: parseFavoriteModelRoutes(
      (raw.favoriteModels as string) ?? DEFAULTS.favoriteModels,
      provider,
    ),
    selectedModelRoute:
      typeof selectedModelRoute?.provider === 'string' &&
      typeof selectedModelRoute?.model === 'string' &&
      selectedModelRoute.provider.trim() &&
      selectedModelRoute.model.trim()
        ? { provider: selectedModelRoute.provider.trim(), model: selectedModelRoute.model.trim() }
        : null,
    tavilyApiKey: decryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted'),
    heliconeApiKey: decryptField(raw, 'heliconeApiKey', 'heliconeApiKeyEncrypted'),
    securityGuardEnabled:
      typeof raw.securityGuardEnabled === 'boolean'
        ? raw.securityGuardEnabled
        : DEFAULTS.securityGuardEnabled,
    sandboxEnabled:
      typeof raw.sandboxEnabled === 'boolean' ? raw.sandboxEnabled : DEFAULTS.sandboxEnabled,
    subagentsEnabled:
      typeof raw.subagentsEnabled === 'boolean' ? raw.subagentsEnabled : DEFAULTS.subagentsEnabled,
    feishuWebhookUrl: (raw.feishuWebhookUrl as string) ?? DEFAULTS.feishuWebhookUrl,
    feishuSecret: decryptField(raw, 'feishuSecret', 'feishuSecretEncrypted'),
    feishuAppId: (raw.feishuAppId as string) ?? DEFAULTS.feishuAppId,
    feishuAppSecret: decryptField(raw, 'feishuAppSecret', 'feishuAppSecretEncrypted'),
    feishuChatId: (raw.feishuChatId as string) ?? DEFAULTS.feishuChatId,
    customModelIds: Array.isArray(raw.customModelIds)
      ? (raw.customModelIds as string[])
      : DEFAULTS.customModelIds,
    imageEngine:
      raw.imageEngine === 'openai' || raw.imageEngine === 'gemini' || raw.imageEngine === 'grok'
        ? raw.imageEngine
        : DEFAULTS.imageEngine,
    cloudImageRelay: (raw.cloudImageRelay as string) ?? DEFAULTS.cloudImageRelay,
    cloudImageKey: decryptField(raw, 'cloudImageKey', 'cloudImageKeyEncrypted'),
    recentWorkspaces: Array.isArray(raw.recentWorkspaces)
      ? (raw.recentWorkspaces as Workspace[])
      : DEFAULTS.recentWorkspaces,
  }
}

export function saveSettings(settings: SettingsForm): void {
  const raw = readRaw()

  encryptField(raw, 'apiKey', 'apiKeyEncrypted', settings.apiKey)
  encryptField(raw, 'tavilyApiKey', 'tavilyApiKeyEncrypted', settings.tavilyApiKey)
  encryptField(raw, 'heliconeApiKey', 'heliconeApiKeyEncrypted', settings.heliconeApiKey)
  encryptField(raw, 'feishuSecret', 'feishuSecretEncrypted', settings.feishuSecret)
  encryptField(raw, 'feishuAppSecret', 'feishuAppSecretEncrypted', settings.feishuAppSecret)
  encryptField(raw, 'cloudImageKey', 'cloudImageKeyEncrypted', settings.cloudImageKey)
  raw.provider = settings.provider
  raw.model = settings.model
  raw.baseUrl = settings.baseUrl
  raw.favoriteModels = settings.favoriteModels
  raw.securityGuardEnabled = settings.securityGuardEnabled
  raw.sandboxEnabled = settings.sandboxEnabled
  raw.subagentsEnabled = settings.subagentsEnabled
  raw.feishuWebhookUrl = settings.feishuWebhookUrl
  raw.feishuAppId = settings.feishuAppId
  raw.feishuChatId = settings.feishuChatId
  raw.imageEngine = settings.imageEngine
  raw.cloudImageRelay = settings.cloudImageRelay

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

export function saveCustomModelIds(ids: string[]): void {
  const raw = readRaw()
  raw.customModelIds = ids
  writeRaw(raw)
}

export function saveSelectedModelRoute(provider: string, model: string): void {
  const raw = readRaw()
  raw.selectedModelRoute = { provider: provider.trim(), model: model.trim() }
  writeRaw(raw)
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
  customModelIds: string[] = [],
  gatewayRelay = '',
  gatewayProfiles?: LlmProviderProfile[],
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

  // 第三方网关的自定义模型 id(内置 registry 没有的):写进 models 数组,
  // pi 会 merge 进该 provider(内置模型保留)。注意同 id 会替换内置条目
  // 丢失元数据,所以调用方只传"缺失"的 id。
  const ids = customModelIds.map((s) => s.trim()).filter(Boolean)
  if (ids.length > 0) {
    providerConfig = { ...(providerConfig ?? {}), models: ids.map((id) => ({ id })) }
  }

  let providers: Record<string, unknown> = {}
  if (gatewayProfiles === undefined && existsSync(modelsPath)) {
    try {
      const existing = JSON.parse(readFileSync(modelsPath, 'utf-8')) as {
        providers?: Record<string, unknown>
      }
      providers = { ...(existing.providers ?? {}) }
    } catch {
      providers = {}
    }
  }
  if (providerConfig) providers[provider] = providerConfig
  else delete providers[provider]
  if (gatewayRelay.trim() && gatewayProfiles) {
    Object.assign(providers, buildGatewayProviderConfigs(gatewayRelay, gatewayProfiles))
  }
  writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8')
}

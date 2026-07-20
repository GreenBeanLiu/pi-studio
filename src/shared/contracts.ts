import type { ModelRoute } from './model-route'

export type PiProvider = 'anthropic' | 'openai'
export type ImageEngine = '' | 'openai' | 'gemini' | 'grok'

export type Workspace = {
  path: string
  name: string
  lastOpenedAt: string
}

export type LlmProviderProfile = {
  id: string
  display_name: string
  base_url?: string
  api_type: 'openai-completions'
  models: string[]
  enabled: boolean
  sort_order: number
  has_key: boolean
}

export type LlmProfileWrite = {
  id: string
  display_name: string
  base_url: string
  api_type: 'openai-completions'
  api_key: string
  models: string[]
  enabled: boolean
  sort_order: number
}

export type LlmProfileSavePayload =
  | { create: true; profile: LlmProfileWrite }
  | { create: false; profile: LlmProfileWrite }

export type SettingsForm = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
  favoriteModels: string
  tavilyApiKey: string
  heliconeApiKey: string
  securityGuardEnabled: boolean
  sandboxEnabled: boolean
  subagentsEnabled: boolean
  remoteEnabled: boolean
  feishuWebhookUrl: string
  feishuSecret: string
  feishuAppId: string
  feishuAppSecret: string
  feishuChatId: string
  imageEngine: ImageEngine
  cloudImageRelay: string
  cloudImageKey: string
}

export type SettingsView = SettingsForm & {
  favoriteModelRoutes: ModelRoute[]
  selectedModelRoute: ModelRoute | null
  cloudImageKeyConfigured: boolean
  modelAccessConfigured: boolean
  recentWorkspaces: Workspace[]
}

export type SettingsSaveInput = SettingsForm & {
  clearCloudImageKey?: boolean
}

export type ModelCatalogView = {
  providerLabels: Record<string, string>
}

export function createDefaultSettingsForm(): SettingsForm {
  return {
    provider: 'anthropic',
    apiKey: '',
    model: '',
    baseUrl: '',
    favoriteModels: '',
    tavilyApiKey: '',
    heliconeApiKey: '',
    securityGuardEnabled: true,
    sandboxEnabled: false,
    subagentsEnabled: true,
    remoteEnabled: false,
    feishuWebhookUrl: '',
    feishuSecret: '',
    feishuAppId: '',
    feishuAppSecret: '',
    feishuChatId: '',
    imageEngine: '',
    cloudImageRelay: '',
    cloudImageKey: '',
  }
}

export function createDefaultSettingsView(): SettingsView {
  return {
    ...createDefaultSettingsForm(),
    favoriteModelRoutes: [],
    selectedModelRoute: null,
    cloudImageKeyConfigured: false,
    modelAccessConfigured: false,
    recentWorkspaces: [],
  }
}

import { describe, expect, it } from 'vitest'
import { createSettingsView } from './settings-view'
import type { SettingsData } from './settings'

const settings: SettingsData = {
  provider: 'openai',
  apiKey: 'local-model-key',
  model: 'gpt-4o',
  baseUrl: '',
  favoriteModels: '',
  favoriteModelRoutes: [],
  selectedModelRoute: null,
  tavilyApiKey: '',
  heliconeApiKey: '',
  securityGuardEnabled: true,
  sandboxEnabled: false,
  subagentsEnabled: true,
  feishuWebhookUrl: '',
  feishuSecret: '',
  feishuAppId: '',
  feishuAppSecret: '',
  feishuChatId: '',
  customModelIds: [],
  imageEngine: '',
  comfyDir: '',
  comfyPythonPath: '',
  comfyLaunchArgs: '',
  comfyCheckpoint: '',
  cloudImageRelay: 'https://trail-api.glanger.xyz',
  cloudImageKey: 'desktop-admin-key',
  recentWorkspaces: [],
}

describe('renderer settings view', () => {
  it('reports cloud readiness without exposing the stored admin key', () => {
    const view = createSettingsView(settings, true)

    expect(view.cloudImageKey).toBe('')
    expect(view.cloudImageKeyConfigured).toBe(true)
    expect(view.modelAccessConfigured).toBe(true)
    expect(JSON.stringify(view)).not.toContain('desktop-admin-key')
  })
})

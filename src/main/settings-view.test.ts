import { describe, expect, it } from 'vitest'
import { createSettingsView } from './settings-view'
import type { SettingsData } from './settings'

const settings: SettingsData = {
  favoriteModels: '',
  favoriteModelRoutes: [],
  selectedModelRoute: null,
  tavilyApiKey: '',
  sandboxEnabled: false,
  subagentsEnabled: true,
  remoteEnabled: false,
  feishuWebhookUrl: '',
  feishuSecret: '',
  feishuAppId: '',
  feishuAppSecret: '',
  feishuChatId: '',
  imageEngine: '',
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

  // 直连退役后能不能用模型完全看云端线路,没有本地 key 兜底了。
  it('reports no model access when the cloud lane is unavailable', () => {
    expect(createSettingsView(settings, false).modelAccessConfigured).toBe(false)
  })
})

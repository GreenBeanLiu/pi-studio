import type { SettingsView } from '../shared/contracts'
import type { SettingsData } from './settings'

/** Builds the renderer-safe settings snapshot; the backend admin key stays in main. */
export function createSettingsView(
  settings: SettingsData,
  cloudAvailable: boolean,
): SettingsView {
  const { cloudImageKey: _cloudImageKey, ...visible } = settings
  void _cloudImageKey
  return {
    ...visible,
    cloudImageKey: '',
    cloudImageKeyConfigured: !!settings.cloudImageKey,
    // 直连退役后,能不能用模型完全取决于云端线路。
    modelAccessConfigured: cloudAvailable,
  }
}

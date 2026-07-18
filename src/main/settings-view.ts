import type { SettingsView } from '../shared/contracts'
import type { SettingsData } from './settings'

/** Builds the renderer-safe settings snapshot; the backend admin key stays in main. */
export function createSettingsView(
  settings: SettingsData,
  cloudAvailable: boolean,
): SettingsView {
  const { cloudImageKey: _cloudImageKey, customModelIds: _customModelIds, ...visible } = settings
  void _cloudImageKey
  void _customModelIds
  return {
    ...visible,
    cloudImageKey: '',
    cloudImageKeyConfigured: !!settings.cloudImageKey,
    modelAccessConfigured: !!settings.apiKey || cloudAvailable,
  }
}

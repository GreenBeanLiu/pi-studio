import { app } from 'electron'
import { resolveCloudImageConfig, type CloudImageConfig } from './network-policy'
import { loadSettings } from './settings'

declare const __CLOUD_IMAGE_RELAY__: string

export type CloudConnection = CloudImageConfig

export type CloudConnectionSources = {
  savedRelay: string
  savedKey: string
  env: Readonly<Record<string, string | undefined>>
  builtInRelay: string
  allowHttpLoopback?: boolean
}

/**
 * Resolves the single Pi Studio backend connection shared by image, LLM, and 3D features.
 * The legacy PI_CLOUD_IMAGE_* names remain environment fallbacks for installed clients.
 */
export function resolveCloudConnection(sources: CloudConnectionSources): CloudConnection {
  return resolveCloudImageConfig(
    {
      PI_CLOUD_IMAGE_KEY:
        sources.savedKey.trim() || sources.env.PI_CLOUD_IMAGE_KEY?.trim() || '',
      PI_CLOUD_IMAGE_RELAY:
        sources.savedRelay.trim() ||
        sources.env.PI_CLOUD_IMAGE_RELAY?.trim() ||
        sources.builtInRelay,
    },
    { allowHttpLoopback: sources.allowHttpLoopback },
  )
}

export function getCloudConnection(): CloudConnection {
  const settings = loadSettings()
  return resolveCloudConnection({
    savedRelay: settings.cloudImageRelay,
    savedKey: settings.cloudImageKey,
    env: process.env,
    builtInRelay: __CLOUD_IMAGE_RELAY__,
    allowHttpLoopback: !app.isPackaged,
  })
}

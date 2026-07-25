import { describe, expect, it } from 'vitest'
import { resolveCloudConnection, resolveDraftCloudConnection } from './cloud-connection'

describe('Pi Studio cloud connection', () => {
  it('uses the saved connection for every cloud capability', () => {
    const connection = resolveCloudConnection({
      savedRelay: 'https://trail-api.glanger.xyz/',
      savedKey: 'saved-app-key',
      env: {
        PI_CLOUD_IMAGE_RELAY: 'https://ignored.example',
        PI_CLOUD_IMAGE_KEY: 'ignored-key',
      },
      builtInRelay: 'https://built-in.example',
    })

    expect(connection).toEqual({
      available: true,
      relay: 'https://trail-api.glanger.xyz',
      key: 'saved-app-key',
      error: null,
    })
  })

  it('keeps the legacy environment names as a migration fallback', () => {
    const connection = resolveCloudConnection({
      savedRelay: '',
      savedKey: '',
      env: {
        PI_CLOUD_IMAGE_RELAY: 'https://legacy.example/',
        PI_CLOUD_IMAGE_KEY: 'legacy-key',
      },
      builtInRelay: 'https://built-in.example',
    })

    expect(connection.available).toBe(true)
    expect(connection.relay).toBe('https://legacy.example')
    expect(connection.key).toBe('legacy-key')
  })

  it('uses unsaved draft values while testing Settings', () => {
    const connection = resolveDraftCloudConnection(
      {
        savedRelay: 'https://saved.example',
        savedKey: 'saved-key',
        env: {},
        builtInRelay: 'https://built-in.example',
      },
      { relay: 'https://draft.example/', key: 'draft-key' },
    )

    expect(connection).toMatchObject({
      available: true,
      relay: 'https://draft.example',
      key: 'draft-key',
    })
  })

  it('falls back to the encrypted saved key hidden from Settings', () => {
    const connection = resolveDraftCloudConnection(
      {
        savedRelay: 'https://saved.example',
        savedKey: 'saved-key',
        env: {},
        builtInRelay: 'https://built-in.example',
      },
      { relay: 'https://draft.example', key: '' },
    )

    expect(connection.available && connection.key).toBe('saved-key')
  })
})

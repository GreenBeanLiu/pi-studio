import { expect, test } from 'vitest'
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  resolveCloudImageConfig,
} from '../src/main/network-policy'

test('cloud image config is unavailable without an explicit API key', () => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_RELAY: 'https://images.example.com',
  })

  expect(config.available).toBe(false)
  expect(config.error).toMatch(/PI_CLOUD_IMAGE_KEY/)
})

test('cloud image config is unavailable without an explicit relay', () => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
  })

  expect(config.available).toBe(false)
  expect(config.error).toMatch(/PI_CLOUD_IMAGE_RELAY/)
})

test('cloud image config rejects plaintext relays outside the local machine', () => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
    PI_CLOUD_IMAGE_RELAY: 'http://images.example.com:8000',
  })

  expect(config.available).toBe(false)
  expect(config.error).toMatch(/HTTPS/)
})

test('cloud image config permits plaintext loopback relays for local development', () => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
    PI_CLOUD_IMAGE_RELAY: 'http://127.0.0.1:8000/',
  })

  expect(config).toEqual({
    available: true,
    key: 'configured-at-runtime',
    relay: 'http://127.0.0.1:8000',
    error: null,
  })
})

test('cloud image config rejects plaintext loopback relays in production', () => {
  const config = resolveCloudImageConfig(
    {
      PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
      PI_CLOUD_IMAGE_RELAY: 'http://localhost:8000',
    },
    { allowHttpLoopback: false },
  )

  expect(config.available).toBe(false)
  expect(config.error).toMatch(/HTTPS/)
})

test('cloud image config normalizes a valid HTTPS relay base URL', () => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
    PI_CLOUD_IMAGE_RELAY: 'https://images.example.com/api/',
  })

  expect(config).toEqual({
    available: true,
    key: 'configured-at-runtime',
    relay: 'https://images.example.com/api',
    error: null,
  })
})

test.each([
  'https://images.example.com?tenant=one',
  'https://images.example.com/#fragment',
  'https://user:password@images.example.com',
])('cloud image config rejects a relay that is not a clean base URL: %s', (relay) => {
  const config = resolveCloudImageConfig({
    PI_CLOUD_IMAGE_KEY: 'configured-at-runtime',
    PI_CLOUD_IMAGE_RELAY: relay,
  })

  expect(config.available).toBe(false)
  expect(config.error).toMatch(/base URL/)
})

test('external navigation only permits HTTP and HTTPS URLs', () => {
  expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true)
  expect(isAllowedExternalUrl('http://example.com/docs')).toBe(true)
  expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
  expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  expect(isAllowedExternalUrl('not a url')).toBe(false)
})

test('renderer navigation only permits the configured development origin', () => {
  const rendererUrl = 'http://127.0.0.1:5173/'

  expect(isAllowedRendererNavigation('http://127.0.0.1:5173/settings', rendererUrl)).toBe(true)
  expect(isAllowedRendererNavigation('http://example.com/', rendererUrl)).toBe(false)
  expect(isAllowedRendererNavigation('file:///C:/Windows/System32/calc.exe', rendererUrl)).toBe(false)
})

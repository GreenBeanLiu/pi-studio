export const PRODUCTION_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

export type CloudImageConfig =
  | { available: true; key: string; relay: string; error: null }
  | { available: false; key: null; relay: string; error: string }

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

export function resolveCloudImageConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { allowHttpLoopback?: boolean } = {},
): CloudImageConfig {
  const key = env.PI_CLOUD_IMAGE_KEY?.trim() || null
  const relayValue = env.PI_CLOUD_IMAGE_RELAY?.trim() || ''
  const relay = relayValue.replace(/\/+$/, '')

  if (!key) {
    return {
      available: false,
      key: null,
      relay,
      error: 'Cloud image generation requires PI_CLOUD_IMAGE_KEY.',
    }
  }

  if (!relay) {
    return {
      available: false,
      key: null,
      relay,
      error: 'Cloud image generation requires PI_CLOUD_IMAGE_RELAY.',
    }
  }

  let url: URL
  try {
    url = new URL(relay)
  } catch {
    return {
      available: false,
      key: null,
      relay,
      error: 'PI_CLOUD_IMAGE_RELAY must be a valid URL.',
    }
  }

  if (url.username || url.password || url.search || url.hash) {
    return {
      available: false,
      key: null,
      relay,
      error: 'PI_CLOUD_IMAGE_RELAY must be a base URL without credentials, a query, or a fragment.',
    }
  }

  const allowHttpLoopback = options.allowHttpLoopback ?? true
  const isAllowedHttpLoopback =
    allowHttpLoopback && url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !isAllowedHttpLoopback) {
    return {
      available: false,
      key: null,
      relay,
      error: 'PI_CLOUD_IMAGE_RELAY must use HTTPS (HTTP loopback relays are development-only).',
    }
  }

  url.pathname = url.pathname.replace(/\/+$/, '')
  const normalizedRelay = url.toString().replace(/\/$/, '')
  return { available: true, key, relay: normalizedRelay, error: null }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function isAllowedRendererNavigation(
  value: string,
  developmentRendererUrl?: string,
): boolean {
  if (!developmentRendererUrl) return false
  try {
    return new URL(value).origin === new URL(developmentRendererUrl).origin
  } catch {
    return false
  }
}

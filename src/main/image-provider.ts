export type ImageCloudProviderId = 'primary' | 'secondary'
export type ImageProviderMode = 'failover' | 'round-robin'
export type CloudImageSize = 'square_hd' | 'landscape_4_3' | 'portrait_4_3'

const SIZE_MAP: Record<CloudImageSize, string> = {
  square_hd: '1024x1024',
  landscape_4_3: '1536x1024',
  portrait_4_3: '1024x1536',
}

export function openAIImageSize(size: CloudImageSize | undefined): string {
  return SIZE_MAP[size ?? 'square_hd']
}

export function normalizeOpenAIBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:') throw new Error('备用图像 Provider 地址必须使用 HTTPS')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1'
  if (url.pathname === '/') url.pathname = '/v1'
  return url.toString().replace(/\/$/, '')
}

export function sameProviderOrigin(left: string, right: string): boolean {
  try {
    return new URL(normalizeOpenAIBaseUrl(left)).origin === new URL(normalizeOpenAIBaseUrl(right)).origin
  } catch {
    return false
  }
}

export function providerOrder(
  mode: ImageProviderMode,
  cursor: number,
  primaryAvailable: boolean,
  secondaryAvailable: boolean,
): ImageCloudProviderId[] {
  if (!primaryAvailable) return secondaryAvailable ? ['secondary'] : []
  if (!secondaryAvailable) return ['primary']
  if (mode === 'round-robin' && cursor % 2 === 1) return ['secondary', 'primary']
  return ['primary', 'secondary']
}

export function isRetryableImageProviderError(message: string): boolean {
  return /(?:超时|timeout|fetch failed|连接|断开|网络|network|\b408\b|\b409\b|\b429\b|\b5\d\d\b)/i.test(
    message,
  )
}

export type OpenAIImagePayload = {
  model: string
  prompt: string
  n: number
  size: string
}

export function buildOpenAIImagePayload(
  prompt: string,
  size: CloudImageSize | undefined,
  model = 'gpt-image-2',
): OpenAIImagePayload {
  return { model, prompt, n: 1, size: openAIImageSize(size) }
}

export function parseOpenAIImageResponse(value: unknown):
  | { b64: string; mimeType: string }
  | { url: string }
  | { error: string } {
  if (!value || typeof value !== 'object') return { error: '备用 Provider 返回了无效 JSON' }
  const body = value as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>
    error?: { message?: unknown } | string
  }
  const first = body.data?.[0]
  if (typeof first?.b64_json === 'string' && first.b64_json) {
    return { b64: first.b64_json, mimeType: 'image/png' }
  }
  if (typeof first?.url === 'string' && first.url) return { url: first.url }
  const error =
    typeof body.error === 'string'
      ? body.error
      : typeof body.error?.message === 'string'
        ? body.error.message
        : '备用 Provider 没有返回图片'
  return { error }
}

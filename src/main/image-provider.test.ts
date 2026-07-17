import { describe, expect, it } from 'vitest'
import {
  buildOpenAIImagePayload,
  isRetryableImageProviderError,
  normalizeOpenAIBaseUrl,
  parseOpenAIImageResponse,
  providerOrder,
  sameProviderOrigin,
} from './image-provider'

describe('image provider load balancing', () => {
  it('normalizes an HTTPS OpenAI-compatible base URL', () => {
    expect(normalizeOpenAIBaseUrl('https://www.3a-api.com')).toBe('https://www.3a-api.com/v1')
    expect(normalizeOpenAIBaseUrl('https://www.3a-api.com/v1/')).toBe('https://www.3a-api.com/v1')
    expect(() => normalizeOpenAIBaseUrl('http://www.3a-api.com/v1')).toThrow(/HTTPS/)
    expect(sameProviderOrigin('https://www.3a-api.com', 'https://www.3a-api.com/v1')).toBe(true)
    expect(sameProviderOrigin('https://api.openai.com/v1', 'https://www.3a-api.com/v1')).toBe(false)
  })

  it('maps app aspect ratios to gpt-image dimensions', () => {
    expect(buildOpenAIImagePayload('test', 'square_hd')).toEqual({
      model: 'gpt-image-2',
      prompt: 'test',
      n: 1,
      size: '1024x1024',
    })
    expect(buildOpenAIImagePayload('test', 'landscape_4_3').size).toBe('1536x1024')
    expect(buildOpenAIImagePayload('test', 'portrait_4_3').size).toBe('1024x1536')
  })

  it('uses primary-first failover or alternates round-robin requests', () => {
    expect(providerOrder('failover', 9, true, true)).toEqual(['primary', 'secondary'])
    expect(providerOrder('round-robin', 0, true, true)).toEqual(['primary', 'secondary'])
    expect(providerOrder('round-robin', 1, true, true)).toEqual(['secondary', 'primary'])
    expect(providerOrder('round-robin', 1, false, true)).toEqual(['secondary'])
  })

  it('parses base64 and URL image responses', () => {
    expect(parseOpenAIImageResponse({ data: [{ b64_json: 'abc' }] })).toEqual({
      b64: 'abc',
      mimeType: 'image/png',
    })
    expect(parseOpenAIImageResponse({ data: [{ url: 'https://example.com/a.png' }] })).toEqual({
      url: 'https://example.com/a.png',
    })
  })

  it('only retries transport, throttling and server errors', () => {
    expect(isRetryableImageProviderError('云端中继 503')).toBe(true)
    expect(isRetryableImageProviderError('request timeout')).toBe(true)
    expect(isRetryableImageProviderError('content policy violation')).toBe(false)
  })
})

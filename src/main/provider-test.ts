import type { PiProvider } from './settings'

export type ProviderConnectionSettings = {
  provider: PiProvider
  apiKey: string
  model: string
  baseUrl: string
}

export type ProviderConnectionResult =
  | { ok: true; message: string; details?: string }
  | { ok: false; message: string; details?: string }

export type ProviderModelListResult =
  | { ok: true; message: string; models: string[] }
  | { ok: false; message: string; details?: string }

const DEFAULT_BASE_URL: Record<PiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function joinApiPath(baseUrl: string, path: string): string {
  const base = stripTrailingSlash(baseUrl)
  if (base.endsWith('/v1')) return `${base}${path.replace(/^\/v1/, '')}`
  return `${base}${path}`
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = payload as Record<string, unknown>
  const error = data.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  const message = data.message
  return typeof message === 'string' ? message : undefined
}

async function fetchJson(url: string, init: RequestInit): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { response, data }
  } finally {
    clearTimeout(timeout)
  }
}

function modelCount(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const maybeData = (data as Record<string, unknown>).data
  return Array.isArray(maybeData) ? maybeData.length : null
}

function modelIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const maybeData = (data as Record<string, unknown>).data
  if (!Array.isArray(maybeData)) return []
  return maybeData
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const id = (item as Record<string, unknown>).id
      return typeof id === 'string' ? id.trim() : ''
    })
    .filter(Boolean)
}

async function fetchProviderModels(settings: ProviderConnectionSettings): Promise<{
  response: Response
  data: unknown
}> {
  const apiKey = settings.apiKey.trim()
  const provider = settings.provider
  const baseUrl = stripTrailingSlash(settings.baseUrl.trim() || DEFAULT_BASE_URL[provider])
  const url = joinApiPath(baseUrl, '/v1/models')

  if (provider === 'openai') {
    return fetchJson(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
  }

  return fetchJson(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    },
  })
}

function providerName(provider: PiProvider): string {
  return provider === 'openai' ? 'OpenAI' : 'Anthropic'
}

export async function testProviderConnection(
  settings: ProviderConnectionSettings,
): Promise<ProviderConnectionResult> {
  const apiKey = settings.apiKey.trim()
  if (!apiKey) {
    return { ok: false, message: 'API Key 为空', details: '请先填写模型服务 API Key。' }
  }

  const provider = settings.provider

  try {
    const { response, data } = await fetchProviderModels(settings)
    const name = providerName(provider)

    if (!response.ok) {
      return {
        ok: false,
        message: `${name} 连接失败：HTTP ${response.status}`,
        details: readErrorMessage(data) ?? response.statusText,
      }
    }

    const count = modelCount(data)
    return {
      ok: true,
      message: count === null ? `${name} 连接成功` : `${name} 连接成功，读取到 ${count} 个模型`,
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? '连接超时'
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, message: '连接测试失败', details: message }
  }
}

export async function listProviderModels(
  settings: ProviderConnectionSettings,
): Promise<ProviderModelListResult> {
  const apiKey = settings.apiKey.trim()
  if (!apiKey) {
    return { ok: false, message: 'API Key 为空', details: '请先填写模型服务 API Key。' }
  }

  const name = providerName(settings.provider)
  try {
    const { response, data } = await fetchProviderModels(settings)
    if (!response.ok) {
      return {
        ok: false,
        message: `${name} 模型读取失败：HTTP ${response.status}`,
        details: readErrorMessage(data) ?? response.statusText,
      }
    }

    const models = modelIds(data)
    if (models.length === 0) {
      return {
        ok: false,
        message: '没有读取到模型',
        details: '接口返回了 /v1/models 响应，但没有 data[].id。',
      }
    }

    return {
      ok: true,
      message: `读取到 ${models.length} 个模型`,
      models,
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? '连接超时'
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, message: '模型读取失败', details: message }
  }
}

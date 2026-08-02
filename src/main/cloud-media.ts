import { getCloudConnection } from './cloud-connection'
import { writeFileSync } from 'fs'

export async function cloudMediaFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const cloud = getCloudConnection()
  if (!cloud.available) throw new Error(cloud.error ?? '云端服务未配置')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return fetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

export async function uploadCloudImageReference(dataUrl: string): Promise<string> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw new Error('图片 data URL 无法解析')
  const response = await cloudMediaFetch(
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: match[2], content_type: match[1] }),
    },
    60_000,
  )
  if (!response.ok) throw new Error(`图片上传失败(${response.status}): ${(await response.text()).slice(0, 200)}`)
  const result = (await response.json()) as { url?: string }
  if (!result.url) throw new Error('图片上传成功但没有返回 URL')
  return result.url
}

export async function readCloudSseResult(
  response: Response,
  onStatus: (stage: string) => void,
): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    throw new Error(`云端中继 ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let separator = buffer.indexOf('\n\n')
    while (separator >= 0) {
      const block = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const raw = /^data: (.+)$/m.exec(block)?.[1]
      if (event && raw) {
        const data = JSON.parse(raw) as Record<string, unknown>
        if (event === 'error') throw new Error(String(data.message ?? '云端媒体任务失败'))
        if (event === 'status') onStatus(String(data.stage ?? 'running'))
        if (event === 'result') return data
      }
      separator = buffer.indexOf('\n\n')
    }
  }
  throw new Error('云端媒体任务结束但没有返回结果')
}

export async function downloadCloudMedia(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`媒体下载失败 HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > 512 * 1024 * 1024) throw new Error('媒体文件超过 512MB')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 512 * 1024 * 1024) throw new Error('媒体文件超过 512MB')
  writeFileSync(destination, bytes)
}

export function localMediaFileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/')}`
}

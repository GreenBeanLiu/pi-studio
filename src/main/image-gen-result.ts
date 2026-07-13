export type ResolvedCloudImage = {
  dataUrl: string
  publicUrl: string
  downloadError?: string
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * A workflow only needs the durable R2 URL. The image page also prefers a data URL so canvas
 * editing is not exposed to cross-origin restrictions, but a failed preview download must not
 * turn an already-completed cloud generation into a failed generation.
 */
export async function resolveCloudImageResult(
  url: string,
  downloadDataUrl: boolean,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 20_000,
): Promise<ResolvedCloudImage | { error: string }> {
  if (!downloadDataUrl) return { dataUrl: url, publicUrl: url }

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { error: `下载结果图失败(${response.status})` }

    const contentType = response.headers.get('content-type') || 'image/png'
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64')
    return { dataUrl: `data:${contentType};base64,${base64}`, publicUrl: url }
  } catch (error) {
    return { dataUrl: url, publicUrl: url, downloadError: errorMessage(error) }
  }
}

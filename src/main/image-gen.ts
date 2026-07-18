import { app, ipcMain } from 'electron'
import { appendAppLog } from './app-log'
import { isCompatibleCheckpoint } from './comfy-workflow'
import { ComfyRuntime, parseLaunchArgs, type ComfyRuntimeHealth } from './comfy-runtime'
import { getCloudConnection } from './cloud-connection'
import { loadSettings } from './settings'
import { resolveCloudImageResult } from './image-gen-result'

// 本地引擎:直连 ComfyUI(默认 8188,可由本应用托管启停)。
// 云端引擎:客户端只连 TrailAI;Provider 调度、Hatchet 执行和 R2 归档均在服务端。
const COMFY_BASE = (process.env.PI_COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '')
const COMFY_DIR_DEFAULT = process.env.PI_COMFY_DIR || 'D:\\Works\\ComfyUI'
const COMFY_CKPT_PREFERRED = process.env.PI_COMFY_CHECKPOINT?.trim() || ''
const COMFY_TIMEOUT_MS = 150_000
const CLOUD_TIMEOUT_MS = 320_000

/** ComfyUI 目录:设置页覆盖 > 内置默认。 */
const comfyDir = (): string => loadSettings().comfyDir?.trim() || COMFY_DIR_DEFAULT

const comfyRuntime = new ComfyRuntime(
  () => {
    const settings = loadSettings()
    return {
      baseUrl: COMFY_BASE,
      comfyDir: comfyDir(),
      pythonPath: settings.comfyPythonPath,
      launchArgs: parseLaunchArgs(settings.comfyLaunchArgs),
      checkpoint: settings.comfyCheckpoint?.trim() || '',
    }
  },
  {
    onLog: (message) => appendAppLog('warn', 'imagegen.comfy', message),
  },
)

const NEGATIVE =
  'text, letters, words, watermark, signature, blurry, lowres, jpeg artifacts, frame, border, cropped, deformed'

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  comfy: boolean
  /** ComfyUI 是否由 pi-studio 托管(true 才允许从界面停止) */
  comfyManaged: boolean
  comfyCheckpoint: string
  comfyCheckpointAvailable: boolean | null
  comfyCheckpoints: string[]
  comfyWorkflowReady: boolean
  comfyPythonVersion?: string
  comfyTorchVersion?: string
  comfyDevices: string[]
  comfyLastError?: string
  model: string
  r2: boolean
}

function buildImageGenHealth(
  comfy: ComfyRuntimeHealth,
  cloudOk: boolean,
  model = '',
): ImageGenHealth {
  const compatibleCheckpoints = comfy.checkpoints.filter(isCompatibleCheckpoint)
  const configuredCompatible = !comfy.checkpoint || isCompatibleCheckpoint(comfy.checkpoint)
  return {
    ok: comfy.reachable || cloudOk,
    keyConfigured: cloudOk,
    comfy: comfy.reachable,
    comfyManaged: comfy.managed,
    comfyCheckpoint: comfy.checkpoint,
    comfyCheckpointAvailable: comfy.checkpointAvailable,
    comfyCheckpoints: comfy.checkpoints,
    comfyWorkflowReady:
      comfy.reachable &&
      configuredCompatible &&
      comfy.checkpointAvailable !== false &&
      compatibleCheckpoints.length > 0,
    comfyPythonVersion: comfy.pythonVersion,
    comfyTorchVersion: comfy.torchVersion,
    comfyDevices: comfy.deviceNames,
    comfyLastError: comfy.lastError,
    model,
    r2: cloudOk,
  }
}

export type ImageGenResult = { dataUrl: string; publicUrl: string | null; urls?: string[] } | { error: string }

export type ImageGenHistoryItem = {
  id: string
  batch_id: string
  prompt: string
  engine: string
  model: string | null
  provider: string | null
  url: string
  created_at: number
}

type ComfyHistoryImage = { filename: string; subfolder?: string; type?: string }
type ComfyHistoryEntry = {
  status?: { status_str?: string; messages?: unknown }
  outputs?: Record<string, { images?: ComfyHistoryImage[] }>
}

/**
 * 通用 checkpoint workflow（ComfyUI API 格式）。
 * refImageName 传了就是 img2img:LoadImage → VAEEncode 得到初始 latent,降低 denoise 保留原图结构。
 */
function buildWorkflow(
  prompt: string,
  seed: number,
  checkpoint: string,
  refImageName?: string,
  maskImageName?: string,
): Record<string, unknown> {
  const wf: Record<string, unknown> = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 28,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        // img2img:0.7 = 语义修改能生效、构图仍可辨;再低改不动,再高丢构图
        denoise: refImageName ? 0.7 : 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: refImageName ? [maskImageName ? '13' : '11', 0] : ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pi-studio' } },
  }
  if (refImageName) {
    wf[10] = { class_type: 'LoadImage', inputs: { image: refImageName } }
    if (maskImageName) {
      wf[12] = { class_type: 'LoadImageMask', inputs: { image: maskImageName, channel: 'alpha' } }
      wf[13] = {
        class_type: 'VAEEncodeForInpaint',
        inputs: { pixels: ['10', 0], vae: ['4', 2], mask: ['12', 0], grow_mask_by: 6 },
      }
    } else {
      wf[11] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } }
    }
  } else {
    wf[5] = { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } }
  }
  return wf
}

/** 把参考图(公网 URL)喂给 ComfyUI:下载 → POST /upload/image → 返回服务端文件名。 */
function parseImageDataUrl(value: string): { data: ArrayBuffer; contentType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value.trim())
  if (!match) return null
  try {
    const bytes = Buffer.from(match[2], 'base64')
    return {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: match[1].toLowerCase(),
    }
  } catch {
    return null
  }
}

async function comfyUploadRef(refUrl: string): Promise<string> {
  const dataUrl = parseImageDataUrl(refUrl)
  let blob: Blob
  let filename = `ref-${Date.now()}.png`
  if (dataUrl) {
    blob = new Blob([dataUrl.data], { type: dataUrl.contentType })
    filename = `ref-${Date.now()}.${dataUrl.contentType.split('/')[1] || 'png'}`
  } else {
    const img = await fetch(refUrl, { signal: AbortSignal.timeout(60_000) })
    if (!img.ok) throw new Error(`下载参考图失败(${img.status})`)
    blob = new Blob([await img.arrayBuffer()], { type: img.headers.get('content-type') || 'image/png' })
  }
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  const up = await fetch(`${COMFY_BASE}/upload/image`, { method: 'POST', body: form })
  if (!up.ok) throw new Error(`ComfyUI 上传参考图失败(${up.status})`)
  const j = (await up.json()) as { name: string; subfolder?: string }
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

async function comfyGenerate(prompt: string, refUrl?: string, maskUrl?: string): Promise<ImageGenResult> {
  if (maskUrl && !refUrl) return { error: '蒙版编辑需要先选择一张底图' }
  const runtime = await comfyRuntime.start()
  if (!runtime.ok) return { error: runtime.error }

  const availableCheckpoints = runtime.health.checkpoints
  if (runtime.health.checkpoint && !isCompatibleCheckpoint(runtime.health.checkpoint)) {
    return {
      error: `当前模型 ${runtime.health.checkpoint} 需要专用 ComfyUI workflow，请在设置中选择 SD checkpoint`,
    }
  }
  const compatibleCheckpoints = availableCheckpoints.filter(isCompatibleCheckpoint)
  const checkpoint =
    runtime.health.checkpoint ||
    (COMFY_CKPT_PREFERRED && compatibleCheckpoints.includes(COMFY_CKPT_PREFERRED)
      ? COMFY_CKPT_PREFERRED
      : compatibleCheckpoints[0])
  if (!checkpoint) return { error: 'ComfyUI 未发现兼容的 SD checkpoint，请先安装模型或在设置中指定' }

  const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
  const refName = refUrl ? await comfyUploadRef(refUrl) : undefined
  const maskName = maskUrl ? await comfyUploadRef(maskUrl) : undefined
  const submit = await fetch(`${COMFY_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(prompt, seed, checkpoint, refName, maskName) }),
  })
  if (!submit.ok) {
    return { error: `ComfyUI /prompt ${submit.status}: ${(await submit.text()).slice(0, 300)}` }
  }
  const { prompt_id } = (await submit.json()) as { prompt_id: string }

  const deadline = Date.now() + COMFY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const h = await fetch(`${COMFY_BASE}/history/${prompt_id}`)
    if (!h.ok) continue
    const entry = ((await h.json()) as Record<string, ComfyHistoryEntry>)[prompt_id]
    if (!entry) continue

    if (entry.status?.status_str === 'error') {
      return { error: `ComfyUI 执行出错: ${JSON.stringify(entry.status?.messages ?? '').slice(0, 300)}` }
    }
    const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])
    if (images.length) {
      const img = images[0]
      const q = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder ?? '',
        type: img.type ?? 'output',
      })
      const view = await fetch(`${COMFY_BASE}/view?${q}`)
      if (!view.ok) return { error: `ComfyUI /view ${view.status}` }
      const b64 = Buffer.from(await view.arrayBuffer()).toString('base64')
      return { dataUrl: `data:image/png;base64,${b64}`, publicUrl: null }
    }
  }
  return { error: `ComfyUI 生成超时(${Math.round(COMFY_TIMEOUT_MS / 1000)}s)` }
}

async function cloudFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const cloud = getCloudConnection()
  if (!cloud.available) throw new Error(cloud.error ?? '云端图像服务未配置')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return fetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

async function cloudUploadReference(dataUrl: string): Promise<string> {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) throw new Error('上传参考图格式无效')
  const resp = await cloudFetch('/imagegen/reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: Buffer.from(parsed.data).toString('base64'),
      content_type: parsed.contentType,
    }),
  }, 60_000)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`参考图上传失败(${resp.status}): ${text.slice(0, 200)}`)
  }
  const result = (await resp.json()) as { url?: string }
  if (!result.url) throw new Error('参考图上传成功但没有返回 URL')
  return result.url
}

async function probeCloud(path: string, timeoutMs: number): Promise<Response | null> {
  try {
    const response = await cloudFetch(path, {}, timeoutMs)
    return response.ok ? response : null
  } catch {
    return null
  }
}

/** 云端生成/改图:POST 一个 SSE 长连接,event: result 里拿 R2 URL,再下载转 dataUrl。 */
async function cloudGenerate(
  prompt: string,
  batchId: string,
  referenceUrls?: string[],
  maskUrl?: string,
  size?: ImageGenSize,
  options?: ImageGenOptions,
  downloadResult = true,
  model?: CloudImageModel,
): Promise<ImageGenResult> {
  const cloud = getCloudConnection()
  if (!cloud.available) {
    return { error: cloud.error ?? '云端图像服务未配置' }
  }

  const resp = await cloudFetch('/imagegen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      batchId,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(options ?? {}),
      ...(referenceUrls?.length ? { referenceUrls } : {}),
      ...(maskUrl ? { maskUrl } : {}),
    }),
  }, CLOUD_TIMEOUT_MS)
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    return { error: `云端中继 ${resp.status}: ${text.slice(0, 200)}` }
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const dataRaw = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !dataRaw) continue
      const data = JSON.parse(dataRaw)

      if (event === 'error') return { error: data.message || '云端生成失败' }
      if (event === 'result') {
        const urls = Array.isArray(data.urls) ? data.urls.filter((item: unknown): item is string => typeof item === 'string') : []
        const url = urls[0]
        if (!url) return { error: '云端任务完成但没有返回图片 URL' }
        const resolved = await resolveCloudImageResult(url, downloadResult)
        if ('downloadError' in resolved) {
          appendAppLog('warn', 'imagegen.cloud', 'Cloud result preview download failed; using public URL', {
            url,
            error: resolved.downloadError,
          })
        }
        return { ...resolved, urls }
      }
      // event: status — 阶段进度,目前不透传到 UI
    }
  }
  return { error: '云端连接在收到结果前断开了' }
}

/** 云端 gpt-image-2 支持的尺寸(值透传给 TrailAI/Hatchet 任务)。 */
export type ImageGenSize = '256x256' | '512x512' | '1024x1024' | '1024x1536' | '1536x1024' | '1024x1792' | '1792x1024' | 'auto'
export type CloudImageModel =
  | 'gpt-image-2'
  | 'gemini-3-pro-image-preview'
  | 'grok-imagine-image'
  | 'grok-imagine-image-quality'
export type GeminiImageAspectRatio = '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
export type GeminiImageResolution = '1K' | '2K' | '4K'
export type GrokImageAspectRatio =
  | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  | '2:1' | '1:2' | '19.5:9' | '9:19.5' | '20:9' | '9:20' | 'auto'
export type GrokImageResolution = '1K' | '2K'

export type ImageGenOptions = {
  aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
  imageSize?: GeminiImageResolution | GrokImageResolution
  n?: number
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
  background?: 'auto' | 'transparent' | 'opaque'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  outputCompression?: number
  moderation?: 'auto' | 'low'
  responseFormat?: 'b64_json' | 'url'
  providerStyle?: 'vivid' | 'natural'
  user?: string
}

/** 生一张图。渲染进程的图像页和例行任务的 imagegen 节点共用这一个入口。 */
export async function generateImage(payload: {
  prompt: string
  engine: 'openai' | 'comfy' | 'gemini' | 'grok'
  batchId?: string
  model?: CloudImageModel
  referenceUrls?: string[]
  maskDataUrl?: string
  size?: ImageGenSize
  aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
  imageSize?: GeminiImageResolution | GrokImageResolution
  n?: number
  quality?: ImageGenOptions['quality']
  background?: ImageGenOptions['background']
  outputFormat?: ImageGenOptions['outputFormat']
  outputCompression?: ImageGenOptions['outputCompression']
  moderation?: ImageGenOptions['moderation']
  responseFormat?: ImageGenOptions['responseFormat']
  providerStyle?: ImageGenOptions['providerStyle']
  user?: string
  /** Workflows already consume the durable public URL and do not need a blocking base64 copy. */
  downloadResult?: boolean
}): Promise<ImageGenResult> {
  try {
    const batchId = payload.batchId || crypto.randomUUID()
    if (payload.engine === 'comfy') {
      const r = await comfyGenerate(payload.prompt, payload.referenceUrls?.[0], payload.maskDataUrl)
      // 本地出图自动留档到云端历史(拿到 R2 URL 顺便回填 publicUrl);失败不阻断
      if ('dataUrl' in r && getCloudConnection().available) {
        try {
          const rec = await cloudFetch('/imagegen/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: payload.prompt,
              batchId,
              engine: payload.referenceUrls?.length ? 'comfy-edit' : 'comfy',
              model: 'sdxl-local',
              provider: 'sdxl-local',
              image_base64: r.dataUrl.split(',', 2)[1],
            }),
          }, 60_000)
          if (rec.ok) {
            const j = (await rec.json()) as { url?: string }
            if (j.url) return { ...r, publicUrl: j.url }
          }
        } catch {
          // 云端不可达时本地照常出图,只是不留档
        }
      }
      return r
    }
    const references = await Promise.all(
      (payload.referenceUrls ?? []).map((reference) =>
        reference.startsWith('data:') ? cloudUploadReference(reference) : reference,
      ),
    )
    if (payload.maskDataUrl && !references.length) {
      return { error: '蒙版编辑需要先选择一张底图' }
    }
    const maskUrl = payload.maskDataUrl ? await cloudUploadReference(payload.maskDataUrl) : undefined
    return cloudGenerate(
      payload.prompt,
      batchId,
      references,
      maskUrl,
      payload.size,
      {
        aspectRatio: payload.aspectRatio,
        imageSize: payload.imageSize,
        n: payload.n,
        quality: payload.quality,
        background: payload.background,
        outputFormat: payload.outputFormat,
        outputCompression: payload.outputCompression,
        moderation: payload.moderation,
        responseFormat: payload.responseFormat,
        providerStyle: payload.providerStyle,
        user: payload.user,
      },
      payload.downloadResult !== false,
      payload.model,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      error: msg.includes('fetch failed')
        ? payload.engine === 'comfy'
          ? 'ComfyUI 未运行,打开图像页的 ComfyUI 开关即可'
          : '连不上云端图像服务'
        : msg,
    }
  }
}

export function registerImageGenHandlers(): void {
  app.on('will-quit', () => {
    void comfyRuntime.stop()
  })

  ipcMain.handle('imageGen:health', async (): Promise<ImageGenHealth> => {
    const cloudConfig = getCloudConnection()
    const [comfy, cloudRes] = await Promise.all([
      comfyRuntime.health(),
      cloudConfig.available ? probeCloud('/imagegen/health', 3000) : Promise.resolve(null),
    ])
    const cloud = cloudRes ? ((await cloudRes.json()) as Record<string, unknown>) : null
    const cloudOk = !!cloud?.ok
    return buildImageGenHealth(
      comfy,
      cloudOk,
      typeof cloud?.model === 'string' ? cloud.model : '',
    )
  })

  ipcMain.handle(
    'imageGen:comfyStart',
    async (): Promise<{ ok: true; health: ImageGenHealth } | { error: string; health: ImageGenHealth }> => {
      const result = await comfyRuntime.start()
      const health = buildImageGenHealth(result.health, false)
      if (result.ok) {
        appendAppLog('info', 'imagegen.comfy', 'ComfyUI runtime ready', {
          alreadyRunning: result.alreadyRunning,
          checkpoint: result.health.checkpoint,
          checkpointAvailable: result.health.checkpointAvailable,
          devices: result.health.deviceNames,
        })
        return { ok: true, health }
      }
      appendAppLog('error', 'imagegen.comfy', 'ComfyUI runtime failed to start', {
        error: result.error,
        checkpoint: result.health.checkpoint,
        lastError: result.health.lastError,
      })
      return { error: result.error, health }
    },
  )

  ipcMain.handle('imageGen:comfyStop', async (): Promise<{ ok: boolean; external: boolean }> => {
    const result = await comfyRuntime.stop()
    const health = await comfyRuntime.health()
    return { ok: result.ok, external: health.reachable && !result.owned }
  })

  ipcMain.handle(
    'imageGen:generate',
    (
      _e,
      payload: {
        prompt: string
        engine: 'openai' | 'comfy' | 'gemini' | 'grok'
        batchId?: string
        model?: CloudImageModel
        referenceUrls?: string[]
        maskDataUrl?: string
        size?: ImageGenSize
        aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
        imageSize?: GeminiImageResolution | GrokImageResolution
        n?: number
        quality?: ImageGenOptions['quality']
        background?: ImageGenOptions['background']
        outputFormat?: ImageGenOptions['outputFormat']
        outputCompression?: ImageGenOptions['outputCompression']
        moderation?: ImageGenOptions['moderation']
        responseFormat?: ImageGenOptions['responseFormat']
        providerStyle?: ImageGenOptions['providerStyle']
        user?: string
      },
    ): Promise<ImageGenResult> => generateImage(payload),
  )

  // 改图底图选定后立刻传 R2:预览用公网 URL、生成时免每次重传 base64
  ipcMain.handle(
    'imageGen:uploadReference',
    async (_e, dataUrl: string): Promise<{ ok: true; url: string } | { error: string }> => {
      try {
        const url = await cloudUploadReference(dataUrl)
        return { ok: true, url }
      } catch (err) {
        appendAppLog('warn', 'imageGen.reference', 'Reference upload failed', {
          message: err instanceof Error ? err.message : String(err),
        })
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    'imageGen:history',
    async (_e, limit?: number): Promise<ImageGenHistoryItem[] | { error: string }> => {
      const n = Math.min(Math.max(limit ?? 60, 1), 500)
      const cloud = getCloudConnection()
      if (!cloud.available) {
        return { error: cloud.error ?? '云端图像服务未配置' }
      }
      try {
        const r = await cloudFetch(`/imagegen/history?limit=${n}&grouped=true`)
        if (!r.ok) return { error: `历史接口 ${r.status}` }
        return (await r.json()) as ImageGenHistoryItem[]
      } catch {
        return { error: '连不上云端历史服务' }
      }
    },
  )

  ipcMain.handle(
    'imageGen:historyDelete',
    async (_e, id: string): Promise<{ ok: boolean }> => {
      if (!getCloudConnection().available) return { ok: false }
      try {
        const r = await cloudFetch(`/imagegen/history/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        return { ok: r.ok }
      } catch {
        return { ok: false }
      }
    },
  )

  ipcMain.handle(
    'imageGen:historyDeleteBatch',
    async (_e, batchId: string): Promise<{ ok: boolean }> => {
      if (!getCloudConnection().available) return { ok: false }
      try {
        const r = await cloudFetch(`/imagegen/history-batches/${encodeURIComponent(batchId)}`, {
          method: 'DELETE',
        })
        return { ok: r.ok }
      } catch {
        return { ok: false }
      }
    },
  )
}

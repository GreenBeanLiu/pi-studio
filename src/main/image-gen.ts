import { app, ipcMain } from 'electron'
import { appendAppLog } from './app-log'
import { ComfyRuntime, parseLaunchArgs, type ComfyRuntimeHealth } from './comfy-runtime'
import { resolveCloudImageConfig } from './network-policy'
import { loadSettings } from './settings'

// 本地引擎:直连 ComfyUI(默认 8188,可由本应用托管启停)。
// 云端引擎:VPS 中继(trail-api)→ trigger.dev 跑 gpt-image-2 → R2,SSE 拿结果。
const COMFY_BASE = (process.env.PI_COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '')
const COMFY_DIR_DEFAULT = process.env.PI_COMFY_DIR || 'D:\\Works\\ComfyUI'
const COMFY_CKPT = process.env.PI_COMFY_CHECKPOINT || 'sd_xl_base_1.0.safetensors'
const COMFY_TIMEOUT_MS = 150_000
const CLOUD_TIMEOUT_MS = 320_000

// 构建期注入(见 electron.vite.config.ts);优先级:设置页覆盖 > process.env(dev) > 烧入默认。
declare const __CLOUD_IMAGE_RELAY__: string
declare const __CLOUD_IMAGE_KEY__: string

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
      checkpoint: COMFY_CKPT,
    }
  },
  {
    onLog: (message) => appendAppLog('warn', 'imagegen.comfy', message),
  },
)

/** 云端中继配置:每次读设置(便于用户改后即时生效,无需重启)。 */
const getCloud = (): ReturnType<typeof resolveCloudImageConfig> => {
  const s = loadSettings()
  return resolveCloudImageConfig(
    {
      PI_CLOUD_IMAGE_KEY: s.cloudImageKey?.trim() || process.env.PI_CLOUD_IMAGE_KEY || __CLOUD_IMAGE_KEY__,
      PI_CLOUD_IMAGE_RELAY:
        s.cloudImageRelay?.trim() || process.env.PI_CLOUD_IMAGE_RELAY || __CLOUD_IMAGE_RELAY__,
    },
    { allowHttpLoopback: !app.isPackaged },
  )
}

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
  return {
    ok: comfy.reachable || cloudOk,
    keyConfigured: cloudOk,
    comfy: comfy.reachable,
    comfyManaged: comfy.managed,
    comfyCheckpoint: comfy.checkpoint,
    comfyCheckpointAvailable: comfy.checkpointAvailable,
    comfyPythonVersion: comfy.pythonVersion,
    comfyTorchVersion: comfy.torchVersion,
    comfyDevices: comfy.deviceNames,
    comfyLastError: comfy.lastError,
    model,
    r2: cloudOk,
  }
}

export type ImageGenResult = { dataUrl: string; publicUrl: string | null } | { error: string }

export type ImageGenHistoryItem = {
  id: string
  prompt: string
  engine: string
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
 * SDXL workflow(ComfyUI API 格式)。
 * refImageName 传了就是 img2img:LoadImage → VAEEncode 得到初始 latent,降低 denoise 保留原图结构。
 */
function buildWorkflow(prompt: string, seed: number, refImageName?: string): Record<string, unknown> {
  const wf: Record<string, unknown> = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: COMFY_CKPT } },
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
        latent_image: refImageName ? ['11', 0] : ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pi-studio' } },
  }
  if (refImageName) {
    wf[10] = { class_type: 'LoadImage', inputs: { image: refImageName } }
    wf[11] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } }
  } else {
    wf[5] = { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } }
  }
  return wf
}

/** 把参考图(公网 URL)喂给 ComfyUI:下载 → POST /upload/image → 返回服务端文件名。 */
async function comfyUploadRef(refUrl: string): Promise<string> {
  const img = await fetch(refUrl, { signal: AbortSignal.timeout(60_000) })
  if (!img.ok) throw new Error(`下载参考图失败(${img.status})`)
  const blob = new Blob([await img.arrayBuffer()], { type: 'image/png' })
  const form = new FormData()
  form.append('image', blob, `ref-${Date.now()}.png`)
  form.append('overwrite', 'true')
  const up = await fetch(`${COMFY_BASE}/upload/image`, { method: 'POST', body: form })
  if (!up.ok) throw new Error(`ComfyUI 上传参考图失败(${up.status})`)
  const j = (await up.json()) as { name: string; subfolder?: string }
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

async function comfyGenerate(prompt: string, refUrl?: string): Promise<ImageGenResult> {
  const runtime = await comfyRuntime.start()
  if (!runtime.ok) return { error: runtime.error }

  const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
  const refName = refUrl ? await comfyUploadRef(refUrl) : undefined
  const submit = await fetch(`${COMFY_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(prompt, seed, refName) }),
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
  const cloud = getCloud()
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

async function probeCloud(path: string, timeoutMs: number): Promise<Response | null> {
  try {
    const response = await cloudFetch(path, {}, timeoutMs)
    return response.ok ? response : null
  } catch {
    return null
  }
}

/** 云端生成/改图:POST 一个 SSE 长连接,event: result 里拿 R2 URL,再下载转 dataUrl。 */
async function cloudGenerate(prompt: string, referenceUrls?: string[]): Promise<ImageGenResult> {
  const cloud = getCloud()
  if (!cloud.available) {
    return { error: cloud.error ?? '云端图像服务未配置' }
  }

  const resp = await cloudFetch('/imagegen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, ...(referenceUrls?.length ? { referenceUrls } : {}) }),
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
        const url = data.urls?.[0]
        if (!url) return { error: '云端任务完成但没有返回图片 URL' }
        const img = await fetch(url, { signal: AbortSignal.timeout(60_000) })
        if (!img.ok) return { error: `下载结果图失败(${img.status})` }
        const b64 = Buffer.from(await img.arrayBuffer()).toString('base64')
        return { dataUrl: `data:image/png;base64,${b64}`, publicUrl: url }
      }
      // event: status — 阶段进度,目前不透传到 UI
    }
  }
  return { error: '云端连接在收到结果前断开了' }
}

/** 生一张图。渲染进程的图像页和例行任务的 imagegen 节点共用这一个入口。 */
export async function generateImage(payload: {
  prompt: string
  engine: 'openai' | 'comfy'
  referenceUrls?: string[]
}): Promise<ImageGenResult> {
  try {
    if (payload.engine === 'comfy') {
      const r = await comfyGenerate(payload.prompt, payload.referenceUrls?.[0])
      // 本地出图自动留档到云端历史(拿到 R2 URL 顺便回填 publicUrl);失败不阻断
      if ('dataUrl' in r && getCloud().available) {
        try {
          const rec = await cloudFetch('/imagegen/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: payload.prompt,
              engine: payload.referenceUrls?.length ? 'comfy-edit' : 'comfy',
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
    return await cloudGenerate(payload.prompt, payload.referenceUrls)
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
    const cloudConfig = getCloud()
    const [comfy, cloudRes] = await Promise.all([
      comfyRuntime.health(),
      cloudConfig.available ? probeCloud('/imagegen/health', 3000) : Promise.resolve(null),
    ])
    const cloud = cloudRes ? ((await cloudRes.json()) as Record<string, unknown>) : null
    const cloudOk = !!cloud?.ok
    return buildImageGenHealth(comfy, cloudOk, typeof cloud?.model === 'string' ? cloud.model : '')
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
      payload: { prompt: string; engine: 'openai' | 'comfy'; referenceUrls?: string[] },
    ): Promise<ImageGenResult> => generateImage(payload),
  )

  ipcMain.handle(
    'imageGen:history',
    async (_e, limit?: number): Promise<ImageGenHistoryItem[] | { error: string }> => {
      const n = Math.min(Math.max(limit ?? 60, 1), 500)
      const cloud = getCloud()
      if (!cloud.available) {
        return { error: cloud.error ?? '云端图像服务未配置' }
      }
      try {
        const r = await cloudFetch(`/imagegen/history?limit=${n}`)
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
      if (!getCloud().available) return { ok: false }
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
}

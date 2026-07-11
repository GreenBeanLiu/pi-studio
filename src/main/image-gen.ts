import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// 本地引擎:直连 ComfyUI(默认 8188,可由本应用托管启停)。
// 云端引擎:VPS 中继(trail-api)→ trigger.dev 跑 gpt-image-2 → R2,SSE 拿结果。
const COMFY_BASE = (process.env.PI_COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '')
const COMFY_DIR = process.env.PI_COMFY_DIR || 'D:\\Works\\ComfyUI'
const COMFY_CKPT = process.env.PI_COMFY_CHECKPOINT || 'sd_xl_base_1.0.safetensors'
const COMFY_TIMEOUT_MS = 150_000
const CLOUD_RELAY = (process.env.PI_CLOUD_IMAGE_RELAY || 'http://trail-api.glanger.xyz:8000').replace(/\/$/, '')
// 防扫描白嫖的共享 key(烧在客户端,防的是爬虫不是逆向)
const CLOUD_KEY = process.env.PI_CLOUD_IMAGE_KEY || '8f3b404477548a7a59223fceec483bae'
const CLOUD_TIMEOUT_MS = 320_000

// pi-studio 托管的 ComfyUI 子进程(用户在图像页开关);应用退出时一并结束。
// 若 8188 上已有外部启动的 ComfyUI,直接用,不托管也不负责停止。
let comfyProc: ChildProcess | null = null

const NEGATIVE =
  'text, letters, words, watermark, signature, blurry, lowres, jpeg artifacts, frame, border, cropped, deformed'

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  comfy: boolean
  /** ComfyUI 是否由 pi-studio 托管(true 才允许从界面停止) */
  comfyManaged: boolean
  model: string
  r2: boolean
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
    const entry = ((await h.json()) as Record<string, any>)[prompt_id]
    if (!entry) continue

    if (entry.status?.status_str === 'error') {
      return { error: `ComfyUI 执行出错: ${JSON.stringify(entry.status?.messages ?? '').slice(0, 300)}` }
    }
    const images = Object.values(entry.outputs ?? {}).flatMap(
      (o: any) => (o.images ?? []) as { filename: string; subfolder?: string; type?: string }[],
    )
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

async function probe(url: string, ms = 1500): Promise<Response | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return r.ok ? r : null
  } catch {
    return null
  }
}

/** 云端生成/改图:POST 一个 SSE 长连接,event: result 里拿 R2 URL,再下载转 dataUrl。 */
async function cloudGenerate(prompt: string, referenceUrls?: string[]): Promise<ImageGenResult> {
  const resp = await fetch(`${CLOUD_RELAY}/imagegen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': CLOUD_KEY },
    body: JSON.stringify({ prompt, ...(referenceUrls?.length ? { referenceUrls } : {}) }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  })
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

const comfyUp = async (): Promise<boolean> => !!(await probe(`${COMFY_BASE}/system_stats`))

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
      if ('dataUrl' in r) {
        try {
          const rec = await fetch(`${CLOUD_RELAY}/imagegen/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': CLOUD_KEY },
            body: JSON.stringify({
              prompt: payload.prompt,
              engine: payload.referenceUrls?.length ? 'comfy-edit' : 'comfy',
              provider: 'sdxl-local',
              image_base64: r.dataUrl.split(',', 2)[1],
            }),
            signal: AbortSignal.timeout(60_000),
          })
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
          : '连不上云端图像服务(trail-api.glanger.xyz:8000)'
        : msg,
    }
  }
}

export function registerImageGenHandlers(): void {
  app.on('will-quit', () => {
    comfyProc?.kill()
    comfyProc = null
  })

  ipcMain.handle('imageGen:health', async (): Promise<ImageGenHealth> => {
    const [comfyRes, cloudRes] = await Promise.all([
      probe(`${COMFY_BASE}/system_stats`),
      probe(`${CLOUD_RELAY}/imagegen/health`, 3000),
    ])
    const cloud = cloudRes ? ((await cloudRes.json()) as Record<string, unknown>) : null
    const comfy = !!comfyRes
    const cloudOk = !!cloud?.ok
    return {
      ok: comfy || cloudOk,
      comfy,
      comfyManaged: comfyProc != null && comfyProc.exitCode === null,
      keyConfigured: cloudOk,
      model: typeof cloud?.model === 'string' ? cloud.model : '',
      r2: cloudOk,
    }
  })

  ipcMain.handle('imageGen:comfyStart', async (): Promise<{ ok: true } | { error: string }> => {
    if (await comfyUp()) return { ok: true }
    const py = join(COMFY_DIR, '.venv', 'Scripts', 'python.exe')
    if (!existsSync(py)) return { error: `找不到 ComfyUI 环境: ${py}` }

    if (!comfyProc || comfyProc.exitCode !== null) {
      const port = new URL(COMFY_BASE).port || '8188'
      comfyProc = spawn(py, ['main.py', '--port', port], {
        cwd: COMFY_DIR,
        stdio: 'ignore',
        windowsHide: true,
      })
      comfyProc.on('exit', () => {
        comfyProc = null
      })
    }

    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      if (await comfyUp()) return { ok: true }
      if (!comfyProc) return { error: 'ComfyUI 进程启动后立即退出,请在 ComfyUI 目录手动启动排查' }
    }
    comfyProc?.kill()
    comfyProc = null
    return { error: 'ComfyUI 启动超时(90s)' }
  })

  ipcMain.handle('imageGen:comfyStop', async (): Promise<{ ok: boolean; external: boolean }> => {
    if (comfyProc) {
      comfyProc.kill()
      comfyProc = null
      return { ok: true, external: false }
    }
    // 不是本应用启动的进程,不越权去杀
    return { ok: false, external: await comfyUp() }
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
      try {
        const r = await fetch(`${CLOUD_RELAY}/imagegen/history?limit=${n}`, {
          headers: { 'X-API-Key': CLOUD_KEY },
          signal: AbortSignal.timeout(8000),
        })
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
      try {
        const r = await fetch(`${CLOUD_RELAY}/imagegen/history/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'X-API-Key': CLOUD_KEY },
          signal: AbortSignal.timeout(8000),
        })
        return { ok: r.ok }
      } catch {
        return { ok: false }
      }
    },
  )
}

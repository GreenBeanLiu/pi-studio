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

/** SDXL 文生图 workflow(ComfyUI API 格式),与 icon-studio 的保持一致。 */
function buildWorkflow(prompt: string, seed: number): Record<string, unknown> {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: COMFY_CKPT } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
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
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'pi-studio' } },
  }
}

async function comfyGenerate(prompt: string): Promise<ImageGenResult> {
  const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
  const submit = await fetch(`${COMFY_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: buildWorkflow(prompt, seed) }),
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

/** 云端生成:POST 一个 SSE 长连接,event: result 里拿 R2 URL,再下载转 dataUrl。 */
async function cloudGenerate(prompt: string): Promise<ImageGenResult> {
  const resp = await fetch(`${CLOUD_RELAY}/imagegen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': CLOUD_KEY },
    body: JSON.stringify({ prompt }),
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
    async (_e, payload: { prompt: string; engine: 'openai' | 'comfy' }): Promise<ImageGenResult> => {
      try {
        if (payload.engine === 'comfy') return await comfyGenerate(payload.prompt)
        return await cloudGenerate(payload.prompt)
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
    },
  )
}

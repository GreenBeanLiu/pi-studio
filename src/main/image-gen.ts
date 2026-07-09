import { app, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// 本地图像生成:直连 ComfyUI(唯一硬依赖,默认 8188)。
// 云端 gpt-image-2 走 icon-studio 后端(5301),它没开就置灰——可选增强,不是前提。
const COMFY_BASE = (process.env.PI_COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '')
const COMFY_DIR = process.env.PI_COMFY_DIR || 'D:\\Works\\ComfyUI'
const COMFY_CKPT = process.env.PI_COMFY_CHECKPOINT || 'sd_xl_base_1.0.safetensors'
const COMFY_TIMEOUT_MS = 150_000
const ICON_STUDIO = (process.env.PI_IMAGE_SERVICE || 'http://127.0.0.1:5301').replace(/\/$/, '')

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

const comfyUp = async (): Promise<boolean> => !!(await probe(`${COMFY_BASE}/system_stats`))

export function registerImageGenHandlers(): void {
  app.on('will-quit', () => {
    comfyProc?.kill()
    comfyProc = null
  })

  ipcMain.handle('imageGen:health', async (): Promise<ImageGenHealth> => {
    const [comfyRes, iconRes] = await Promise.all([
      probe(`${COMFY_BASE}/system_stats`),
      probe(`${ICON_STUDIO}/api/health`),
    ])
    const icon = iconRes ? ((await iconRes.json()) as Record<string, unknown>) : null
    const comfy = !!comfyRes
    const keyConfigured = !!icon?.keyConfigured
    return {
      ok: comfy || keyConfigured,
      comfy,
      comfyManaged: comfyProc != null && comfyProc.exitCode === null,
      keyConfigured,
      model: typeof icon?.model === 'string' ? icon.model : '',
      r2: !!icon?.r2,
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

        // 云端引擎:经由 icon-studio 后端(带 R2 上传)
        const r = await fetch(`${ICON_STUDIO}/api/gen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(COMFY_TIMEOUT_MS),
        })
        const j = await r.json()
        if (!r.ok) return { error: j?.error || `生成服务 ${r.status}` }
        return { dataUrl: j.dataUrl, publicUrl: j.publicUrl ?? null }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          error: msg.includes('fetch failed')
            ? payload.engine === 'comfy'
              ? 'ComfyUI 未运行:cd D:\\Works\\ComfyUI && .venv\\Scripts\\python.exe main.py --port 8188'
              : '云端引擎需要 icon-studio 后端在运行(pnpm start)'
            : msg,
        }
      }
    },
  )
}

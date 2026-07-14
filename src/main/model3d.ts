import { ipcMain, app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getCloud } from './image-gen'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 3D 生成:Tripo3D 调用已抽离到服务端(trigger.dev `gen-model-3d` 任务),客户端
 * 只经 VPS 中继(trail-api /model3d SSE)提交→拿 R2 上的 glb URL,再下载到本地
 * (中继/R2 与图像生成共用同一 relay + key,见 image-gen.ts 的 getCloud)。
 * 渲染进程用 three.js 预览。服务端链路:relay → trigger.dev → Tripo → R2。
 */

const CLOUD_TIMEOUT_MS = 600_000

function modelsDir(): string {
  const d = join(app.getPath('userData'), 'models3d')
  mkdirSync(d, { recursive: true })
  return d
}

function indexPath(): string {
  return join(modelsDir(), 'index.json')
}

export type Model3DHealth = { configured: boolean }

export type Model3DOptions = {
  modelVersion?: string
  faceLimit?: number
  texture?: boolean
  pbr?: boolean
  style?: string
}

export type Model3DHistoryItem = {
  id: string
  prompt: string
  mode: 'text' | 'image'
  modelUrl: string
  thumbnailUrl: string | null
  createdAt: number
  options?: Model3DOptions
}

export type Model3DResult = Model3DHistoryItem | { error: string }

function loadHistory(): Model3DHistoryItem[] {
  try {
    if (!existsSync(indexPath())) return []
    const items = JSON.parse(readFileSync(indexPath(), 'utf-8')) as Model3DHistoryItem[]
    // 只保留本地文件仍存在的记录
    return items.filter((it) => existsSync(join(modelsDir(), `${it.id}.glb`)))
  } catch {
    return []
  }
}

function saveHistory(items: Model3DHistoryItem[]): void {
  writeFileSync(indexPath(), JSON.stringify(items.slice(0, 200), null, 2), 'utf-8')
}

/** 本地文件路径转成渲染进程可加载的 file:// URL。 */
function localFileUrl(p: string): string {
  return `file:///${p.replace(/\\/g, '/')}`
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

type GeneratePayload = {
  mode: 'text' | 'image'
  prompt: string
  imageDataUrl?: string
  options?: Model3DOptions
}

async function cloudFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const cloud = getCloud()
  if (!cloud.available) throw new Error(cloud.error ?? '云端 3D 服务未配置(设置 → 生图 → 云端中继)')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return fetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

/** 图生 3D:把参考图上传到 R2(复用 imagegen 的 /reference),拿到公网 URL 给中继。 */
async function uploadReference(dataUrl: string): Promise<string> {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) throw new Error('参考图 data URL 无法解析')
  const resp = await cloudFetch(
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: m[2], content_type: m[1] }),
    },
    60_000,
  )
  if (!resp.ok) throw new Error(`参考图上传失败(${resp.status}): ${(await resp.text()).slice(0, 200)}`)
  const r = (await resp.json()) as { url?: string }
  if (!r.url) throw new Error('参考图上传成功但没有返回 URL')
  return r.url
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function generate(payload: GeneratePayload): Promise<Model3DResult> {
  if (payload.mode === 'text' && !payload.prompt.trim()) return { error: '请输入文字提示词' }
  if (payload.mode === 'image' && !payload.imageDataUrl) return { error: '请提供参考图片' }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    let imageUrl: string | undefined
    if (payload.mode === 'image' && payload.imageDataUrl) {
      broadcast('model3d:progress', { id, status: 'uploading', progress: 0 })
      imageUrl = await uploadReference(payload.imageDataUrl)
    }

    broadcast('model3d:progress', { id, status: 'submitting', progress: 0 })
    const resp = await cloudFetch(
      '/model3d',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(imageUrl ? { imageUrl } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          options: payload.options ?? {},
        }),
      },
      CLOUD_TIMEOUT_MS,
    )
    if (!resp.ok || !resp.body)
      throw new Error(`云端中继 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)

    // 读 SSE:status(阶段/进度) → result{modelUrl,thumbnailUrl} / error
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let modelUrl: string | undefined
    let thumbUrl: string | null = null
    outer: while (true) {
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
        if (event === 'error') throw new Error(data.message || '云端 3D 生成失败')
        if (event === 'status') {
          const stage = String(data.stage ?? '')
          const pm = /running:(\d+)/.exec(stage)
          broadcast('model3d:progress', {
            id,
            status: pm ? 'running' : stage || 'running',
            progress: pm ? Number(pm[1]) : 0,
          })
        }
        if (event === 'result') {
          modelUrl = data.modelUrl
          thumbUrl = data.thumbnailUrl ?? null
          break outer
        }
      }
    }
    if (!modelUrl) throw new Error('云端任务完成但没有返回模型 URL')

    broadcast('model3d:progress', { id, status: 'downloading', progress: 100 })
    const glbPath = join(modelsDir(), `${id}.glb`)
    await download(modelUrl, glbPath)
    let thumbPath: string | null = null
    if (thumbUrl) {
      try {
        const p = join(modelsDir(), `${id}.png`)
        await download(thumbUrl, p)
        thumbPath = p
      } catch {
        thumbPath = null
      }
    }

    const item: Model3DHistoryItem = {
      id,
      prompt: payload.mode === 'image' ? payload.prompt || '(图生 3D)' : payload.prompt,
      mode: payload.mode,
      modelUrl: localFileUrl(glbPath),
      thumbnailUrl: thumbPath ? localFileUrl(thumbPath) : null,
      createdAt: Date.now(),
      ...(payload.options ? { options: payload.options } : {}),
    }
    saveHistory([item, ...loadHistory()])
    broadcast('model3d:progress', { id, status: 'done', progress: 100 })
    return item
  } catch (err) {
    appendAppLog('error', 'model3d.generate', '3D 生成失败', normalizeError(err))
    broadcast('model3d:progress', { id, status: 'error', progress: 0 })
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerModel3d(): void {
  ipcMain.handle('model3d:health', (): Model3DHealth => ({ configured: getCloud().available }))
  ipcMain.handle('model3d:generate', (_e, payload: GeneratePayload) => generate(payload))
  ipcMain.handle('model3d:history', (): Model3DHistoryItem[] => loadHistory())
  ipcMain.handle('model3d:historyDelete', (_e, id: string) => {
    saveHistory(loadHistory().filter((it) => it.id !== id))
    for (const ext of ['glb', 'png']) {
      const p = join(modelsDir(), `${id}.${ext}`)
      try {
        if (existsSync(p)) rmSync(p)
      } catch {
        /* ignore */
      }
    }
    return { ok: true }
  })
}

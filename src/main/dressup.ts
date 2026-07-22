import { ipcMain, app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getCloudConnection } from './cloud-connection'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 换装视频:两张「同一主角不同造型」的照片作首帧/尾帧,经 VPS 中继
 * (trail-api /dressup SSE)→ 服务端 Hatchet `gen-dressup-video` 任务 → 可灵 Kling
 * 图生视频 → R2 上的 mp4,再下载到本地。中继/R2/密钥与图像生成共用(见 image-gen.ts)。
 * 服务端链路:relay → Hatchet → Kling → R2。
 */

const CLOUD_TIMEOUT_MS = 600_000

export function dressupDir(): string {
  const d = join(app.getPath('userData'), 'dressup')
  mkdirSync(d, { recursive: true })
  return d
}

function indexPath(): string {
  return join(dressupDir(), 'index.json')
}

export type DressupHealth = { configured: boolean; klingReady?: boolean }

export type DressupHistoryItem = {
  id: string
  prompt: string
  mode: 'std' | 'pro'
  duration: '5' | '10'
  /** 本地 mp4 的 file:// 地址,渲染进程用 <video> 播放 */
  videoUrl: string
  /** R2 上的 mp4 公网地址,用于分享(用户自有 OSS) */
  cloudVideoUrl?: string
  createdAt: number
}

export type DressupResult = DressupHistoryItem | { error: string }

export function loadHistory(): DressupHistoryItem[] {
  try {
    if (!existsSync(indexPath())) return []
    const items = JSON.parse(readFileSync(indexPath(), 'utf-8')) as DressupHistoryItem[]
    return items.filter((it) => existsSync(join(dressupDir(), `${it.id}.mp4`)))
  } catch {
    return []
  }
}

export function saveHistory(items: DressupHistoryItem[]): void {
  writeFileSync(indexPath(), JSON.stringify(items.slice(0, 200), null, 2), 'utf-8')
}

function localFileUrl(p: string): string {
  return `file:///${p.replace(/\\/g, '/')}`
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

type GeneratePayload = {
  /** 首帧:主角原造型(data URL) */
  firstFrameDataUrl: string
  /** 尾帧:主角目标造型(data URL) */
  tailFrameDataUrl: string
  prompt?: string
  mode?: 'std' | 'pro'
  duration?: '5' | '10'
  model?: string
}

async function cloudFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const cloud = getCloudConnection()
  if (!cloud.available) throw new Error(cloud.error ?? '云端服务未配置(设置 → 生图 → 云端中继)')
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', cloud.key)
  return fetch(`${cloud.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

/** 把一帧照片上传到 R2(复用 imagegen 的 /reference),拿公网 URL 给中继。 */
async function uploadReference(dataUrl: string): Promise<string> {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) throw new Error('图片 data URL 无法解析')
  const resp = await cloudFetch(
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: m[2], content_type: m[1] }),
    },
    60_000,
  )
  if (!resp.ok) throw new Error(`图片上传失败(${resp.status}): ${(await resp.text()).slice(0, 200)}`)
  const r = (await resp.json()) as { url?: string }
  if (!r.url) throw new Error('图片上传成功但没有返回 URL')
  return r.url
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function generate(payload: GeneratePayload): Promise<DressupResult> {
  if (!payload.firstFrameDataUrl) return { error: '请提供第一套造型的照片' }
  if (!payload.tailFrameDataUrl) return { error: '请提供第二套造型的照片' }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const mode = payload.mode ?? 'std'
  const duration = payload.duration ?? '5'
  const progress = (status: string, pct: number): void =>
    broadcast('dressup:progress', { id, status, progress: pct, prompt: payload.prompt ?? '' })

  try {
    progress('uploading', 0)
    const [firstFrameUrl, tailFrameUrl] = await Promise.all([
      uploadReference(payload.firstFrameDataUrl),
      uploadReference(payload.tailFrameDataUrl),
    ])

    progress('submitting', 0)
    const resp = await cloudFetch(
      '/dressup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstFrameUrl,
          tailFrameUrl,
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          mode,
          duration,
          ...(payload.model ? { model: payload.model } : {}),
        }),
      },
      CLOUD_TIMEOUT_MS,
    )
    if (!resp.ok || !resp.body)
      throw new Error(`云端中继 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)

    // 读 SSE:status(阶段) → result{videoUrl,...} / error
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let videoUrl: string | undefined
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
        if (event === 'error') throw new Error(data.message || '云端换装视频生成失败')
        if (event === 'status') progress(String(data.stage ?? 'running'), 0)
        if (event === 'result') {
          videoUrl = data.videoUrl
          break outer
        }
      }
    }
    if (!videoUrl) throw new Error('云端任务完成但没有返回视频 URL')

    progress('downloading', 100)
    const mp4Path = join(dressupDir(), `${id}.mp4`)
    await download(videoUrl, mp4Path)

    const item: DressupHistoryItem = {
      id,
      prompt: payload.prompt || '(换装视频)',
      mode,
      duration,
      videoUrl: localFileUrl(mp4Path),
      cloudVideoUrl: videoUrl,
      createdAt: Date.now(),
    }
    saveHistory([item, ...loadHistory()])
    progress('done', 100)
    return item
  } catch (err) {
    appendAppLog('error', 'dressup.generate', '换装视频生成失败', normalizeError(err))
    progress('error', 0)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerDressup(): void {
  ipcMain.handle('dressup:health', async (): Promise<DressupHealth> => {
    const configured = getCloudConnection().available
    let klingReady: boolean | undefined
    if (configured) {
      try {
        const resp = await cloudFetch('/dressup/health', {}, 3_000)
        if (resp.ok) klingReady = !!((await resp.json()) as { ok?: boolean }).ok
      } catch {
        // 探测失败按未知处理,不拦生成
      }
    }
    return { configured, ...(klingReady === undefined ? {} : { klingReady }) }
  })
  ipcMain.handle('dressup:generate', (_e, payload: GeneratePayload) => generate(payload))
  ipcMain.handle('dressup:history', (): DressupHistoryItem[] => loadHistory())
  ipcMain.handle('dressup:historyDelete', (_e, id: string) => {
    saveHistory(loadHistory().filter((it) => it.id !== id))
    const p = join(dressupDir(), `${id}.mp4`)
    try {
      if (existsSync(p)) rmSync(p)
    } catch {
      /* ignore */
    }
    return { ok: true }
  })
}

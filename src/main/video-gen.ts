import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAppLog, normalizeError } from './app-log'
import { getCloudConnection } from './cloud-connection'
import {
  cloudMediaFetch as cloudFetch,
  downloadCloudMedia as download,
  localMediaFileUrl as localFileUrl,
  readCloudSseResult as readSseResult,
  uploadCloudImageReference as uploadReference,
} from './cloud-media'
import {
  buildGrokVideoRequest,
  type GrokVideoGeneratePayload,
} from './video-gen-request'

const GENERATION_TIMEOUT_MS = 17 * 60_000

export type VideoGenHealth = {
  configured: boolean
  grokReady?: boolean
  model?: string
}

export type VideoGenHistoryItem = {
  id: string
  provider: 'grok'
  prompt: string
  duration: 5 | 10 | 15
  aspectRatio: string
  resolution: string
  videoUrl: string
  cloudVideoUrl?: string
  createdAt: number
}

type VideoGenResult = VideoGenHistoryItem | { error: string }

function videoGenDir(): string {
  const dir = join(app.getPath('userData'), 'video-gen')
  mkdirSync(dir, { recursive: true })
  return dir
}

function historyPath(): string {
  return join(videoGenDir(), 'index.json')
}

function loadHistory(): VideoGenHistoryItem[] {
  try {
    if (!existsSync(historyPath())) return []
    const items = JSON.parse(readFileSync(historyPath(), 'utf8')) as VideoGenHistoryItem[]
    return items.filter((item) => existsSync(join(videoGenDir(), `${item.id}.mp4`)))
  } catch {
    return []
  }
}

function saveHistory(items: VideoGenHistoryItem[]): void {
  writeFileSync(historyPath(), JSON.stringify(items.slice(0, 200), null, 2), 'utf8')
}

function broadcast(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('videoGen:progress', payload)
  }
}

async function generate(payload: GrokVideoGeneratePayload): Promise<VideoGenResult> {
  if (!payload.prompt?.trim()) return { error: '请输入视频描述' }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const progress = (status: string): void => broadcast({ id, provider: 'grok', status, prompt: payload.prompt })
  try {
    progress(payload.imageDataUrl ? 'uploading' : 'submitting')
    const imageUrl = payload.imageDataUrl ? await uploadReference(payload.imageDataUrl) : undefined
    const request = buildGrokVideoRequest({ ...payload, imageUrl })
    progress('submitting')
    const response = await cloudFetch(
      '/videogen',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      GENERATION_TIMEOUT_MS,
    )
    const data = await readSseResult(response, progress)
    const cloudVideoUrl = data.videoUrl as string | undefined
    if (!cloudVideoUrl) throw new Error('云端任务完成但没有返回视频 URL')
    progress('downloading')
    const outputPath = join(videoGenDir(), `${id}.mp4`)
    await download(cloudVideoUrl, outputPath)
    const item: VideoGenHistoryItem = {
      id,
      provider: 'grok',
      prompt: request.prompt,
      duration: request.duration,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      videoUrl: localFileUrl(outputPath),
      cloudVideoUrl,
      createdAt: Date.now(),
    }
    saveHistory([item, ...loadHistory()])
    progress('done')
    return item
  } catch (error) {
    appendAppLog('error', 'videoGen.generate', 'Grok 视频生成失败', normalizeError(error))
    progress('error')
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerVideoGen(): void {
  ipcMain.handle('videoGen:health', async (): Promise<VideoGenHealth> => {
    const configured = getCloudConnection().available
    if (!configured) return { configured: false }
    try {
      const response = await cloudFetch('/videogen/health', {}, 3_000)
      if (!response.ok) return { configured: true }
      const result = (await response.json()) as { ok?: boolean; model?: string }
      return { configured: true, grokReady: !!result.ok, ...(result.model ? { model: result.model } : {}) }
    } catch {
      return { configured: true }
    }
  })
  ipcMain.handle('videoGen:generate', (_event, payload: GrokVideoGeneratePayload) => generate(payload))
  ipcMain.handle('videoGen:history', () => loadHistory())
  ipcMain.handle('videoGen:historyDelete', (_event, id: string) => {
    saveHistory(loadHistory().filter((item) => item.id !== id))
    const path = join(videoGenDir(), `${id}.mp4`)
    if (existsSync(path)) rmSync(path)
    return { ok: true }
  })
}

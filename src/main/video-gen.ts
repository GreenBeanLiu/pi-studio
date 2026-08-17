import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAppLog, normalizeError } from './app-log'
import { getCloudConnection } from './cloud-connection'
import { remoteControl, type RemoteVideoJob } from './remote-control'
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

/**
 * 手机端的可灵文生视频。
 *
 * 和 Grok 那条(videoGen:generate)不同的是**不下载到本地**:手机要的是 R2 的公网
 * 链接,桌面白下一份几十 MB 的 mp4 没有意义。也不挂长请求 —— 一次生成 5~20 分钟,
 * 手机切后台或换网就断了;这里发起即返回 job,状态变化推 video:job 事件。
 */
const KLING_TIMEOUT_MS = 20 * 60_000
const KLING_JOBS_KEPT = 20
const klingJobs: RemoteVideoJob[] = []

function publishKlingJob(job: RemoteVideoJob): void {
  const index = klingJobs.findIndex((item) => item.id === job.id)
  if (index >= 0) klingJobs[index] = job
  else {
    klingJobs.unshift(job)
    klingJobs.splice(KLING_JOBS_KEPT)
  }
  remoteControl.forwardHostEvent('video:job', job)
}

async function runKlingJob(job: RemoteVideoJob): Promise<void> {
  try {
    const response = await cloudFetch(
      '/videogen/kling',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: job.prompt,
          duration: job.duration,
          aspectRatio: job.aspectRatio,
          mode: job.mode,
        }),
      },
      KLING_TIMEOUT_MS,
    )
    const data = await readSseResult(response, (stage) => {
      publishKlingJob({ ...job, stage })
    })
    const videoUrl = data.videoUrl as string | undefined
    if (!videoUrl) throw new Error('云端任务完成但没有返回视频 URL')
    publishKlingJob({
      ...job,
      status: 'done',
      stage: 'done',
      videoUrl,
      durationSec: typeof data.durationSec === 'number' ? data.durationSec : null,
    })
  } catch (error) {
    appendAppLog('error', 'videoGen.kling', '可灵文生视频失败', normalizeError(error))
    publishKlingJob({
      ...job,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
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
  remoteControl.setVideoHost({
    health: async () => {
      try {
        const response = await cloudFetch('/videogen/kling/health', {}, 5_000)
        if (!response.ok) return { ok: false, model: '' }
        const result = (await response.json()) as { ok?: boolean; model?: string }
        return { ok: !!result.ok, model: result.model ?? '' }
      } catch {
        return { ok: false, model: '' }
      }
    },
    list: () => klingJobs.map((job) => ({ ...job })),
    start: (payload) => {
      const job: RemoteVideoJob = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: payload.prompt,
        duration: payload.duration ?? 5,
        aspectRatio: payload.aspectRatio ?? '16:9',
        mode: payload.mode ?? 'std',
        status: 'running',
        stage: 'submitting',
        createdAt: Date.now(),
      }
      publishKlingJob(job)
      void runKlingJob(job)
      return job
    },
  })

  ipcMain.handle('videoGen:historyDelete', (_event, id: string) => {
    saveHistory(loadHistory().filter((item) => item.id !== id))
    const path = join(videoGenDir(), `${id}.mp4`)
    if (existsSync(path)) rmSync(path)
    return { ok: true }
  })
}

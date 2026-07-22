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

/** 读一条中继 SSE 流:status(阶段)回调 → 遇 result 返回其 data,遇 error 抛错。 */
async function readSseResult(
  resp: Response,
  onStatus: (stage: string) => void,
): Promise<Record<string, unknown>> {
  if (!resp.ok || !resp.body)
    throw new Error(`云端中继 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
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
      const data = JSON.parse(dataRaw) as Record<string, unknown>
      if (event === 'error') throw new Error(String(data.message ?? '云端任务失败'))
      if (event === 'status') onStatus(String(data.stage ?? 'running'))
      if (event === 'result') return data
    }
  }
  throw new Error('云端任务结束但没有返回结果')
}

// gpt-image-2 试衣的默认提示词:双参考图(人物 + 衣服)。
const TRYON_PROMPT =
  '让第一张图里的人物穿上第二张图里的这件衣服,完整替换其身上原有的服装;' +
  '严格保持人物的长相、发型、体型、姿势和背景完全不变,只更换服装;' +
  '写实自然,不要在画面里保留任何缩略图、边框或水印。'

/** gpt-image-2 双参考图编辑:人物 + 衣服 → 人物穿上衣服的图(R2 url)。 */
async function genTryOn(
  personUrl: string,
  garmentUrl: string,
  prompt: string,
  onStatus: (stage: string) => void,
): Promise<string> {
  const resp = await cloudFetch(
    '/imagegen',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt, referenceUrls: [personUrl, garmentUrl] }),
    },
    CLOUD_TIMEOUT_MS,
  )
  const data = await readSseResult(resp, onStatus)
  const url = (data.urls as string[] | undefined)?.[0]
  if (!url) throw new Error('试衣图生成失败:没有返回图片')
  return url
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
    const data = await readSseResult(resp, (s) => progress(s, 0))
    const videoUrl = data.videoUrl as string | undefined
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

// ── AI 试衣工作流:人物 + 衣服 → (首帧合成) + gpt-image-2 试衣尾帧 → Kling 换装视频 ──
type WorkflowPayload = {
  personDataUrl: string
  garmentDataUrl: string
  // 渲染进程已用 canvas 合成好的首帧(人物 + 左上角衣服缩略图)
  firstFrameDataUrl: string
  // 试衣提示词(可选,覆盖默认 TRYON_PROMPT)
  prompt?: string
}

async function runWorkflow(payload: WorkflowPayload): Promise<DressupResult> {
  if (!payload.personDataUrl) return { error: '请提供人物照片' }
  if (!payload.garmentDataUrl) return { error: '请提供衣服图片' }
  if (!payload.firstFrameDataUrl) return { error: '首帧合成失败,请重试' }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const progress = (status: string): void =>
    broadcast('dressup:progress', { id, status, progress: 0, prompt: payload.prompt ?? '' })

  try {
    progress('uploading')
    const [personUrl, garmentUrl, firstFrameUrl] = await Promise.all([
      uploadReference(payload.personDataUrl),
      uploadReference(payload.garmentDataUrl),
      uploadReference(payload.firstFrameDataUrl),
    ])

    // ① gpt-image-2 试衣 → 尾帧
    progress('tryon')
    const tailFrameUrl = await genTryOn(
      personUrl,
      garmentUrl,
      payload.prompt?.trim() || TRYON_PROMPT,
      (s) => progress(`tryon:${s}`),
    )

    // ② Kling 首帧(合成)→尾帧(试衣) 换装视频
    progress('video')
    const resp = await cloudFetch(
      '/dressup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstFrameUrl, tailFrameUrl, mode: 'std' }),
      },
      CLOUD_TIMEOUT_MS,
    )
    const data = await readSseResult(resp, (s) => progress(s))
    const videoUrl = data.videoUrl as string | undefined
    if (!videoUrl) throw new Error('换装视频生成失败:没有返回视频 URL')

    progress('downloading')
    const mp4Path = join(dressupDir(), `${id}.mp4`)
    await download(videoUrl, mp4Path)

    const item: DressupHistoryItem = {
      id,
      prompt: payload.prompt || '(AI 试衣换装)',
      mode: 'std',
      duration: '5',
      videoUrl: localFileUrl(mp4Path),
      cloudVideoUrl: videoUrl,
      createdAt: Date.now(),
    }
    saveHistory([item, ...loadHistory()])
    progress('done')
    return item
  } catch (err) {
    appendAppLog('error', 'dressup.workflow', 'AI 试衣换装失败', normalizeError(err))
    progress('error')
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
  ipcMain.handle('dressup:workflow', (_e, payload: WorkflowPayload) => runWorkflow(payload))
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

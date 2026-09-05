import { appendAppLog, normalizeError } from './app-log'
import { remoteControl, type RemoteVideoJob } from './remote-control'
import {
  cloudMediaFetch as cloudFetch,
  readCloudSseResult as readSseResult,
} from './cloud-media'

/**
 * 手机端的可灵文生视频。2026-09-04 起这个文件只剩这一条路。
 *
 * 原来还有一条 Grok(videoGen:generate → 后端 /videogen),走 3A 的
 * grok-imagine-video —— 那个模型已从 3A 下架,请求一律 403 model_not_allowed,
 * 后端那条路由也一并删了。桌面这边它本来就是死代码:contract 和 preload 里声明了
 * videoGen 那一组 IPC,但渲染层一次都没调过(VideoGenPage 走的是 dressup/可灵)。
 *
 * 可灵这条和当初的 Grok 那条不同,**不下载到本地**:手机要的是 R2 的公网链接,
 * 桌面白下一份几十 MB 的 mp4 没有意义。也不挂长请求 —— 手机切后台或换网就断了;
 * 这里发起即返回 job,状态变化推 video:job 事件。
 */
const KLING_TIMEOUT_MS = 10 * 60_000
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
    const timedOut = error instanceof Error && (
      error.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error.message)
    )
    publishKlingJob({
      ...job,
      status: 'error',
      stage: timedOut ? 'timeout' : 'error',
      error: timedOut
        ? '生成超过 10 分钟，已按失败处理'
        : error instanceof Error ? error.message : String(error),
    })
  }
}

export function registerVideoGen(): void {
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
}

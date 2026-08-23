import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

/**
 * pi-studio 内置扩展:把桌面端的云端生图接到 agent 上,让「描述一下,给我做张表情包」
 * 在对话里一句话就能完成,不必去 Workflow 里串节点。
 *
 * 凭据来自 spawn 时注入的 PI_CLOUD_IMAGE_RELAY / PI_CLOUD_IMAGE_KEY
 * (见 src/main/agent-runtime-config.ts)。盘上那份 key 是 safeStorage 加密的,
 * 这里只从进程环境读,不写任何明文文件。
 *
 * 工具结果里返回 ImageContent —— 模型能看见自己画出来的东西(可以据此自评再改),
 * ToolCallCard 也会把它渲染成缩略图。
 *
 * 另外接管 before_agent_start:用户粘进对话的图只存在于消息里,工具够不着
 * (base64 塞不进工具参数)。这个事件能看见 images,于是在这里落盘并把路径写进
 * 本轮系统提示,模型就能把它交给 image_gen 当参考图。
 */

const CLOUD_TIMEOUT_MS = 320_000
const REFERENCE_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 20_000

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * 粘贴图的落盘位置。写和读都在 agent 进程里,所以沙箱模式下这就是容器自己的 tmp,
 * 不需要任何宿主/容器路径翻译。
 */
const PASTED_DIR = join(tmpdir(), 'pi-studio-pasted')

/** 只保留最近这么多张;粘贴图是一次性的,不该无限堆积。 */
const PASTED_KEEP = 40

const parameters = Type.Object({
  prompt: Type.String({
    description:
      '完整的画面描述。写清主体、表情/动作、构图、风格和背景。' +
      '画面里要出现的文字必须逐字写出来,并说明位置(如「上方文案:加班到深夜」)。',
  }),
  size: Type.Optional(
    Type.Union(
      [
        Type.Literal('1024x1024'),
        Type.Literal('1024x1536'),
        Type.Literal('1536x1024'),
        Type.Literal('auto'),
      ],
      { description: '输出尺寸,默认 1024x1024。表情包用 1024x1024。' },
    ),
  ),
  referencePaths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        '参考图的文件路径,相对(相对工作区)或绝对均可。给了就是参考这些图改,不是从零画。' +
        '用户在对话里粘贴的图片,其落盘路径见系统提示,直接填这里。',
    }),
  ),
})

type Params = Static<typeof parameters>

type CloudEnv = { relay: string; key: string }

type ImageGenDetails = {
  urls: string[]
  referenceCount: number
}

/** 生图凭据只从进程环境读;主进程没注入就说明云端没配置。 */
function readCloudEnv(): CloudEnv | null {
  const relay = (process.env.PI_CLOUD_IMAGE_RELAY ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.PI_CLOUD_IMAGE_KEY ?? '').trim()
  if (!relay || !key) return null
  return { relay, key }
}

function cloudFetch(
  env: CloudEnv,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-API-Key', env.key)
  return fetch(`${env.relay}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
}

async function uploadReference(
  env: CloudEnv,
  cwd: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const contentType = MIME_BY_EXT[extname(absolute).toLowerCase()]
  if (!contentType) throw new Error(`参考图格式不支持: ${path}(支持 png/jpg/webp/gif)`)

  let bytes: Buffer
  try {
    bytes = await readFile(absolute)
  } catch {
    throw new Error(`参考图读不到: ${path}`)
  }

  const response = await cloudFetch(
    env,
    '/imagegen/reference',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: bytes.toString('base64'), content_type: contentType }),
    },
    REFERENCE_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`参考图上传失败(${response.status}): ${text.slice(0, 200)}`)
  }
  const result = (await response.json()) as { url?: string }
  if (!result.url) throw new Error('参考图上传成功但没有返回 URL')
  return result.url
}

/**
 * 云端生图是一条 SSE 长连接:event: result 里带 R2 URL,event: error 带失败原因。
 * 与 src/main/image-gen.ts 的 cloudGenerate 同协议。
 */
async function generate(
  env: CloudEnv,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const response = await cloudFetch(
    env,
    '/imagegen',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    CLOUD_TIMEOUT_MS,
    signal,
  )
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`云端中继 ${response.status}: ${text.slice(0, 200)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separator: number
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const raw = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !raw) continue
      const data = JSON.parse(raw) as { message?: string; urls?: unknown }

      if (event === 'error') throw new Error(data.message || '云端生成失败')
      if (event === 'result') {
        const urls = Array.isArray(data.urls)
          ? data.urls.filter((item: unknown): item is string => typeof item === 'string')
          : []
        if (urls.length === 0) throw new Error('云端任务完成但没有返回图片 URL')
        return urls
      }
      // event: status —— 阶段进度,这里不需要
    }
  }
  throw new Error('云端连接在收到结果前断开了')
}

/** 把 R2 上的成品下回来转 base64,这样模型和界面拿到的是图本身而不只是一个链接。 */
async function download(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`下载结果图失败(${response.status})`)
  const mimeType = response.headers.get('content-type') || 'image/png'
  const data = Buffer.from(await response.arrayBuffer()).toString('base64')
  return { data, mimeType }
}

/** 删掉最旧的,只留 PASTED_KEEP 张。目录读不了就算了,别为了清理把这一轮搞挂。 */
function prunePastedImages(): void {
  let entries: string[]
  try {
    entries = readdirSync(PASTED_DIR)
  } catch {
    return
  }
  if (entries.length <= PASTED_KEEP) return

  const byAge = entries
    .map((name) => {
      const full = join(PASTED_DIR, name)
      try {
        return { full, mtime: statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((entry): entry is { full: string; mtime: number } => entry !== null)
    .sort((a, b) => a.mtime - b.mtime)

  for (const entry of byAge.slice(0, Math.max(0, byAge.length - PASTED_KEEP))) {
    try {
      rmSync(entry.full, { force: true })
    } catch {
      // 清不掉就留着,不影响本轮
    }
  }
}

/** 把本轮粘贴的图落盘,返回写成功的绝对路径。 */
function stashPastedImages(images: readonly ImageContent[]): string[] {
  const paths: string[] = []
  for (const image of images) {
    const ext = EXT_BY_MIME[image.mimeType?.toLowerCase() ?? '']
    if (!ext || !image.data) continue
    try {
      mkdirSync(PASTED_DIR, { recursive: true })
      const target = join(PASTED_DIR, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`)
      writeFileSync(target, Buffer.from(image.data, 'base64'))
      paths.push(target)
    } catch {
      // 单张写失败不该让整轮对话失败:模型仍然看得见这张图,只是没法当参考图用
    }
  }
  if (paths.length > 0) prunePastedImages()
  return paths
}

function pastedImagesNote(paths: readonly string[]): string {
  const list = paths.map((path) => `- ${path}`).join('\n')
  return (
    '本轮用户粘贴的图片已经存到本地(就是你在消息里看到的那几张):\n' +
    `${list}\n` +
    '要以它们为参考生图时,把对应路径放进 image_gen 的 referencePaths,' +
    '不要凭记忆重新描述再从零画。'
  )
}

export default function piStudioImagegen(pi: ExtensionAPI): void {
  // 粘贴图 → 落盘 → 路径写进本轮系统提示。放在 systemPrompt 而不是拼进用户消息里,
  // 免得会话恢复后聊天记录里多出一段不是用户写的话。
  pi.on('before_agent_start', (event) => {
    const images = event.images ?? []
    if (images.length === 0) return
    const paths = stashPastedImages(images)
    if (paths.length === 0) return
    return { systemPrompt: `${event.systemPrompt}\n\n${pastedImagesNote(paths)}` }
  })

  pi.registerTool({
    name: 'image_gen',
    label: '云端生图',
    description:
      '调用 pi-studio 的云端生图,直接产出一张图片。' +
      '适合表情包、插图、头像、封面、概念图这类"用户要一张图"的请求。' +
      '结果会作为图片返回,你能看见成品,可以据此判断要不要改提示词重画。' +
      '画面内文字要在 prompt 里逐字写明。',
    promptSnippet: 'image_gen: 云端生成图片(表情包/插图/头像/封面),返回图片本身',
    parameters,
    async execute(
      _toolCallId: string,
      params: Params,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<ImageGenDetails>> {
      const env = readCloudEnv()
      if (!env) {
        throw new Error('云端图像服务未配置,请在 pi-studio 设置里填好中继地址和密钥后重开会话')
      }

      const prompt = params.prompt.trim()
      if (!prompt) throw new Error('prompt 不能为空')

      const referencePaths = params.referencePaths ?? []
      const referenceUrls: string[] = []
      for (const path of referencePaths) {
        referenceUrls.push(await uploadReference(env, ctx.cwd, path, signal))
      }

      const urls = await generate(
        env,
        {
          prompt,
          batchId: crypto.randomUUID(),
          size: params.size ?? '1024x1024',
          ...(referenceUrls.length > 0 ? { referenceUrls } : {}),
        },
        signal,
      )

      const image = await download(urls[0], signal)
      return {
        content: [
          { type: 'image', data: image.data, mimeType: image.mimeType },
          { type: 'text', text: `已生成图片:${urls[0]}` },
        ],
        details: { urls, referenceCount: referenceUrls.length },
      }
    },
  })
}

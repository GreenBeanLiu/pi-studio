import { loadSettings } from './settings'

/**
 * AI 视觉还原度评审:把参考图(或提示词)和 3D 模型渲染图交给用户配置的
 * 聊天模型对比打分。走 settings 的 provider/apiKey/baseUrl,与 pi 引擎共用凭据,
 * 不引入新的服务依赖。灵感来自 threejs-object-sculptor 的 Screenshot Feedback Gate
 * ("像素对比不是验收权威,AI 视觉才是")。
 */

export type VisionReview = { score: number; notes: string; model: string }

const TIMEOUT_MS = 60_000

const FALLBACK_MODEL: Record<string, string> = {
  openai: 'gpt-5.4',
  anthropic: 'claude-haiku-4-5-20251001',
}

function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/v1')) return `${base}${path.replace(/^\/v1/, '')}`
  return `${base}${path}`
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) throw new Error('图片 data URL 无法解析')
  return { mediaType: m[1], base64: m[2] }
}

/** 从模型输出里抠出 JSON(容忍 ```json 围栏和前后废话)。 */
function extractReview(text: string, model: string): VisionReview {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) throw new Error(`模型输出不含 JSON: ${text.slice(0, 120)}`)
  const parsed = JSON.parse(m[0]) as { score?: unknown; notes?: unknown }
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))))
  if (!Number.isFinite(score)) throw new Error('score 不是数字')
  return { score, notes: String(parsed.notes ?? '').slice(0, 120), model }
}

function buildPrompt(mode: 'text' | 'image', promptText: string): string {
  const rubric =
    '从「轮廓与比例 / 部件结构 / 材质与颜色」三方面评估,只输出 JSON:' +
    '{"score":0到100的整数,"notes":"不超过40字的中文点评,点出最明显的差异"}'
  return mode === 'image'
    ? `你是 3D 重建质检员。第 1 张是用户的参考图,第 2 张是据此生成的 3D 模型渲染图。评估模型对参考图的还原度。${rubric}`
    : `你是 3D 重建质检员。这张图是根据提示词生成的 3D 模型渲染图,提示词:「${promptText}」。评估模型与提示词的匹配度。${rubric}`
}

export async function reviewModelRender(input: {
  mode: 'text' | 'image'
  prompt: string
  referenceDataUrl?: string
  renderDataUrl: string
}): Promise<VisionReview> {
  const s = loadSettings()
  if (!s.apiKey.trim()) throw new Error('未配置模型服务 API Key,跳过评分')
  const model = s.model.trim() || FALLBACK_MODEL[s.provider]
  const question = buildPrompt(input.mode, input.prompt)
  const images = [
    ...(input.mode === 'image' && input.referenceDataUrl ? [input.referenceDataUrl] : []),
    input.renderDataUrl,
  ]

  const text =
    s.provider === 'openai'
      ? await callOpenAI(s.baseUrl || 'https://api.openai.com', s.apiKey, model, question, images)
      : await callAnthropic(s.baseUrl || 'https://api.anthropic.com', s.apiKey, model, question, images)
  return extractReview(text, model)
}

async function callOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  question: string,
  imageDataUrls: string[],
): Promise<string> {
  const resp = await fetch(joinApiPath(baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`评分请求失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('评分响应没有内容')
  return content
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  question: string,
  imageDataUrls: string[],
): Promise<string> {
  const resp = await fetch(joinApiPath(baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            ...imageDataUrls.map((url) => {
              const { mediaType, base64 } = parseDataUrl(url)
              return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
            }),
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`评分请求失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = (await resp.json()) as { content?: { type: string; text?: string }[] }
  const content = data.content?.find((b) => b.type === 'text')?.text
  if (!content) throw new Error('评分响应没有内容')
  return content
}

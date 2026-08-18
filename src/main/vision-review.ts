import { prepareAgentRuntime } from './agent-runtime-config'
import { getCloudConnection } from './cloud-connection'

/**
 * AI 视觉还原度评审:把参考图(或提示词)和 3D 模型渲染图交给当前聊天模型对比打分。
 * 灵感来自 threejs-object-sculptor 的 Screenshot Feedback Gate
 * ("像素对比不是验收权威,AI 视觉才是")。
 *
 * 直连 provider 退役后,这里跟聊天走同一条云端网关线路(profile + 模型 + 会话令牌都
 * 取自 prepareAgentRuntime),不再自己持有 key。网关只有 openai-completions 一种形状,
 * 所以 Anthropic 那套 /v1/messages 调法一并去掉。
 */

export type VisionReview = { score: number; notes: string; model: string }

const TIMEOUT_MS = 60_000

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
  const connection = getCloudConnection()
  if (!connection.available) throw new Error('未配置云端模型线路,跳过评分')
  const runtime = await prepareAgentRuntime()
  const model = runtime.model
  const chatToken = runtime.env.PI_STUDIO_LLM_KEY
  if (!model || !chatToken) throw new Error('云端模型线路不可用,跳过评分')

  const question = buildPrompt(input.mode, input.prompt)
  const images = [
    ...(input.mode === 'image' && input.referenceDataUrl ? [input.referenceDataUrl] : []),
    input.renderDataUrl,
  ]

  const relay = connection.relay.trim().replace(/\/+$/, '')
  const endpoint = `${relay}/llm/v1/${encodeURIComponent(runtime.provider)}/chat/completions`
  const text = await callGateway(endpoint, chatToken, model, question, images)
  return extractReview(text, model)
}

async function callGateway(
  endpoint: string,
  apiKey: string,
  model: string,
  question: string,
  imageDataUrls: string[],
): Promise<string> {
  const resp = await fetch(endpoint, {
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

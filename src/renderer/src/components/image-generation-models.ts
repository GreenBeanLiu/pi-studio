import type {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  GrokImageAspectRatio,
  GrokImageResolution,
  ImageGenBackground,
  ImageGenEngine,
  ImageGenModeration,
  ImageGenOutputFormat,
  ImageGenQuality,
  ImageGenResponseFormat,
  ImageGenSize,
} from '../lib/api'

export type ImageModelKey =
  | 'gpt-image-2'
  | 'sdxl-local'
  | 'gemini-3-pro-image-preview'
  | 'grok-imagine-image'
  | 'grok-imagine-image-quality'

export type ImageModelDefinition = {
  key: ImageModelKey
  label: string
  description: string
  group: '云端模型' | '本地模型'
  engine: ImageGenEngine
  cloudModel?: Exclude<ImageModelKey, 'sdxl-local' | 'gpt-image-2'>
  parameters: 'gpt' | 'gemini' | 'grok' | 'sdxl'
  acceptsImage: boolean
  acceptsMask: boolean
}

export const IMAGE_MODELS: readonly ImageModelDefinition[] = [
  {
    key: 'gpt-image-2',
    label: 'GPT Image 2',
    description: '文生图 / 改图 / 蒙版',
    group: '云端模型',
    engine: 'openai',
    parameters: 'gpt',
    acceptsImage: true,
    acceptsMask: true,
  },
  {
    key: 'gemini-3-pro-image-preview',
    label: 'Gemini Image',
    description: '文生图 / 参考图改图',
    group: '云端模型',
    engine: 'gemini',
    cloudModel: 'gemini-3-pro-image-preview',
    parameters: 'gemini',
    acceptsImage: true,
    acceptsMask: false,
  },
  {
    key: 'grok-imagine-image',
    label: 'Grok Image',
    description: '标准文生图',
    group: '云端模型',
    engine: 'grok',
    cloudModel: 'grok-imagine-image',
    parameters: 'grok',
    acceptsImage: false,
    acceptsMask: false,
  },
  {
    key: 'grok-imagine-image-quality',
    label: 'Grok Image 高质量',
    description: '高质量文生图',
    group: '云端模型',
    engine: 'grok',
    cloudModel: 'grok-imagine-image-quality',
    parameters: 'grok',
    acceptsImage: false,
    acceptsMask: false,
  },
  {
    key: 'sdxl-local',
    label: 'SDXL 本地',
    description: '文生图 / 本地改图',
    group: '本地模型',
    engine: 'comfy',
    parameters: 'sdxl',
    acceptsImage: true,
    acceptsMask: true,
  },
] as const

const MODEL_BY_KEY = new Map(IMAGE_MODELS.map((model) => [model.key, model]))

export function imageModel(key: ImageModelKey): ImageModelDefinition {
  const model = MODEL_BY_KEY.get(key)
  if (!model) throw new Error(`Unknown image model: ${key}`)
  return model
}

export function defaultImageModel(engine: string | undefined): ImageModelKey {
  if (engine === 'openai') return 'gpt-image-2'
  if (engine === 'gemini') return 'gemini-3-pro-image-preview'
  if (engine === 'grok') return 'grok-imagine-image'
  return 'sdxl-local'
}

export type ImageOutputSettings = {
  count: number
  size: ImageGenSize
  quality: ImageGenQuality
  background: ImageGenBackground
  outputFormat: ImageGenOutputFormat
  outputCompression: number
  moderation: ImageGenModeration
  responseFormat: ImageGenResponseFormat
  requestUser: string
  advanced: boolean
  geminiAspectRatio: GeminiImageAspectRatio
  geminiImageSize: GeminiImageResolution
  grokAspectRatio: GrokImageAspectRatio
  grokImageSize: GrokImageResolution
}

export type ImageGenerationRequest = {
  prompt: string
  engine: ImageGenEngine
  batchId: string
  model?: ImageModelDefinition['cloudModel']
  referenceUrls?: string[]
  maskDataUrl?: string
  size?: ImageGenSize
  aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
  imageSize?: GeminiImageResolution | GrokImageResolution
  n: number
  quality?: ImageGenQuality
  background?: ImageGenBackground
  outputFormat?: ImageGenOutputFormat
  outputCompression?: number
  moderation?: ImageGenModeration
  responseFormat?: ImageGenResponseFormat
  user?: string
}

export function buildImageGenerationRequest(args: {
  modelKey: ImageModelKey
  prompt: string
  batchId: string
  referenceUrls?: string[]
  maskDataUrl?: string
  output: ImageOutputSettings
}): ImageGenerationRequest {
  const model = imageModel(args.modelKey)
  const references = model.acceptsImage ? args.referenceUrls : undefined
  const mask = model.acceptsMask ? args.maskDataUrl : undefined
  const prompt = args.prompt.trim() || (references?.length
    ? '基于输入图片生成一个高质量变体，保留主体与构图'
    : '')
  if (!prompt) throw new Error('请输入文字或上传图片')
  const n = mask ? 1 : Math.max(1, Math.min(4, args.output.count))

  const base: ImageGenerationRequest = {
    prompt,
    engine: model.engine,
    batchId: args.batchId,
    ...(model.cloudModel ? { model: model.cloudModel } : {}),
    ...(references?.length ? { referenceUrls: references } : {}),
    ...(mask ? { maskDataUrl: mask } : {}),
    n,
  }

  if (model.parameters === 'gpt') {
    return {
      ...base,
      size: args.output.size,
      quality: args.output.quality,
      ...(args.output.advanced ? {
        background: args.output.background,
        outputFormat: args.output.outputFormat,
        ...(args.output.outputFormat !== 'png' ? { outputCompression: args.output.outputCompression } : {}),
        moderation: args.output.moderation,
        responseFormat: args.output.responseFormat,
        ...(args.output.requestUser.trim() ? { user: args.output.requestUser.trim() } : {}),
      } : {}),
    }
  }
  if (model.parameters === 'gemini') {
    return {
      ...base,
      aspectRatio: args.output.geminiAspectRatio,
      imageSize: args.output.geminiImageSize,
    }
  }
  if (model.parameters === 'grok') {
    return {
      ...base,
      aspectRatio: args.output.grokAspectRatio,
      imageSize: args.output.grokImageSize,
    }
  }
  return base
}

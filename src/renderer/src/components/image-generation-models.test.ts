import { describe, expect, it } from 'vitest'

import { buildImageGenerationRequest, defaultImageModel, type ImageOutputSettings } from './image-generation-models'

const output: ImageOutputSettings = {
  count: 4,
  size: '1024x1024',
  quality: 'high',
  background: 'transparent',
  outputFormat: 'webp',
  outputCompression: 85,
  moderation: 'auto',
  responseFormat: 'url',
  requestUser: 'pi-studio-test',
  advanced: true,
  geminiAspectRatio: '16:9',
  geminiImageSize: '2K',
  grokAspectRatio: '20:9',
  grokImageSize: '2K',
}

describe('image generation model catalog', () => {
  it('maps stored engine preferences to a model', () => {
    expect(defaultImageModel('openai')).toBe('gpt-image-2')
    expect(defaultImageModel('gemini')).toBe('gemini-3-pro-image-preview')
    expect(defaultImageModel('grok')).toBe('grok-imagine-image')
    // 本地引擎已移除:老设置里存的 'comfy' 回退到云端默认
    expect(defaultImageModel('comfy')).toBe('gpt-image-2')
  })

  it('builds one four-image GPT batch from an image-only input', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2',
      prompt: '',
      batchId: 'batch-1',
      referenceUrls: ['https://assets.example/input.png'],
      output,
    })
    expect(request.prompt).not.toBe('')
    expect(request.n).toBe(4)
    expect(request.referenceUrls).toEqual(['https://assets.example/input.png'])
    expect(request.outputFormat).toBe('webp')
    expect(request.outputCompression).toBe(85)
  })

  it('forces a masked edit to one image', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'gpt-image-2',
      prompt: 'replace the sky',
      batchId: 'batch-2',
      referenceUrls: ['https://assets.example/input.png'],
      maskDataUrl: 'data:image/png;base64,mask',
      output,
    })
    expect(request.n).toBe(1)
  })

  it('ignores unsupported image input and maps Grok output parameters', () => {
    const request = buildImageGenerationRequest({
      modelKey: 'grok-imagine-image-quality',
      prompt: 'a robot',
      batchId: 'batch-3',
      referenceUrls: ['https://assets.example/input.png'],
      output,
    })
    expect(request.referenceUrls).toBeUndefined()
    expect(request.model).toBe('grok-imagine-image-quality')
    expect(request.aspectRatio).toBe('20:9')
    expect(request.imageSize).toBe('2K')
    expect(request.n).toBe(4)
  })
})

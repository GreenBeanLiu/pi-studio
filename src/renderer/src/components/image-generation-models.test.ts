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
  providerStyle: 'natural',
  requestUser: 'pi-studio-test',
  advanced: true,
  geminiAspectRatio: '16:9',
  geminiImageSize: '2K',
}

describe('image generation model catalog', () => {
  it('maps stored engine preferences to a model', () => {
    expect(defaultImageModel('openai')).toBe('gpt-image-2')
    // Gemini Flash currently returns 400 through the configured relay; Pro is verified.
    expect(defaultImageModel('gemini')).toBe('gemini-3-pro-image-preview')
    // 已移除的引擎:'comfy'(本地引擎)和 'grok'(2026-09-04 随 3A 下架删掉),
    // 老设置里存的值必须回退到云端默认,而不是抛错或返回一个不存在的模型
    expect(defaultImageModel('comfy')).toBe('gpt-image-2')
    expect(defaultImageModel('grok')).toBe('gpt-image-2')
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

  // 2026-09-04 删掉了一条 "acceptsImage: false 的模型要丢掉 referenceUrls" 的用例 ——
  // 它是拿 grok-imagine-image-quality 驱动的,而 grok 已随 3A 下架移除。目录里现在
  // 每个模型都 acceptsImage: true,那条分支暂时没有模型能覆盖到;代码里保留着,
  // 等下一个不吃参考图的模型进来再补测试。
})

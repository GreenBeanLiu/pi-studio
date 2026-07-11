import { describe, expect, it } from 'vitest'
import { isCompatibleCheckpoint } from './comfy-workflow'

describe('Comfy workflow checkpoint compatibility', () => {
  it('accepts SD checkpoint families used by the built-in graph', () => {
    expect(isCompatibleCheckpoint('sd_xl_base_1.0.safetensors')).toBe(true)
    expect(isCompatibleCheckpoint('models/custom/v1-5-pruned-emaonly.safetensors')).toBe(true)
  })

  it('rejects model families that need a dedicated workflow', () => {
    expect(isCompatibleCheckpoint('models/flux1-dev.safetensors')).toBe(false)
    expect(isCompatibleCheckpoint('wan2.1_t2v.safetensors')).toBe(false)
    expect(isCompatibleCheckpoint('qwen2.5-vl.safetensors')).toBe(false)
  })
})

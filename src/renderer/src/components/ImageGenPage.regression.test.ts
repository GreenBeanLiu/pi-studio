import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./ImageGenPage.tsx', import.meta.url), 'utf8')

describe('ImageGenPage UI regressions', () => {
  it('keeps GPT image size choices compact instead of filling tall grid rows', () => {
    expect(source).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))')
    expect(source).toContain('height: 58px')
    expect(source).toContain('sizeGlyphFrame')
    expect(source).toContain('maxWidth = 30')
  })

  it('offers Gemini aspect ratio and resolution controls instead of disabling GPT sizes', () => {
    expect(source).toContain('const GEMINI_ASPECT_OPTIONS')
    expect(source).toContain('const GEMINI_RESOLUTION_OPTIONS')
    expect(source).toContain('aspectRatio: geminiAspectRatio')
    expect(source).toContain('imageSize: geminiImageSize')
    expect(source).not.toContain("disabled={engine !== 'openai'}")
  })

  it('allows selecting SDXL even before the local runtime is installed', () => {
    expect(source).toContain("key: 'comfy'")
    expect(source).not.toMatch(/\{\s*key:\s*'comfy',\s*label:\s*'SDXL 生图',\s*disabled:/)
  })

  it('renders square history thumbnails and selectable prompts', () => {
    expect(source).toContain('aspect-ratio: 1')
    expect(source).toContain('transform: scale(1.08)')
    expect(source).toContain('user-select: text')
    expect(source).toContain('historyTag(h.engine, h.provider)')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./ImageGenPage.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('./ImageGenerationWorkspace.tsx', import.meta.url), 'utf8')
const selector = readFileSync(new URL('./ImageModelSelector.tsx', import.meta.url), 'utf8')
const output = readFileSync(new URL('./ImageOutputSection.tsx', import.meta.url), 'utf8')
const historyRow = readFileSync(new URL('./ImageHistoryBatchRow.tsx', import.meta.url), 'utf8')
const mainImageGen = readFileSync(new URL('../../../main/image-gen.ts', import.meta.url), 'utf8')

describe('Image generation workspace regressions', () => {
  it('uses the modular workspace instead of the legacy tab page', () => {
    expect(page).toContain('<ImageGenerationWorkspace MaskEditorComponent={ImageMaskEditor} />')
    expect(workspace).toContain('<ImageModelSelector')
    expect(workspace).toContain('<ImageInputSection')
    expect(workspace).toContain('<ImageOutputSection')
  })

  it('selects growing model catalogs from one grouped dropdown', () => {
    expect(selector).toContain('<Select')
    expect(selector).toContain('IMAGE_MODELS.filter')
    expect(selector).not.toContain('<Tabs')
  })

  it('offers model-specific output parameters and one to four images', () => {
    expect(output).toContain("model.parameters === 'gpt'")
    expect(output).toContain("model.parameters === 'gemini'")
    expect(output).toContain("model.parameters === 'grok'")
    expect(output).toContain('[1, 2, 3, 4]')
    expect(output).toContain('hasMask && count !== 1')
  })

  it('submits and renders one generation batch', () => {
    expect(workspace).toContain('const batchId = crypto.randomUUID()')
    expect(workspace).toContain('groupImageGenerationHistory')
    expect(workspace).toContain('historyDeleteBatch')
    expect(historyRow).toContain('grid-template-columns: repeat(auto-fill, minmax(180px, 220px))')
    expect(historyRow).toContain('text-overflow: ellipsis')
    expect(historyRow).toContain('position: absolute')
    expect(mainImageGen).toContain('return { ...resolved, urls }')
    expect(workspace).toContain('result.urls?.length ? result.urls')
  })

  it('previews images directly and only reveals actions on hover', () => {
    expect(historyRow).toContain('onClick={() => onPreview(image.url)}')
    expect(historyRow).not.toContain('<Checkbox')
    expect(historyRow).not.toContain('styles.badge')
    expect(historyRow).toContain('&:hover .image-actions')
    expect(historyRow).toContain('opacity: 0')
    expect(workspace).toContain('<img src={preview} alt="预览" />')
    expect(workspace).not.toContain('selectedByBatch')
  })
})

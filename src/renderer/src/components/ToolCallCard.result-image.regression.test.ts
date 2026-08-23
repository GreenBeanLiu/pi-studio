import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const toolCallCard = readFileSync(new URL('./ToolCallCard.tsx', import.meta.url), 'utf8')

// 2026-08-21: 对话里让 agent 出图,卡片只显示一行文本 —— pi 的 toolResult.content
// 本来就带 ImageContent,是 stringifyResult 只挑 text、把图整个丢了。
describe('tool result images', () => {
  it('pulls ImageContent out of the tool result', () => {
    expect(toolCallCard).toContain('function resultImages(result: unknown): ResultImage[]')
    expect(toolCallCard).toContain("block.type !== 'image'")
  })

  it('never lets an image-only result reach JSON.stringify', () => {
    // 否则整段 base64 会被当成结果正文倒进卡片
    expect(toolCallCard).toContain('if (resultImages(result).length > 0) return ')
  })

  it('renders the images outside the collapse, since the image is the result', () => {
    expect(toolCallCard).toContain('{images.length > 0 && (')
    expect(toolCallCard).toContain('src={`data:${img.mimeType};base64,${img.data}`}')
    expect(toolCallCard).toContain('imageStrip')
  })
})

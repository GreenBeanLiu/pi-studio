import { describe, expect, it } from 'vitest'
import { imageInsertionPositions } from './feishu-doc-layout'

describe('imageInsertionPositions', () => {
  it('places one image inside the opening paragraphs', () => {
    expect(imageInsertionPositions(8, 1)).toEqual([2])
  })

  it('distributes multiple images in document order', () => {
    const positions = imageInsertionPositions(10, 3)
    expect(positions).toEqual([3, 5, 8])
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('does not produce positions outside the text block range', () => {
    expect(imageInsertionPositions(2, 5).every((position) => position >= 0 && position <= 2)).toBe(true)
  })
})

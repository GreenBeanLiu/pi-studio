import { describe, expect, it } from 'vitest'

import type { ImageGenHistoryItem } from '../lib/api'
import { groupImageGenerationHistory } from './image-generation-history'

function item(id: string, batchId: string, createdAt: number): ImageGenHistoryItem {
  return {
    id,
    batch_id: batchId,
    prompt: `prompt-${batchId}`,
    engine: 'cloud-generate',
    model: 'gpt-image-2',
    provider: 'three-a',
    url: `https://assets.example/${id}.png`,
    created_at: createdAt,
  }
}

describe('generation history batches', () => {
  it('renders a four-image generation as one ordered row', () => {
    const batches = groupImageGenerationHistory([
      item('b-2', 'batch-b', 30),
      item('a-4', 'batch-a', 14),
      item('a-2', 'batch-a', 12),
      item('a-1', 'batch-a', 11),
      item('a-3', 'batch-a', 13),
    ])

    expect(batches.map((batch) => batch.id)).toEqual(['batch-b', 'batch-a'])
    expect(batches[1].images.map((image) => image.id)).toEqual(['a-1', 'a-2', 'a-3', 'a-4'])
  })

  it('keeps legacy rows separate when batch_id is empty', () => {
    const batches = groupImageGenerationHistory([item('one', '', 2), item('two', '', 1)])
    expect(batches.map((batch) => batch.id)).toEqual(['one', 'two'])
  })
})

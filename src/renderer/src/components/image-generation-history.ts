import type { ImageGenHistoryItem } from '../lib/api'

export type ImageGenerationBatch = {
  id: string
  prompt: string
  engine: string
  model: string | null
  provider: string | null
  createdAt: number
  images: ImageGenHistoryItem[]
}

export function groupImageGenerationHistory(items: ImageGenHistoryItem[]): ImageGenerationBatch[] {
  const batches = new Map<string, ImageGenerationBatch>()
  for (const item of items) {
    const batchId = item.batch_id || item.id
    const existing = batches.get(batchId)
    if (existing) {
      existing.images.push(item)
      existing.createdAt = Math.max(existing.createdAt, item.created_at)
      if (!existing.provider && item.provider) existing.provider = item.provider
      continue
    }
    batches.set(batchId, {
      id: batchId,
      prompt: item.prompt,
      engine: item.engine,
      model: item.model,
      provider: item.provider,
      createdAt: item.created_at,
      images: [item],
    })
  }
  return [...batches.values()]
    .map((batch) => ({
      ...batch,
      images: batch.images.sort((left, right) => left.created_at - right.created_at),
    }))
    .sort((left, right) => right.createdAt - left.createdAt)
}

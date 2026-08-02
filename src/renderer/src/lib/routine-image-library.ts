import type { ImageGenHistoryItem } from './api'

/** Normalizes image-generation history for reuse by workflow image pickers. */
export function buildRoutineImageLibrary(history: readonly ImageGenHistoryItem[]): ImageGenHistoryItem[] {
  const seen = new Set<string>()

  return [...history]
    .filter((item) => item.url.trim())
    .sort((a, b) => b.created_at - a.created_at)
    .filter((item) => {
      const url = item.url.trim()
      if (seen.has(url)) return false
      seen.add(url)
      return true
    })
}

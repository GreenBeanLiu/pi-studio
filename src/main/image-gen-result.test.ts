import { describe, expect, it, vi } from 'vitest'
import { resolveCloudImageResult } from './image-gen-result'

describe('resolveCloudImageResult', () => {
  it('does not download a cloud result when the caller only needs its public URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    const result = await resolveCloudImageResult(
      'https://pod.glanger.cc/generated/example.png',
      false,
      fetchImpl,
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toEqual({
      dataUrl: 'https://pod.glanger.cc/generated/example.png',
      publicUrl: 'https://pod.glanger.cc/generated/example.png',
    })
  })

  it('falls back to the public URL when the optional preview download times out', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )

    const result = await resolveCloudImageResult(
      'https://pod.glanger.cc/generated/example.png',
      true,
      fetchImpl,
    )

    expect(result).toMatchObject({
      dataUrl: 'https://pod.glanger.cc/generated/example.png',
      publicUrl: 'https://pod.glanger.cc/generated/example.png',
      downloadError: 'The operation was aborted due to timeout',
    })
  })
})

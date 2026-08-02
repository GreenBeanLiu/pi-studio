import { describe, expect, it } from 'vitest'
import { buildGrokVideoRequest } from './video-gen-request'

describe('Grok video request', () => {
  it('preserves every user-selected xAI-compatible generation option', () => {
    expect(
      buildGrokVideoRequest({
        prompt: 'A paper airplane circles a glass tower',
        imageUrl: 'https://cdn.example.com/start.png',
        duration: 10,
        aspectRatio: '16:9',
        resolution: '720p',
      }),
    ).toEqual({
      prompt: 'A paper airplane circles a glass tower',
      imageUrl: 'https://cdn.example.com/start.png',
      duration: 10,
      aspectRatio: '16:9',
      resolution: '720p',
    })
  })
})

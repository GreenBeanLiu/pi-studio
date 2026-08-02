export type GrokVideoAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
export type GrokVideoResolution = '480p' | '720p'

export type GrokVideoGeneratePayload = {
  prompt: string
  imageDataUrl?: string
  duration?: 5 | 10 | 15
  aspectRatio?: GrokVideoAspectRatio
  resolution?: GrokVideoResolution
}

export type GrokVideoRelayRequest = {
  prompt: string
  imageUrl?: string
  duration: 5 | 10 | 15
  aspectRatio: GrokVideoAspectRatio
  resolution: GrokVideoResolution
}

export function buildGrokVideoRequest(
  payload: Omit<GrokVideoGeneratePayload, 'imageDataUrl'> & { imageUrl?: string },
): GrokVideoRelayRequest {
  return {
    prompt: payload.prompt.trim(),
    ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    duration: payload.duration ?? 5,
    aspectRatio: payload.aspectRatio ?? '16:9',
    resolution: payload.resolution ?? '720p',
  }
}

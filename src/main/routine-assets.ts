export type RoutineImageAsset = {
  id: string
  kind: 'image'
  source: 'folder' | 'generated'
  name: string
  role: 'cover' | 'inline'
  uri: string
}

export function inferRoutineImageRole(name: string): RoutineImageAsset['role'] {
  return /cover|封面/i.test(name) ? 'cover' : 'inline'
}

export type WechatImageAssets = {
  cover?: RoutineImageAsset
  inline: RoutineImageAsset[]
}

export function selectWechatImageAssets(
  assets: readonly RoutineImageAsset[],
): WechatImageAssets {
  const byUri = new Map<string, RoutineImageAsset>()
  for (const asset of assets) {
    const existing = byUri.get(asset.uri)
    if (!existing || (existing.role !== 'cover' && asset.role === 'cover')) {
      byUri.set(asset.uri, asset)
    }
  }
  const unique = [...byUri.values()]
  const cover =
    unique.find((asset) => asset.role === 'cover') ??
    unique.find((asset) => asset.source === 'generated') ??
    unique[0]
  return {
    ...(cover ? { cover } : {}),
    inline: cover ? unique.filter((asset) => asset.uri !== cover.uri) : [],
  }
}

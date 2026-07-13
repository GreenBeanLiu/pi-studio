import { describe, expect, it } from 'vitest'
import {
  inferRoutineImageRole,
  selectWechatImageAssets,
  type RoutineImageAsset,
} from './routine-assets'

const image = (
  id: string,
  uri: string,
  role: RoutineImageAsset['role'] = 'inline',
): RoutineImageAsset => ({
  id,
  kind: 'image',
  source: id.startsWith('folder:') ? 'folder' : 'generated',
  name: `${id}.png`,
  role,
  uri,
})

describe('selectWechatImageAssets', () => {
  it('recognizes natural Chinese and English cover names', () => {
    expect(inferRoutineImageRole('文章封面图.jpg')).toBe('cover')
    expect(inferRoutineImageRole('hero-cover-final.png')).toBe('cover')
    expect(inferRoutineImageRole('正文插图.png')).toBe('inline')
  })

  it('uses an explicit cover, keeps every other image, and removes URI duplicates', () => {
    const result = selectWechatImageAssets([
      image('folder:photo', 'data:image/png;base64,photo'),
      image('generated:cover', 'https://images.example/cover.png', 'cover'),
      image('generated:duplicate', 'data:image/png;base64,photo'),
      image('folder:diagram', 'data:image/png;base64,diagram'),
    ])

    expect(result.cover?.id).toBe('generated:cover')
    expect(result.inline.map((asset) => asset.id)).toEqual(['folder:photo', 'folder:diagram'])
  })

  it('falls back to the first image as cover', () => {
    const result = selectWechatImageAssets([
      image('folder:first', 'data:image/png;base64,first'),
      image('folder:second', 'data:image/png;base64,second'),
    ])

    expect(result.cover?.id).toBe('folder:first')
    expect(result.inline.map((asset) => asset.id)).toEqual(['folder:second'])
  })

  it('prefers a generated image as the fallback cover over folder inline images', () => {
    const result = selectWechatImageAssets([
      image('folder:photo', 'data:image/png;base64,photo'),
      image('generated:hero', 'https://images.example/hero.png'),
    ])

    expect(result.cover?.id).toBe('generated:hero')
    expect(result.inline.map((asset) => asset.id)).toEqual(['folder:photo'])
  })
})

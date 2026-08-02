import { describe, expect, it } from 'vitest'
import { buildRoutineImageLibrary } from './routine-image-library'

describe('routine image library', () => {
  it('keeps reusable generated images newest-first and removes duplicate URLs', () => {
    const items = buildRoutineImageLibrary([
      {
        id: 'older',
        batch_id: 'batch-1',
        prompt: '白色连衣裙，商品平铺图',
        engine: 'openai',
        model: 'gpt-image-2',
        provider: 'cloud',
        url: 'https://assets.example/dress.png',
        created_at: 10,
      },
      {
        id: 'newer',
        batch_id: 'batch-2',
        prompt: '全身人物正面照',
        engine: 'openai',
        model: 'gpt-image-2',
        provider: 'cloud',
        url: 'https://assets.example/person.png',
        created_at: 30,
      },
      {
        id: 'duplicate',
        batch_id: 'batch-3',
        prompt: '重复的衣服图片',
        engine: 'openai',
        model: null,
        provider: null,
        url: 'https://assets.example/dress.png',
        created_at: 20,
      },
      {
        id: 'invalid',
        batch_id: 'batch-4',
        prompt: '无地址',
        engine: 'openai',
        model: null,
        provider: null,
        url: '   ',
        created_at: 40,
      },
    ])

    expect(items.map((item) => item.id)).toEqual(['newer', 'duplicate'])
    expect(items[1].prompt).toBe('重复的衣服图片')
  })
})

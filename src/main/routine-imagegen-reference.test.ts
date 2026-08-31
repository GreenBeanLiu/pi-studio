import { describe, expect, it } from 'vitest'
import { resolveImagegenReference } from './routines'
import type { Routine, RoutineStep } from './routines'

const routine = { workspacePath: '/tmp/does-not-matter' } as Routine

function context() {
  return {
    routine,
    triggerTime: '2026-08-31 09:00',
    triggerStamp: '20260831-090000',
    products: new Map([['出图', { output: 'ok', imageUrl: 'https://r2.example.com/a.png' }]]),
    prev: { output: 'ok', imageUrl: 'https://r2.example.com/a.png' },
  }
}

function step(imageRef?: string): RoutineStep {
  return { id: 'step', name: '生图', type: 'imagegen', prompt: '画一只猫', ...(imageRef !== undefined ? { imageRef } : {}) }
}

describe('imagegen reference resolution', () => {
  it('stays text-to-image when no reference is configured', async () => {
    const signal = new AbortController().signal
    // 空 / 全空白 / 字段缺失都不该悄悄变成改图
    expect(await resolveImagegenReference(step(), context(), signal)).toBeUndefined()
    expect(await resolveImagegenReference(step(''), context(), signal)).toBeUndefined()
    expect(await resolveImagegenReference(step('   '), context(), signal)).toBeUndefined()
  })

  it('passes an upstream image URL straight through without a download round trip', async () => {
    const signal = new AbortController().signal
    expect(await resolveImagegenReference(step('{{prev.imageUrl}}'), context(), signal)).toEqual([
      'https://r2.example.com/a.png',
    ])
    expect(await resolveImagegenReference(step('{{steps.出图.imageUrl}}'), context(), signal)).toEqual([
      'https://r2.example.com/a.png',
    ])
  })

  it('fails loudly when the configured reference never resolved', async () => {
    const signal = new AbortController().signal
    // 上游没产出图片时宁可报错,也不要静默退回文生图
    await expect(resolveImagegenReference(step('{{steps.不存在.imageUrl}}'), context(), signal)).rejects.toThrow(
      '参考图没有解析出来',
    )
  })
})

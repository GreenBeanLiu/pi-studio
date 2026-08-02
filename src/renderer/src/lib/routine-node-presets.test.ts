import { describe, expect, it } from 'vitest'
import { createRoutineStepFromPreset, ROUTINE_NODE_PRESETS } from './routine-node-presets'

describe('routine node presets', () => {
  it('contains the article building blocks', () => {
    expect(ROUTINE_NODE_PRESETS.map((preset) => preset.id)).toEqual(
      expect.arrayContaining([
        'input.material-folder',
        'article.research',
        'article.draft',
        'article.approval',
        'media.app-icon-master',
        'media.dressup-video',
        'output.wechat-html',
        'output.wechat-draft',
        'output.app-icon-bundle',
      ]),
    )
  })

  it('creates a dressup workflow node with independent person and garment inputs', () => {
    expect(createRoutineStepFromPreset('media.dressup-video')).toMatchObject({
      type: 'dressup',
      personRef: '',
      garmentRef: '',
    })
  })

  it('creates independent steps and injects the selected notification channel', () => {
    const first = createRoutineStepFromPreset('output.notify', 'channel-1')
    const second = createRoutineStepFromPreset('output.notify', 'channel-2')
    expect(first).toMatchObject({ type: 'notify', channelId: 'channel-1' })
    expect(second).toMatchObject({ type: 'notify', channelId: 'channel-2' })
    expect(first?.id).not.toBe(second?.id)
  })
})

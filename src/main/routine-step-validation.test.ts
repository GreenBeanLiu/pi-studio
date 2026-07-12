import { describe, expect, it } from 'vitest'
import { isRoutineStepComplete } from './routine-step-validation'

describe('routine step validation', () => {
  it('keeps a feishu-doc node when it has no agent prompt', () => {
    expect(isRoutineStepComplete({ name: '存飞书文档', type: 'feishu-doc' })).toBe(true)
  })

  it('still requires prompts and notification channels for their respective nodes', () => {
    expect(isRoutineStepComplete({ name: '写正文', type: 'agent' })).toBe(false)
    expect(isRoutineStepComplete({ name: '发送通知', type: 'notify' })).toBe(false)
    expect(isRoutineStepComplete({ name: '发送通知', type: 'notify', channelId: 'ch-1' })).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { routineStepSchema, stepProductSchema } from './routines'

describe('routine workflow node schemas', () => {
  it('validates node-specific required input fields', () => {
    const notify = routineStepSchema('notify')
    expect(() => notify.parse({ id: 'step', name: 'Notify', type: 'notify' })).toThrow('输入无效')
    expect(
      notify.parse({ id: 'step', name: 'Notify', type: 'notify', channelId: 'channel-1' }),
    ).toMatchObject({ channelId: 'channel-1' })
  })

  it('validates optional output fields and image descriptors', () => {
    expect(() => stepProductSchema.parse({ output: 'done', imageUrl: 123 })).toThrow('StepProduct')
    expect(
      stepProductSchema.parse({
        output: 'done',
        images: [
          {
            id: 'image-1',
            kind: 'image',
            source: 'generated',
            name: 'Cover',
            role: 'cover',
            uri: 'https://example.com/image.png',
          },
        ],
      }),
    ).toMatchObject({ output: 'done' })
  })
})

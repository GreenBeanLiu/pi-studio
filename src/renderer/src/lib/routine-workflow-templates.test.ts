import { describe, expect, it } from 'vitest'
import { dressupVideoWorkflowTemplate, memeWorkflowTemplate } from './routine-workflow-templates'

describe('routine workflow templates', () => {
  it('creates a ready-to-configure AI dressup video workflow', () => {
    const template = dressupVideoWorkflowTemplate('D:\\Works\\fashion-campaign')

    expect(template).toMatchObject({
      name: 'AI 换装视频',
      workspacePath: 'D:\\Works\\fashion-campaign',
      scheduleType: 'manual',
      steps: [
        {
          name: 'AI 试衣换装视频',
          type: 'dressup',
          personRef: '',
          garmentRef: '',
        },
      ],
    })
    expect(template.steps[0].prompt).toContain('保持人物')
  })

  it('creates a reviewable Chinese meme workflow', () => {
    const template = memeWorkflowTemplate('D:\\Works\\meme-lab')

    expect(template).toMatchObject({
      name: '表情包生成',
      workspacePath: 'D:\\Works\\meme-lab',
      scheduleType: 'manual',
      notify: 'error',
      steps: [
        { name: '策划表情包', type: 'agent' },
        { name: '确认梗和文案', type: 'review' },
        { name: '生成表情包', type: 'imagegen', engine: 'openai' },
        { name: '确认表情包成品', type: 'review' },
      ],
    })
    expect(template.steps[0].prompt).toContain('每行不超过 10 个汉字')
    expect(template.steps[2].prompt).toContain('{{steps.策划表情包.output}}')
  })
})

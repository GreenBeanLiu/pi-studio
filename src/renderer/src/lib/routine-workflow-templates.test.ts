import { describe, expect, it } from 'vitest'
import { dressupVideoWorkflowTemplate } from './routine-workflow-templates'

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
})

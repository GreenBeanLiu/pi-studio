import type { RoutineNotify, RoutineSchedule, RoutineStep } from './api'

export type RoutineWorkflowTemplate = {
  name: string
  input: string
  steps: RoutineStep[]
  workspacePath: string
  scheduleType: RoutineSchedule['type']
  minutes: number
  minute: number
  time: string
  day: number
  notify: RoutineNotify
  pushEachStep: boolean
}

function templateStepId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function dressupVideoWorkflowTemplate(workspacePath: string): RoutineWorkflowTemplate {
  return {
    name: 'AI 换装视频',
    input: '选择人物图和服装图，可补充想要的试衣效果与视频动作。',
    workspacePath,
    scheduleType: 'manual',
    minutes: 60,
    minute: 0,
    time: '09:00',
    day: 1,
    notify: 'error',
    pushEachStep: false,
    steps: [
      {
        id: templateStepId(),
        name: 'AI 试衣换装视频',
        type: 'dressup',
        personRef: '',
        garmentRef: '',
        prompt: '保持人物长相、发型、体型、姿势和背景不变，自然穿上指定服装，生成真实流畅的换装展示视频。',
      },
    ],
  }
}

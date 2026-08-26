import { describe, expect, it } from 'vitest'
import { acpModeLabel, describeAcpModes } from './acp-modes'

// 2026-08-25 从两个 agent 真实抓下来的 modes。
const CODEX = [
  { id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and run commands.' },
  { id: 'agent', name: 'Agent', description: 'Read and edit files, and run commands.' },
  { id: 'agent-full-access', name: 'Agent (full access)', description: 'Codex can edit files outside this workspace…' },
]
const CLAUDE = [
  { id: 'auto', name: 'Auto' },
  { id: 'default', name: 'Manual' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan Mode' },
  { id: 'dontAsk', name: "Don't Ask" },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
]

describe('describeAcpModes', () => {
  it('keeps the order the agent gave', () => {
    expect(describeAcpModes(CODEX).map((m) => m.id)).toEqual([
      'read-only',
      'agent',
      'agent-full-access',
    ])
  })

  it('annotates the ids it knows', () => {
    const [readOnly] = describeAcpModes(CODEX)
    expect(readOnly?.hint).toContain('只读')
    expect(readOnly?.name).toBe('Read-only')
  })

  // 选中会跳过审批的档位 = 关掉唯一的控制点(fs/terminal 那两条通道外部 agent 根本不走)。
  // 界面必须能把它们标出来。
  it('flags the modes that skip approvals', () => {
    const risky = describeAcpModes([...CODEX, ...CLAUDE]).filter((m) => m.risky).map((m) => m.id)
    expect(risky).toEqual(['agent-full-access', 'auto', 'bypassPermissions'])
  })

  it('does not flag the ones that still ask', () => {
    const modes = describeAcpModes(CLAUDE)
    expect(modes.find((m) => m.id === 'default')?.risky).toBeUndefined()
    expect(modes.find((m) => m.id === 'plan')?.risky).toBeUndefined()
    // dontAsk 不问但一律拒绝,是收紧不是放开
    expect(modes.find((m) => m.id === 'dontAsk')?.risky).toBeUndefined()
  })

  // 不做「统一成三档」的硬映射:claude 六档会被吃掉一半,新 agent 还得再改表。
  it('passes an unknown agent through instead of dropping it', () => {
    const modes = describeAcpModes([{ id: 'yolo', name: 'YOLO', description: 'anything goes' }])
    expect(modes).toEqual([{ id: 'yolo', name: 'YOLO', description: 'anything goes' }])
    expect(acpModeLabel(modes[0]!)).toBe('YOLO')
  })

  it('falls back to the id when the agent gave no name', () => {
    expect(acpModeLabel({ id: 'weird', name: '' })).toBe('weird')
  })

  it('handles an agent that reports no modes at all', () => {
    expect(describeAcpModes(undefined)).toEqual([])
    expect(describeAcpModes([])).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentMessage, GitDiffSnapshot, Workspace } from '../../../shared/ipc/contract'
import { bashCommandOf, buildMemorySuggestion, latestUserText } from './chat-memory-note'
import type { RunRecord, RunToolRecord } from './chat-types'

const workspace: Workspace = { path: '/w', name: 'demo', lastOpenedAt: '2026-08-30T00:00:00Z' }

function msg(role: string, text: string): AgentMessage {
  return { role, content: [{ type: 'text', text }] } as unknown as AgentMessage
}

function toolRecord(over: Partial<RunToolRecord> = {}): RunToolRecord {
  return { id: 't1', toolName: 'bash', status: 'done', startedAt: '2026-08-30T00:00:00Z', ...over }
}

function run(tools: RunToolRecord[]): RunRecord {
  return {
    id: 'r1',
    startedAt: '2026-08-30T00:00:00Z',
    status: 'done',
    thinking: 'off',
    tools,
    timeline: [],
  }
}

function diff(paths: string[]): GitDiffSnapshot {
  return {
    status: '',
    files: paths.map((path) => ({ path, statusCode: 'M ' })),
    unstagedStat: '',
    unstagedDiff: '',
    stagedStat: '',
    stagedDiff: '',
    truncated: false,
  } as GitDiffSnapshot
}

describe('latestUserText', () => {
  it('取最后一条 user 消息,跳过 assistant', () => {
    expect(latestUserText([msg('user', '第一问'), msg('assistant', '答'), msg('user', '第二问')])).toBe('第二问')
  })

  it('没有 user 消息时是空串', () => {
    expect(latestUserText([msg('assistant', '答')])).toBe('')
    expect(latestUserText([])).toBe('')
  })

  it('长问题会被折成一行并截断', () => {
    expect(latestUserText([msg('user', `a\nb${'x'.repeat(400)}`)])).toContain('...')
  })
})

describe('bashCommandOf', () => {
  it('只认 bash 工具', () => {
    expect(bashCommandOf(toolRecord({ toolName: 'read', args: { command: 'ls' } }))).toBeNull()
  })

  it('args 里没有字符串 command 时返回 null', () => {
    expect(bashCommandOf(toolRecord({ args: { command: 42 } }))).toBeNull()
    expect(bashCommandOf(toolRecord({ args: undefined }))).toBeNull()
    expect(bashCommandOf(toolRecord({ args: 'ls' }))).toBeNull()
  })

  it('拿到命令并折成一行', () => {
    expect(bashCommandOf(toolRecord({ args: { command: 'pnpm  run\n build' } }))).toBe('pnpm run build')
  })
})

describe('buildMemorySuggestion', () => {
  it('四类素材全空时不生成建议', () => {
    expect(buildMemorySuggestion(workspace, [], undefined, null)).toBeNull()
    expect(buildMemorySuggestion(workspace, [msg('assistant', '答')], run([]), diff([]))).toBeNull()
  })

  it('只要有一类素材就生成', () => {
    const note = buildMemorySuggestion(null, [], undefined, diff(['a.ts']))
    expect(note?.content).toContain('- Files changed: a.ts')
    // workspace 为 null 时不写 Workspace 行
    expect(note?.content).not.toContain('- Workspace:')
  })

  it('把任务、结果、改动文件、命令、工具汇成一条', () => {
    const note = buildMemorySuggestion(
      workspace,
      [msg('user', '把构建修好')],
      run([toolRecord({ args: { command: 'pnpm build' } }), toolRecord({ id: 't2', toolName: 'read' })]),
      diff(['a.ts', 'b.ts']),
    )
    expect(note).not.toBeNull()
    expect(note!.content).toContain('- Workspace: demo')
    expect(note!.content).toContain('- Task: 把构建修好')
    expect(note!.content).toContain('- Outcome: 已完成')
    expect(note!.content).toContain('- Files changed: a.ts, b.ts')
    expect(note!.content).toContain('- Commands used: pnpm build')
    expect(note!.content).toContain('- Tools used: bash, read')
    expect(note!.content.startsWith('## Session Note - ')).toBe(true)
  })

  it('重复的文件和命令只留一份', () => {
    const note = buildMemorySuggestion(
      workspace,
      [msg('user', 'x')],
      run([toolRecord({ args: { command: 'ls' } }), toolRecord({ id: 't2', args: { command: 'ls' } })]),
      diff(['a.ts', 'a.ts']),
    )
    expect(note!.content).toContain('- Files changed: a.ts\n')
    expect(note!.content).toContain('- Commands used: ls\n')
  })

  it('id 每次不同,便于当列表 key', () => {
    const a = buildMemorySuggestion(workspace, [msg('user', 'x')], undefined, null)
    const b = buildMemorySuggestion(workspace, [msg('user', 'x')], undefined, null)
    expect(a!.id).not.toBe(b!.id)
  })
})

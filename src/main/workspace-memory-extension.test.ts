import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { EXTENSION_SOURCE } from './workspace-memory'

// 2026-08-23: EXTENSION_SOURCE 少了一个右花括号,pi 加载扩展时 ParseError,
// 于是**整个工作区打不开** —— 界面只报「Failed to start workspace」,
// 得翻到 agent 的 stderr 才看得出是哪一行。这段是模板字符串,TS 编译器不看,
// 只能在这里替它把语法过一遍。
describe('the generated workspace-memory extension', () => {
  it('parses as TypeScript', () => {
    const file = ts.createSourceFile(
      'pi-studio-workspace-memory.ts',
      EXTENSION_SOURCE,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const diagnostics = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    const messages = diagnostics.map((d) => {
      const { line, character } = file.getLineAndCharacterOfPosition(d.start ?? 0)
      return `${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    })
    expect(messages).toEqual([])
  })

  it('registers the memory tools it advertises', () => {
    for (const tool of ['memory_search', 'memory_save', 'memory_list']) {
      expect(EXTENSION_SOURCE).toContain(`name: '${tool}'`)
    }
  })
})

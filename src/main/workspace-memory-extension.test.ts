import { mkdtempSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
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

/**
 * 降级路径整段活在模板字符串里,TS 和 lint 都看不见它。这里把源码转译出来、
 * 顺手导出内部函数,直接对着跑 —— 沙箱用户的共享记忆全靠这条路。
 */
function loadInternals(): {
  snapshotRequest: (
    config: { file?: string },
    method: string,
    pathname: string,
    payload?: Record<string, unknown>,
  ) => { results?: { entry?: { content?: string }; score?: number }[]; entries?: { content?: string }[] }
} {
  const source = EXTENSION_SOURCE + '\nmodule.exports.__internals = { queryTokens, snapshotRequest }\n'
  const { outputText } = ts.transpileModule(source, {
    // esModuleInterop 不开的话 `import fs from 'node:fs'` 会编成 .default(undefined),
    // 读文件静默失败;pi 那边走 jiti,interop 是有的
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  })
  const nodeRequire = createRequire(import.meta.url)
  // pi 自带 typebox 的 alias,pi-studio 的 node_modules 里没有;加载期用不到,给个空壳
  const shim = (id: string): unknown => (id === 'typebox' ? { Type: {} } : nodeRequire(id))
  const module = { exports: {} as Record<string, unknown> }
  new Function('module', 'exports', 'require', outputText)(module, module.exports, shim)
  return module.exports.__internals as ReturnType<typeof loadInternals>
}

function snapshotWith(entries: unknown[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-studio-snapshot-')), 'shared-memory.snapshot.json')
  writeFileSync(file, JSON.stringify({ version: 1, entries }), 'utf8')
  return file
}

describe('the degraded snapshot path', () => {
  const { snapshotRequest } = loadInternals()

  it('finds a Chinese memory by a partial phrase, like the online index does', () => {
    const file = snapshotWith([
      { id: '1', content: '打包命令是 pnpm package:mac', scope: 'global', tags: ['release'] },
      { id: '2', content: '完全无关的另一条', scope: 'global', tags: [] },
    ])
    const result = snapshotRequest({ file }, 'POST', '/v1/search', { query: '怎么打包' })
    expect(result.results?.[0]?.entry?.content).toContain('打包命令')
    expect(result.results).toHaveLength(1)
  })

  it('hides workspace memories that belong to another workspace', () => {
    const file = snapshotWith([
      { id: '1', content: 'mine', scope: 'workspace', workspacePath: '/a', tags: [] },
      { id: '2', content: 'theirs', scope: 'workspace', workspacePath: '/b', tags: [] },
      { id: '3', content: 'everyones', scope: 'global', tags: [] },
    ])
    const listed = snapshotRequest({ file }, 'GET', '/v1/memories?workspacePath=%2Fa')
    expect(listed.entries?.map((entry) => entry.content)).toEqual(['mine', 'everyones'])
  })

  it('matches a Windows workspace path the way the database normalized it', () => {
    // main 存的是 win32.resolve + 小写,PI_STUDIO_MEMORY_WORKSPACE_PATH 是原样 cwd
    const file = snapshotWith([
      { id: '1', content: 'windows entry', scope: 'workspace', workspacePath: 'd:\\works\\pi-studio', tags: [] },
    ])
    const listed = snapshotRequest({ file }, 'GET', '/v1/memories?workspacePath=D%3A%2FWorks%2Fpi-studio')
    expect(listed.entries?.map((entry) => entry.content)).toEqual(['windows entry'])
  })

  it('refuses to write, so the SQLite database keeps a single writer', () => {
    const file = snapshotWith([])
    expect(() => snapshotRequest({ file }, 'POST', '/v1/memories', { content: 'x' })).toThrow(
      /only reads are available/,
    )
    expect(() => snapshotRequest({ file }, 'DELETE', '/v1/memories/1')).toThrow(/only reads are available/)
  })

  it('never writes to disk from the agent process', () => {
    expect(EXTENSION_SOURCE).not.toContain('fs.writeFileSync')
    expect(EXTENSION_SOURCE).not.toContain('fs.mkdirSync')
  })
})

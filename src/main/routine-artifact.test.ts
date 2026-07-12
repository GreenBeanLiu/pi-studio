import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { markdownToWechatHtml, writeRoutineArtifact } from './routine-artifact'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('routine artifacts', () => {
  it('writes markdown inside the workspace and adds an extension', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-studio-routine-'))
    tempDirs.push(workspace)
    const artifact = writeRoutineArtifact(workspace, '.pi-studio/articles/draft', 'markdown', '# Hello')
    expect(artifact.path).toBe(join(workspace, '.pi-studio/articles/draft.md'))
    expect(readFileSync(artifact.path, 'utf8')).toBe('# Hello')
  })

  it('rejects paths outside the workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-studio-routine-'))
    tempDirs.push(workspace)
    expect(() => writeRoutineArtifact(workspace, '../draft.md', 'markdown', 'x')).toThrow(
      '不能离开当前工作区',
    )
  })

  it('converts article markdown to an HTML fragment', () => {
    expect(markdownToWechatHtml('# 标题\n\n- 一项\n- 二项\n\n**重点**')).toContain(
      '<h2>标题</h2>',
    )
    expect(markdownToWechatHtml('# 标题\n\n- 一项\n- 二项\n\n**重点**')).toContain('<ul>')
    expect(markdownToWechatHtml('# 标题\n\n- 一项\n- 二项\n\n**重点**')).toContain('<strong>重点</strong>')
  })
})

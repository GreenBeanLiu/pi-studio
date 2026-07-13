import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRoutineMaterialFolder } from './routine-material-folder'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'pi-studio-materials-'))
  dirs.push(path)
  return path
}

describe('readRoutineMaterialFolder', () => {
  it('returns deterministic text and image assets from a workspace folder', () => {
    const root = workspace()
    mkdirSync(join(root, 'materials', 'nested'), { recursive: true })
    writeFileSync(join(root, 'materials', 'brief.md'), '# Product brief\nUse the customer quote.', 'utf8')
    writeFileSync(join(root, 'materials', 'nested', 'facts.txt'), 'Conversion improved by 18%.', 'utf8')
    writeFileSync(join(root, 'materials', 'cover.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(root, 'materials', 'ignore.bin'), Buffer.from([4]))

    const result = readRoutineMaterialFolder(root, 'materials')

    expect(result.text).toContain('## brief.md\n# Product brief')
    expect(result.text).toContain('## nested/facts.txt\nConversion improved by 18%.')
    expect(result.images).toEqual([
      expect.objectContaining({
        id: 'folder:cover.png',
        name: 'cover.png',
        role: 'cover',
        uri: join(root, 'materials', 'cover.png'),
      }),
    ])
    expect(result.warnings).toContain('Skipped unsupported file: ignore.bin')
  })

  it('rejects a material folder outside the workflow workspace', () => {
    const root = workspace()
    const outside = workspace()
    expect(() => readRoutineMaterialFolder(root, outside)).toThrow('inside the workflow workspace')
  })
})

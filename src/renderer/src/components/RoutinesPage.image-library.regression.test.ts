import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./RoutinesPage.tsx', import.meta.url), 'utf8')

describe('dressup workflow image library regressions', () => {
  it('lets both dressup references select from generated image history', () => {
    expect(page).toContain('api.imageGen.history(100)')
    expect(page).toContain("field: 'personRef', title: '选择人物图'")
    expect(page).toContain("field: 'garmentRef', title: '选择服装图'")
    expect(page).toContain('selectLibraryImage(item.url)')
  })
})

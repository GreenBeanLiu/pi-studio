import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./RoutinesPage.tsx', import.meta.url), 'utf8')
const picker = readFileSync(new URL('./RoutineImageReferencePicker.tsx', import.meta.url), 'utf8')

describe('dressup workflow image library regressions', () => {
  it('lets both dressup references select from generated image history', () => {
    expect(page).toContain('title="选择人物图"')
    expect(page).toContain('title="选择服装图"')
    expect(page).toContain('updateStep(step.id, { personRef })')
    expect(page).toContain('updateStep(step.id, { garmentRef })')
    expect(picker).toContain('api.imageGen.history(100)')
    expect(picker).toContain('onChange(item.url)')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./VideoGenPage.tsx', import.meta.url), 'utf8')
const nav = readFileSync(new URL('./NavRail.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('video generation workspace regressions', () => {
  it('places Kling and 3A Grok in one video workspace', () => {
    expect(page).toContain("type Provider = 'kling' | 'grok'")
    expect(page).toContain("api.dressup.generate")
    expect(page).toContain("api.videoGen.generate")
  })

  it('uses one Video nav item and removes the standalone dressup view', () => {
    expect(nav).toContain('title="视频生成"')
    expect(nav).not.toContain('title="换装视频"')
    expect(app).toContain("activeView === 'video'")
    expect(app).not.toContain("activeView === 'dressup'")
  })
})

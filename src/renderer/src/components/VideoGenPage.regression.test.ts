import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('./VideoGenPage.tsx', import.meta.url), 'utf8')
const nav = readFileSync(new URL('./NavRail.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const mainVideo = readFileSync(new URL('../../../main/video-gen.ts', import.meta.url), 'utf8')
const model3d = readFileSync(new URL('./Model3DPage.tsx', import.meta.url), 'utf8')
const routines = readFileSync(new URL('./RoutinesPage.tsx', import.meta.url), 'utf8')

describe('video generation workspace regressions', () => {
  it('only exposes the working Kling provider', () => {
    expect(page).toContain("api.dressup.generate")
    expect(page).not.toContain('Grok · 3A API')
    expect(page).not.toContain("api.videoGen.generate")
  })

  it('only exposes Tripo for 3D generation', () => {
    expect(model3d).not.toContain("value: 'hi3d'")
    expect(model3d).not.toContain('Hi3D')
    expect(routines).not.toContain("{ value: 'hi3d'")
  })

  it('uses one Video nav item and removes the standalone dressup view', () => {
    expect(nav).toContain('title="视频生成"')
    expect(nav).not.toContain('title="换装视频"')
    expect(app).toContain("activeView === 'video'")
    expect(app).not.toContain("activeView === 'dressup'")
  })

  it('fails mobile Kling jobs after ten minutes', () => {
    expect(mainVideo).toContain('const KLING_TIMEOUT_MS = 10 * 60_000')
    expect(mainVideo).toContain('生成超过 10 分钟，已按失败处理')
  })
})

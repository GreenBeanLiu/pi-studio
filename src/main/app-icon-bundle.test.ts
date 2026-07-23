import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeNativeImage {
  constructor(private readonly size = 1024) {}
  isEmpty(): boolean {
    return false
  }
  getSize(): { width: number; height: number } {
    return { width: this.size, height: this.size }
  }
  toPNG(): Buffer {
    return Buffer.from(`png:${this.size}`)
  }
  toDataURL(): string {
    return `data:image/png;base64,${this.toPNG().toString('base64')}`
  }
  resize(options: { width: number }): FakeNativeImage {
    return new FakeNativeImage(options.width)
  }
}

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => new FakeNativeImage(),
    createFromDataURL: (value: string) => {
      const size = /width%3D%22(\d+)/.exec(value)?.[1]
      return new FakeNativeImage(size ? Number(size) : 1024)
    },
  },
}))

import { generateAppIconBundle } from './app-icon-bundle'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('generateAppIconBundle', () => {
  it('writes a self-describing four-platform engineering bundle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-studio-icons-'))
    dirs.push(workspace)
    writeFileSync(join(workspace, 'master.png'), 'fixture')

    const result = await generateAppIconBundle({
      source: 'master.png',
      workspacePath: workspace,
      outputPath: '.pi-studio/app-icons/focus-flow',
      appName: 'FocusFlow',
      backgroundColor: '#2563EB',
      platforms: ['android', 'ios', 'macos', 'windows'],
    })

    expect(result.fileCount).toBeGreaterThan(60)
    const manifest = JSON.parse(readFileSync(join(result.outputPath, 'manifest.json'), 'utf8')) as {
      appName: string
      platforms: string[]
      files: Array<{ path: string; sha256: string }>
    }
    expect(manifest.appName).toBe('FocusFlow')
    expect(manifest.platforms).toEqual(['android', 'ios', 'macos', 'windows'])
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'android/play-store-icon.png' }),
        expect.objectContaining({ path: 'ios/Assets.xcassets/AppIcon.appiconset/Contents.json' }),
        expect.objectContaining({ path: 'macos/AppIcon.iconset/icon_512x512@2x.png' }),
        expect.objectContaining({ path: 'windows/app.ico' }),
      ]),
    )
    expect(readFileSync(join(result.outputPath, 'windows/app.ico')).readUInt16LE(2)).toBe(1)
  })

  it('rejects output traversal and invalid colors', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-studio-icons-'))
    dirs.push(workspace)
    writeFileSync(join(workspace, 'master.png'), 'fixture')
    const base = {
      source: 'master.png',
      workspacePath: workspace,
      outputPath: '.pi-studio/icons',
      appName: 'App',
      backgroundColor: '#112233',
      platforms: ['windows'] as const,
    }

    await expect(generateAppIconBundle({ ...base, outputPath: '..\\outside' })).rejects.toThrow(/工作区/)
    await expect(generateAppIconBundle({ ...base, backgroundColor: 'blue' })).rejects.toThrow(/#RRGGBB/)
  })
})

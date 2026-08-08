import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeNativeImage {
  private readonly bitmap: Buffer

  constructor(private readonly size = 1024, bitmap?: Buffer) {
    this.bitmap = bitmap ?? FakeNativeImage.fixture(size)
  }

  private static fixture(size: number): Buffer {
    const bitmap = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4
        const background = (Math.floor(x / Math.max(1, size / 16)) + Math.floor(y / Math.max(1, size / 16))) % 2 === 0 ? 252 : 244
        const distance = Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2)
        const ringDistance = Math.abs(distance - size * 0.18)
        const blend = ringDistance <= size * 0.035 ? 1 : 0
        bitmap[offset] = Math.round(background * (1 - blend) + 72 * blend)
        bitmap[offset + 1] = Math.round(background * (1 - blend) + 132 * blend)
        bitmap[offset + 2] = Math.round(background * (1 - blend) + 20 * blend)
        bitmap[offset + 3] = 255
      }
    }
    return bitmap
  }
  isEmpty(): boolean {
    return false
  }
  getSize(): { width: number; height: number } {
    return { width: this.size, height: this.size }
  }
  toPNG(): Buffer {
    return Buffer.concat([
      Buffer.from(`png:${this.size}:`),
      createHash('sha256').update(this.bitmap).digest(),
    ])
  }
  toDataURL(): string {
    return `data:image/png;base64,${this.toPNG().toString('base64')}`
  }
  resize(options: { width: number }): FakeNativeImage {
    const resized = Buffer.alloc(options.width * options.width * 4)
    for (let y = 0; y < options.width; y += 1) {
      for (let x = 0; x < options.width; x += 1) {
        const sourceX = Math.min(this.size - 1, Math.floor((x * this.size) / options.width))
        const sourceY = Math.min(this.size - 1, Math.floor((y * this.size) / options.width))
        const sourceOffset = (sourceY * this.size + sourceX) * 4
        const targetOffset = (y * options.width + x) * 4
        this.bitmap.copy(resized, targetOffset, sourceOffset, sourceOffset + 4)
      }
    }
    return new FakeNativeImage(options.width, resized)
  }
  toBitmap(): Buffer {
    return Buffer.from(this.bitmap)
  }
}

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => new FakeNativeImage(),
    createFromDataURL: (value: string) => {
      const size = /width%3D%22(\d+)/.exec(value)?.[1]
      return new FakeNativeImage(size ? Number(size) : 1024)
    },
    createFromBitmap: (bitmap: Buffer, options: { width: number }) =>
      new FakeNativeImage(options.width, Buffer.from(bitmap)),
  },
}))

import { generateAppIconBundle, prepareAppIconLayers } from './app-icon-bundle'

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
    expect(readFileSync(result.archivePath).readUInt32LE(0)).toBe(0x04034b50)
    const manifest = JSON.parse(readFileSync(join(result.outputPath, 'manifest.json'), 'utf8')) as {
      appName: string
      backgroundColorSource: string
      warnings: string[]
      platforms: string[]
      files: Array<{ path: string; sha256: string }>
    }
    expect(manifest.appName).toBe('FocusFlow')
    expect(manifest.backgroundColorSource).toBe('user-provided')
    expect(manifest.warnings).toContain('baked-checkerboard-background')
    expect(manifest.platforms).toEqual(['android', 'ios', 'macos', 'windows'])
    expect(manifest.files.find((item) => item.path === 'android/play-store-icon.png')).toMatchObject({
      pixelSize: '512x512',
      alpha: 'opaque',
    })
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'android/play-store-icon.png' }),
        expect.objectContaining({ path: 'ios/Assets.xcassets/AppIcon.appiconset/Contents.json' }),
        expect.objectContaining({ path: 'macos/AppIcon.iconset/icon_512x512@2x.png' }),
        expect.objectContaining({ path: 'windows/app.ico' }),
      ]),
    )
    expect(readFileSync(join(result.outputPath, 'windows/app.ico')).readUInt16LE(2)).toBe(1)
    expect(readFileSync(join(result.outputPath, 'source/foreground.png'))).not.toEqual(
      readFileSync(join(result.outputPath, 'source/master.png')),
    )
    expect(readFileSync(join(result.outputPath, 'source/monochrome.png'))).not.toEqual(
      readFileSync(join(result.outputPath, 'source/foreground.png')),
    )
    expect(
      existsSync(
        join(
          result.outputPath,
          'android/app/src/main/res/mipmap-ldpi/ic_launcher_foreground.png',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          result.outputPath,
          'android/app/src/main/res/mipmap-ldpi/ic_launcher_monochrome.png',
        ),
      ),
    ).toBe(true)

    const automatic = await generateAppIconBundle({
      source: 'master.png',
      workspacePath: workspace,
      outputPath: '.pi-studio/app-icons/automatic',
      appName: '',
      backgroundColor: '',
      platforms: ['android'],
    })
    const automaticManifest = JSON.parse(
      readFileSync(join(automatic.outputPath, 'manifest.json'), 'utf8'),
    ) as {
      appName: string | null
      backgroundColor: string
      backgroundColorSource: string
      adaptiveIconMode: string
    }
    expect(automaticManifest.appName).toBeNull()
    expect(automaticManifest.backgroundColor).toMatch(/^#[0-9A-F]{6}$/)
    expect(automaticManifest.backgroundColorSource).toBe('sampled-edge')
    expect(automaticManifest.adaptiveIconMode).toBe('layered')

    // 重跑同一个输出名不能吃掉上一次的结果:之前直接 rmSync 覆盖,想留住上一版
    // 只能每次手动改文件夹名。现在顺延到 focus-flow-2,原包和原 zip 都还在。
    const rebuilt = await generateAppIconBundle({
      source: '.pi-studio/app-icons/focus-flow/source/master.png',
      workspacePath: workspace,
      outputPath: '.pi-studio/app-icons/focus-flow',
      appName: 'FocusFlow',
      backgroundColor: '#2563EB',
      platforms: ['windows'],
    })
    expect(rebuilt.outputPath).toBe(join(workspace, '.pi-studio/app-icons/focus-flow-2'))
    expect(rebuilt.archivePath).toBe(join(workspace, '.pi-studio/app-icons/focus-flow-2.zip'))
    expect(existsSync(join(rebuilt.outputPath, 'android'))).toBe(false)
    expect(existsSync(join(rebuilt.outputPath, 'windows', 'app.ico'))).toBe(true)
    expect(existsSync(join(result.outputPath, 'android'))).toBe(true)
    expect(existsSync(result.archivePath)).toBe(true)

    const third = await generateAppIconBundle({
      source: '.pi-studio/app-icons/focus-flow/source/master.png',
      workspacePath: workspace,
      outputPath: '.pi-studio/app-icons/focus-flow',
      appName: 'FocusFlow',
      backgroundColor: '#2563EB',
      platforms: ['windows'],
    })
    expect(third.outputPath).toBe(join(workspace, '.pi-studio/app-icons/focus-flow-3'))
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
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'keep.txt'), 'keep')
    await expect(generateAppIconBundle({ ...base, outputPath: 'src' })).rejects.toThrow(/\.pi-studio/)
    expect(readFileSync(join(workspace, 'src', 'keep.txt'), 'utf8')).toBe('keep')
  })
})

describe('Android adaptive icon layer preparation', () => {
  it('removes a baked light checkerboard and creates a real monochrome silhouette', () => {
    const size = 32
    const bitmap = Buffer.alloc(size * size * 4)
    const borderColors = new Set<string>()
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4
        const background = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 252 : 244
        const distance = Math.hypot(x - 15.5, y - 15.5)
        const ringDistance = Math.abs(distance - 6)
        const blend = ringDistance <= 1 ? 1 : ringDistance < 2 ? 2 - ringDistance : 0
        const red = Math.round(background * (1 - blend) + 20 * blend)
        const green = Math.round(background * (1 - blend) + 132 * blend)
        const blue = Math.round(background * (1 - blend) + 72 * blend)
        bitmap[offset] = blue
        bitmap[offset + 1] = green
        bitmap[offset + 2] = red
        bitmap[offset + 3] = 255
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
          borderColors.add(`#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`.toUpperCase())
        }
      }
    }

    const prepared = prepareAppIconLayers(bitmap, size)
    let opaque = 0
    let semitransparent = 0
    let minX = size
    let minY = size
    let maxX = -1
    let maxY = -1
    for (let offset = 3; offset < prepared.foregroundBitmap.length; offset += 4) {
      const alpha = prepared.foregroundBitmap[offset]
      if (alpha > 0) {
        const pixel = Math.floor(offset / 4)
        const x = pixel % size
        const y = Math.floor(pixel / size)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      if (alpha === 255) opaque += 1
      if (alpha > 8 && alpha < 250) semitransparent += 1
    }
    const alphaBoundingBoxArea = (maxX - minX + 1) * (maxY - minY + 1)
    const monochromeOpaqueColors = new Set<string>()
    for (let offset = 0; offset < prepared.monochromeBitmap.length; offset += 4) {
      if (prepared.monochromeBitmap[offset + 3] > 240) {
        monochromeOpaqueColors.add(prepared.monochromeBitmap.subarray(offset, offset + 3).toString('hex'))
      }
    }

    expect(semitransparent).toBeGreaterThan(0)
    expect(opaque / alphaBoundingBoxArea).toBeLessThan(0.6)
    expect(prepared.foregroundBitmap).not.toEqual(bitmap)
    expect(prepared.normalizedBitmap).not.toEqual(bitmap)
    expect(prepared.normalizedBitmap[0]).toBe(prepared.normalizedBitmap[16])
    expect(prepared.normalizedBitmap[1]).toBe(prepared.normalizedBitmap[17])
    expect(prepared.normalizedBitmap[2]).toBe(prepared.normalizedBitmap[18])
    expect(prepared.monochromeBitmap).not.toEqual(prepared.foregroundBitmap)
    expect(monochromeOpaqueColors.size).toBeLessThanOrEqual(2)
    expect(prepared.warnings).toContain('baked-checkerboard-background')
    expect(prepared.backgroundColorSource).toBe('sampled-edge')
    expect(borderColors).toContain(prepared.backgroundColor)
    expect(prepared.adaptiveLayers).toBe(true)
  })

  it('preserves a true transparent source and derives a background color', () => {
    const size = 16
    const bitmap = Buffer.alloc(size * size * 4)
    for (let y = 4; y < 12; y += 1) {
      for (let x = 4; x < 12; x += 1) {
        const offset = (y * size + x) * 4
        const alpha = x === 4 || x === 11 || y === 4 || y === 11 ? 128 : 255
        bitmap[offset] = Math.round((40 * alpha) / 255)
        bitmap[offset + 1] = Math.round((180 * alpha) / 255)
        bitmap[offset + 2] = Math.round((30 * alpha) / 255)
        bitmap[offset + 3] = alpha
      }
    }

    const prepared = prepareAppIconLayers(bitmap, size)

    expect(prepared.foregroundBitmap).toEqual(bitmap)
    expect(prepared.normalizedBitmap).toEqual(bitmap)
    expect(prepared.backgroundColorSource).toBe('derived-foreground')
    expect(prepared.adaptiveLayers).toBe(true)
    expect(prepared.warnings).toEqual([])
  })

  it('falls back to legacy-only output when an opaque background cannot be separated', () => {
    const size = 24
    const bitmap = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4
        bitmap[offset] = (x * 73 + y * 19) % 256
        bitmap[offset + 1] = (x * 29 + y * 61) % 256
        bitmap[offset + 2] = (x * 47 + y * 31) % 256
        bitmap[offset + 3] = 255
      }
    }

    const prepared = prepareAppIconLayers(bitmap, size)

    expect(prepared.adaptiveLayers).toBe(false)
    expect(prepared.normalizedBitmap).toEqual(bitmap)
    expect(prepared.warnings).toContain('non-uniform-edge-background')
    expect(prepared.warnings).toContain('adaptive-layers-skipped-low-confidence')
  })
})

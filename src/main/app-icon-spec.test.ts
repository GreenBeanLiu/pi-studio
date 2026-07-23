import { describe, expect, it } from 'vitest'
import {
  ANDROID_ADAPTIVE_SPECS,
  ANDROID_LEGACY_SPECS,
  IOS_ICON_ENTRIES,
  MACOS_ICON_SPECS,
  WINDOWS_ICON_SIZES,
  createPngIco,
  createZipArchive,
  flattenPremultipliedChannel,
  encodeOpaqueRgbPng,
  iosContentsJson,
} from './app-icon-spec'

describe('app icon specifications', () => {
  it('covers the platform-required raster sizes', () => {
    expect(ANDROID_LEGACY_SPECS.map((item) => item.size)).toEqual([36, 48, 72, 96, 144, 192, 512])
    expect(ANDROID_ADAPTIVE_SPECS.map((item) => item.size)).toEqual([108, 162, 216, 324, 432])
    expect(IOS_ICON_ENTRIES.some((item) => item.idiom === 'ios-marketing' && item.pixels === 1024)).toBe(true)
    expect(MACOS_ICON_SPECS.map((item) => item.size)).toContain(1024)
    expect(WINDOWS_ICON_SIZES).toEqual(expect.arrayContaining([16, 24, 32, 48, 256]))
  })

  it('builds an Xcode asset catalog manifest with filenames', () => {
    const contents = JSON.parse(iosContentsJson()) as {
      images: Array<{ filename?: string; idiom: string }>
      info: { author: string; version: number }
    }
    expect(contents.images).toHaveLength(IOS_ICON_ENTRIES.length)
    expect(contents.images.every((item) => item.filename?.endsWith('.png'))).toBe(true)
    expect(contents.info).toEqual({ author: 'pi-studio', version: 1 })
  })

  it('flattens Electron premultiplied bitmap channels without multiplying alpha twice', () => {
    // 50% red is returned by Electron as premultiplied red=128, alpha=128.
    expect(flattenPremultipliedChannel(128, 128, 255)).toBe(255)
    expect(flattenPremultipliedChannel(0, 128, 255)).toBe(127)
  })

  it('encodes Apple-safe RGB PNGs without an alpha channel', () => {
    const png = encodeOpaqueRgbPng(Buffer.from([0, 0, 255, 255]), 1)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1)
    expect(png.readUInt32BE(20)).toBe(1)
    expect(png[25]).toBe(2)
  })
})

describe('PNG-compressed ICO writer', () => {
  it('writes a valid directory and uses zero for a 256px frame', () => {
    const first = Buffer.from([1, 2, 3])
    const second = Buffer.from([4, 5])
    const ico = createPngIco([
      { size: 16, png: first },
      { size: 256, png: second },
    ])

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2)
    expect(ico.readUInt8(6)).toBe(16)
    expect(ico.readUInt8(22)).toBe(0)
    expect(ico.readUInt32LE(14)).toBe(first.length)
    expect(ico.readUInt32LE(30)).toBe(second.length)
    expect(ico.subarray(-2)).toEqual(second)
  })

  it('rejects invalid frame sizes', () => {
    expect(() => createPngIco([{ size: 512, png: Buffer.from([1]) }])).toThrow(/1-256/)
  })
})

describe('ZIP bundle writer', () => {
  it('writes UTF-8 stored entries with a central directory', () => {
    const zip = createZipArchive(
      [
        { path: 'android/icon.png', data: Buffer.from('png') },
        { path: '说明.txt', data: Buffer.from('hello') },
      ],
      new Date(2026, 6, 24, 12, 0, 0),
    )
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.includes(Buffer.from('android/icon.png'))).toBe(true)
    expect(zip.includes(Buffer.from('说明.txt'))).toBe(true)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
    expect(zip.readUInt16LE(zip.length - 12)).toBe(2)
  })
})

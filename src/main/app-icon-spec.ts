import { deflateSync } from 'zlib'

export type AppIconPlatform = 'android' | 'ios' | 'macos' | 'windows'

export type RasterIconSpec = {
  path: string
  size: number
  opaque?: boolean
  stripAlpha?: boolean
}

export const APP_ICON_PLATFORMS: AppIconPlatform[] = [
  'android',
  'ios',
  'macos',
  'windows',
]

export const ANDROID_LEGACY_SPECS: RasterIconSpec[] = [
  { path: 'android/app/src/main/res/mipmap-ldpi/ic_launcher.png', size: 36 },
  { path: 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png', size: 48 },
  { path: 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png', size: 72 },
  { path: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', size: 96 },
  { path: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', size: 144 },
  { path: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', size: 192 },
  { path: 'android/play-store-icon.png', size: 512, opaque: true },
]

export const ANDROID_ADAPTIVE_SPECS: RasterIconSpec[] = [
  { path: 'android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png', size: 108 },
  { path: 'android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png', size: 162 },
  { path: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png', size: 216 },
  { path: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png', size: 324 },
  { path: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', size: 432 },
]

type AppleIconEntry = {
  idiom: 'iphone' | 'ipad' | 'ios-marketing'
  size: string
  scale: '1x' | '2x' | '3x'
  pixels: number
}

export const IOS_ICON_ENTRIES: AppleIconEntry[] = [
  { idiom: 'iphone', size: '20x20', scale: '2x', pixels: 40 },
  { idiom: 'iphone', size: '20x20', scale: '3x', pixels: 60 },
  { idiom: 'iphone', size: '29x29', scale: '2x', pixels: 58 },
  { idiom: 'iphone', size: '29x29', scale: '3x', pixels: 87 },
  { idiom: 'iphone', size: '40x40', scale: '2x', pixels: 80 },
  { idiom: 'iphone', size: '40x40', scale: '3x', pixels: 120 },
  { idiom: 'iphone', size: '60x60', scale: '2x', pixels: 120 },
  { idiom: 'iphone', size: '60x60', scale: '3x', pixels: 180 },
  { idiom: 'ipad', size: '20x20', scale: '1x', pixels: 20 },
  { idiom: 'ipad', size: '20x20', scale: '2x', pixels: 40 },
  { idiom: 'ipad', size: '29x29', scale: '1x', pixels: 29 },
  { idiom: 'ipad', size: '29x29', scale: '2x', pixels: 58 },
  { idiom: 'ipad', size: '40x40', scale: '1x', pixels: 40 },
  { idiom: 'ipad', size: '40x40', scale: '2x', pixels: 80 },
  { idiom: 'ipad', size: '76x76', scale: '1x', pixels: 76 },
  { idiom: 'ipad', size: '76x76', scale: '2x', pixels: 152 },
  { idiom: 'ipad', size: '83.5x83.5', scale: '2x', pixels: 167 },
  { idiom: 'ios-marketing', size: '1024x1024', scale: '1x', pixels: 1024 },
]

export const IOS_ICON_SPECS: RasterIconSpec[] = IOS_ICON_ENTRIES.map((entry) => ({
  path: `ios/Assets.xcassets/AppIcon.appiconset/AppIcon-${entry.idiom}-${entry.size.replaceAll('.', '_')}@${entry.scale}.png`,
  size: entry.pixels,
  opaque: true,
  stripAlpha: true,
}))

export const MACOS_ICON_SPECS: RasterIconSpec[] = [
  { path: 'macos/AppIcon.iconset/icon_16x16.png', size: 16 },
  { path: 'macos/AppIcon.iconset/icon_16x16@2x.png', size: 32 },
  { path: 'macos/AppIcon.iconset/icon_32x32.png', size: 32 },
  { path: 'macos/AppIcon.iconset/icon_32x32@2x.png', size: 64 },
  { path: 'macos/AppIcon.iconset/icon_128x128.png', size: 128 },
  { path: 'macos/AppIcon.iconset/icon_128x128@2x.png', size: 256 },
  { path: 'macos/AppIcon.iconset/icon_256x256.png', size: 256 },
  { path: 'macos/AppIcon.iconset/icon_256x256@2x.png', size: 512 },
  { path: 'macos/AppIcon.iconset/icon_512x512.png', size: 512 },
  { path: 'macos/AppIcon.iconset/icon_512x512@2x.png', size: 1024 },
]

export const WINDOWS_ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256] as const

export const WINDOWS_ICON_SPECS: RasterIconSpec[] = WINDOWS_ICON_SIZES.map((size) => ({
  path: `windows/png/app-${size}.png`,
  size,
}))

/** Electron NativeImage.toBitmap() returns premultiplied BGRA channels. */
export function flattenPremultipliedChannel(
  sourceChannel: number,
  alpha: number,
  backgroundChannel: number,
): number {
  return Math.min(
    255,
    sourceChannel + Math.round((backgroundChannel * (255 - alpha)) / 255),
  )
}

export function iosContentsJson(): string {
  return `${JSON.stringify(
    {
      images: IOS_ICON_ENTRIES.map((entry, index) => ({
        idiom: entry.idiom,
        size: entry.size,
        scale: entry.scale,
        filename: IOS_ICON_SPECS[index].path.split('/').at(-1),
      })),
      info: { author: 'pi-studio', version: 1 },
    },
    null,
    2,
  )}\n`
}

export function createPngIco(frames: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  if (frames.length === 0 || frames.length > 65_535) {
    throw new Error('ICO 至少需要一帧且不能超过 65535 帧')
  }
  for (const frame of frames) {
    if (!Number.isInteger(frame.size) || frame.size < 1 || frame.size > 256 || frame.png.length === 0) {
      throw new Error('ICO 帧必须是 1-256 像素的非空 PNG')
    }
  }

  const headerSize = 6 + frames.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  let offset = headerSize
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry)
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frame.png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frame.png.length
  })

  return Buffer.concat([header, ...frames.map((frame) => frame.png)])
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8)
  return chunk
}

/** Encode an Electron BGRA bitmap as an RGB PNG with no alpha channel (Apple App Store-safe). */
export function encodeOpaqueRgbPng(bitmap: Buffer, size: number): Buffer {
  if (!Number.isInteger(size) || size < 1 || bitmap.length !== size * size * 4) {
    throw new Error('RGB PNG 位图尺寸无效')
  }
  const rows = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (1 + size * 3)
    rows[rowOffset] = 0
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4
      const target = rowOffset + 1 + x * 3
      rows[target] = bitmap[source + 2]
      rows[target + 1] = bitmap[source + 1]
      rows[target + 2] = bitmap[source]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Small dependency-free ZIP writer. App icon assets are already PNG-compressed, so STORE is intentional. */
export function createZipArchive(
  entries: ReadonlyArray<{ path: string; data: Buffer }>,
  timestamp = new Date(),
): Buffer {
  if (entries.length === 0 || entries.length > 65_535) {
    throw new Error('ZIP 至少需要一个文件且不能超过 65535 个文件')
  }
  const year = Math.max(1980, timestamp.getFullYear())
  const dosTime =
    (timestamp.getHours() << 11) |
    (timestamp.getMinutes() << 5) |
    Math.floor(timestamp.getSeconds() / 2)
  const dosDate =
    ((year - 1980) << 9) |
    ((timestamp.getMonth() + 1) << 5) |
    timestamp.getDate()
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const normalized = entry.path.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized || normalized.includes('../')) throw new Error(`ZIP 路径无效: ${entry.path}`)
    const name = Buffer.from(normalized, 'utf8')
    if (name.length > 65_535) throw new Error(`ZIP 文件名过长: ${entry.path}`)
    const checksum = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

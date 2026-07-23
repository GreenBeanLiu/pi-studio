export type AppIconPlatform = 'android' | 'ios' | 'macos' | 'windows'

export type RasterIconSpec = {
  path: string
  size: number
  opaque?: boolean
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

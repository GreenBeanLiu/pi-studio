import { nativeImage, type NativeImage } from 'electron'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, relative, resolve } from 'path'
import { isContainedPath } from '../shared/ipc/validators'
import {
  ANDROID_ADAPTIVE_SPECS,
  ANDROID_LEGACY_SPECS,
  APP_ICON_PLATFORMS,
  IOS_ICON_SPECS,
  MACOS_ICON_SPECS,
  WINDOWS_ICON_SPECS,
  createPngIco,
  createZipArchive,
  flattenPremultipliedChannel,
  encodeOpaqueRgbPng,
  iosContentsJson,
  type AppIconPlatform,
  type RasterIconSpec,
} from './app-icon-spec'

export type AppIconBundleOptions = {
  source: string
  workspacePath: string
  outputPath: string
  appName?: string
  backgroundColor?: string
  platforms: readonly AppIconPlatform[]
  /** 同一个工作流最多保留几次生成;<=0 或不传就一直堆着。 */
  keepHistory?: number
}

export type AppIconBundleResult = {
  outputPath: string
  archivePath: string
  fileCount: number
  platforms: AppIconPlatform[]
  warnings: string[]
  /** 本次按保留上限清掉的历史目录名。 */
  removedHistory: string[]
}

export type PreparedAppIconLayers = {
  normalizedBitmap: Buffer
  foregroundBitmap: Buffer
  monochromeBitmap: Buffer
  backgroundColor: string
  backgroundColorSource: 'user-provided' | 'sampled-edge' | 'derived-foreground' | 'fallback-default'
  warnings: string[]
  adaptiveLayers: boolean
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 256] as const

export function formatAppIconWarning(warning: string): string {
  switch (warning) {
    case 'baked-checkerboard-background':
      return '检测到母图把浅色透明棋盘画进了像素，已压平背景并提取前景；建议上游改用真正的透明 PNG。'
    case 'non-uniform-edge-background':
      return '母图边缘背景不均匀，自动分层可信度较低。'
    case 'adaptive-layers-skipped-low-confidence':
      return '无法可靠提取前景，已跳过 Android adaptive / monochrome 与 Icon Composer 分层，只保留单层图标。'
    default:
      return warning
  }
}

type Rgb = { red: number; green: number; blue: number }

function straightRgb(bitmap: Buffer, offset: number): Rgb {
  const alpha = bitmap[offset + 3]
  if (alpha === 0) return { red: 0, green: 0, blue: 0 }
  const unpremultiply = (channel: number): number =>
    Math.min(255, Math.round((channel * 255) / alpha))
  return {
    red: unpremultiply(bitmap[offset + 2]),
    green: unpremultiply(bitmap[offset + 1]),
    blue: unpremultiply(bitmap[offset]),
  }
}

function rgbHex(color: Rgb): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

function colorDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue)
}

function buildMonochromeBitmap(foreground: Buffer): Buffer {
  const monochrome = Buffer.alloc(foreground.length)
  for (let offset = 0; offset < foreground.length; offset += 4) {
    monochrome[offset + 3] = foreground[offset + 3]
  }
  return monochrome
}

function derivedForegroundBackground(bitmap: Buffer): string {
  const bins = new Map<number, { count: number; red: number; green: number; blue: number }>()
  for (let offset = 0; offset < bitmap.length; offset += 16) {
    if (bitmap[offset + 3] < 32) continue
    const color = straightRgb(bitmap, offset)
    const key = (color.red >> 4) << 8 | (color.green >> 4) << 4 | (color.blue >> 4)
    const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 }
    bin.count += 1
    bin.red += color.red
    bin.green += color.green
    bin.blue += color.blue
    bins.set(key, bin)
  }
  const dominant = [...bins.values()].sort((left, right) => right.count - left.count)[0]
  if (!dominant) return '#202124'
  const average = {
    red: dominant.red / dominant.count,
    green: dominant.green / dominant.count,
    blue: dominant.blue / dominant.count,
  }
  const gray = (average.red + average.green + average.blue) / 3
  return rgbHex({
    red: Math.round((average.red * 0.55 + gray * 0.45) * 0.55),
    green: Math.round((average.green * 0.55 + gray * 0.45) * 0.55),
    blue: Math.round((average.blue * 0.55 + gray * 0.45) * 0.55),
  })
}

export function prepareAppIconLayers(
  bitmap: Buffer,
  size: number,
  requestedBackgroundColor?: string,
): PreparedAppIconLayers {
  if (!Number.isInteger(size) || size < 1 || bitmap.length !== size * size * 4) {
    throw new Error('图标母图位图尺寸无效')
  }

  const requested = requestedBackgroundColor?.trim()
  const sampleStride = Math.max(1, Math.floor(size / 128))
  const borderBand = Math.max(1, Math.floor(size * 0.08))
  const exactColors = new Map<string, { count: number; color: Rgb }>()
  const quantized = new Map<number, { count: number; red: number; green: number; blue: number }>()
  const samples: Array<{ color: Rgb; alpha: number }> = []
  let transparentSamples = 0

  for (let y = 0; y < size; y += sampleStride) {
    for (let x = 0; x < size; x += sampleStride) {
      if (x >= borderBand && x < size - borderBand && y >= borderBand && y < size - borderBand) {
        continue
      }
      const offset = (y * size + x) * 4
      const alpha = bitmap[offset + 3]
      const color = straightRgb(bitmap, offset)
      samples.push({ color, alpha })
      if (alpha < 32) {
        transparentSamples += 1
        continue
      }
      const hex = rgbHex(color)
      const exact = exactColors.get(hex) ?? { count: 0, color }
      exact.count += 1
      exactColors.set(hex, exact)
      const key = (color.red >> 4) << 8 | (color.green >> 4) << 4 | (color.blue >> 4)
      const bin = quantized.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 }
      bin.count += 1
      bin.red += color.red
      bin.green += color.green
      bin.blue += color.blue
      quantized.set(key, bin)
    }
  }

  if (transparentSamples / samples.length >= 0.35) {
    const backgroundColor = requested || derivedForegroundBackground(bitmap)
    let visiblePixels = 0
    for (let offset = 3; offset < bitmap.length; offset += 4) {
      if (bitmap[offset] > 8) visiblePixels += 1
    }
    const adaptiveLayers = visiblePixels > size * size * 0.001 && visiblePixels < size * size * 0.9
    return {
      normalizedBitmap: Buffer.from(bitmap),
      foregroundBitmap: Buffer.from(bitmap),
      monochromeBitmap: buildMonochromeBitmap(bitmap),
      backgroundColor,
      backgroundColorSource: requested ? 'user-provided' : 'derived-foreground',
      warnings: adaptiveLayers ? [] : ['adaptive-layers-skipped-low-confidence'],
      adaptiveLayers,
    }
  }

  const rankedBins = [...quantized.values()].sort((left, right) => right.count - left.count)
  const opaqueSampleCount = rankedBins.reduce((sum, bin) => sum + bin.count, 0)
  const palette: Rgb[] = []
  let paletteCount = 0
  for (const bin of rankedBins.slice(0, 8)) {
    palette.push({
      red: bin.red / bin.count,
      green: bin.green / bin.count,
      blue: bin.blue / bin.count,
    })
    paletteCount += bin.count
    if (paletteCount / opaqueSampleCount >= 0.92) break
  }
  if (palette.length === 0) palette.push({ red: 255, green: 255, blue: 255 })

  const luminances = samples
    .filter((sample) => sample.alpha >= 32)
    .map((sample) => (sample.color.red + sample.color.green + sample.color.blue) / 3)
  const minLuminance = Math.min(...luminances)
  const maxLuminance = Math.max(...luminances)
  const averageLuminance = luminances.reduce((sum, value) => sum + value, 0) / luminances.length
  const luminanceDeviation = Math.sqrt(
    luminances.reduce((sum, value) => sum + (value - averageLuminance) ** 2, 0) /
      luminances.length,
  )
  const bakedCheckerboard =
    minLuminance >= 220 &&
    maxLuminance - minLuminance >= 4 &&
    maxLuminance - minLuminance <= 45 &&
    luminanceDeviation >= 1.5 &&
    exactColors.size >= 2
  const sampleDistances = samples
    .filter((sample) => sample.alpha >= 32)
    .map((sample) => Math.min(...palette.map((color) => colorDistance(sample.color, color))))
    .sort((left, right) => left - right)
  const backgroundRadius = sampleDistances[Math.floor(sampleDistances.length * 0.98)] ?? 0
  const paletteCoverage =
    samples.filter(
      (sample) =>
        sample.alpha < 32 ||
        Math.min(...palette.map((color) => colorDistance(sample.color, color))) <= 28,
    ).length / samples.length
  const warnings: string[] = []
  if (bakedCheckerboard) warnings.push('baked-checkerboard-background')
  if (paletteCoverage < 0.8) warnings.push('non-uniform-edge-background')

  const sampledBackground = [...exactColors.values()].sort(
    (left, right) => right.count - left.count,
  )[0]?.color ?? palette[0]
  const foreground = Buffer.from(bitmap)
  const visited = new Uint8Array(size * size)
  const queue = new Int32Array(size * size)
  let queueStart = 0
  let queueEnd = 0
  const transparentThreshold = bakedCheckerboard
    ? Math.max(12, Math.min(32, Math.ceil(backgroundRadius) + 2))
    : 9
  const opaqueThreshold = transparentThreshold + (bakedCheckerboard ? 93 : 73)
  const distanceAt = (index: number): number => {
    if (bitmap[index * 4 + 3] < 32) return 0
    const color = straightRgb(bitmap, index * 4)
    return Math.min(...palette.map((candidate) => colorDistance(color, candidate)))
  }
  const enqueue = (index: number): void => {
    if (visited[index] || distanceAt(index) > opaqueThreshold) return
    visited[index] = 1
    queue[queueEnd] = index
    queueEnd += 1
  }
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    enqueue(coordinate)
    enqueue((size - 1) * size + coordinate)
    enqueue(coordinate * size)
    enqueue(coordinate * size + size - 1)
  }
  while (queueStart < queueEnd) {
    const index = queue[queueStart]
    queueStart += 1
    const x = index % size
    const y = Math.floor(index / size)
    if (x > 0) enqueue(index - 1)
    if (x + 1 < size) enqueue(index + 1)
    if (y > 0) enqueue(index - size)
    if (y + 1 < size) enqueue(index + size)
  }

  for (let index = 0; index < visited.length; index += 1) {
    const offset = index * 4
    const originalAlpha = bitmap[offset + 3]
    const distance = distanceAt(index)
    if (!visited[index] && distance > transparentThreshold) continue
    const extractedAlpha = Math.max(
      0,
      Math.min(
        255,
        Math.round(
          ((distance - transparentThreshold) / (opaqueThreshold - transparentThreshold)) * 255,
        ),
      ),
    )
    const alpha = Math.round((originalAlpha * extractedAlpha) / 255)
    const color = straightRgb(bitmap, offset)
    foreground[offset] = Math.round((color.blue * alpha) / 255)
    foreground[offset + 1] = Math.round((color.green * alpha) / 255)
    foreground[offset + 2] = Math.round((color.red * alpha) / 255)
    foreground[offset + 3] = alpha
  }

  let visiblePixels = 0
  for (let offset = 3; offset < foreground.length; offset += 4) {
    if (foreground[offset] > 8) visiblePixels += 1
  }
  const adaptiveLayers =
    paletteCoverage >= 0.8 &&
    visiblePixels > size * size * 0.001 &&
    visiblePixels < size * size * 0.9
  if (!adaptiveLayers) warnings.push('adaptive-layers-skipped-low-confidence')

  const backgroundColor = requested || rgbHex(sampledBackground)
  const background = rgbColor(backgroundColor)
  const normalized = adaptiveLayers ? Buffer.alloc(bitmap.length) : Buffer.from(bitmap)
  if (adaptiveLayers) {
    for (let offset = 0; offset < foreground.length; offset += 4) {
      const alpha = foreground[offset + 3]
      normalized[offset] = flattenPremultipliedChannel(foreground[offset], alpha, background.blue)
      normalized[offset + 1] = flattenPremultipliedChannel(
        foreground[offset + 1],
        alpha,
        background.green,
      )
      normalized[offset + 2] = flattenPremultipliedChannel(
        foreground[offset + 2],
        alpha,
        background.red,
      )
      normalized[offset + 3] = 255
    }
  }

  return {
    normalizedBitmap: normalized,
    foregroundBitmap: foreground,
    monochromeBitmap: buildMonochromeBitmap(foreground),
    backgroundColor,
    backgroundColorSource: requested ? 'user-provided' : 'sampled-edge',
    warnings,
    adaptiveLayers,
  }
}

function rgbColor(value: string): { red: number; green: number; blue: number } {
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  }
}

function writeBuffer(root: string, relativePath: string, value: Buffer): void {
  const target = resolve(root, relativePath)
  if (!isContainedPath(target, root)) throw new Error(`图标输出路径越界: ${relativePath}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}

function writeText(root: string, relativePath: string, value: string): void {
  writeBuffer(root, relativePath, Buffer.from(value, 'utf8'))
}

function createBitmapImage(
  source: NativeImage,
  size: number,
  ratio = 1,
  backgroundColor?: string,
): NativeImage {
  const bitmap = Buffer.alloc(size * size * 4)
  if (backgroundColor) {
    const { red, green, blue } = rgbColor(backgroundColor)
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      // Electron/Chromium NativeImage bitmaps use BGRA byte order.
      bitmap[offset] = blue
      bitmap[offset + 1] = green
      bitmap[offset + 2] = red
      bitmap[offset + 3] = 255
    }
  }

  const rendered = Math.round(size * ratio)
  if (rendered > 0) {
    const foreground = source
      .resize({ width: rendered, height: rendered, quality: 'best' })
      .toBitmap()
    const start = Math.floor((size - rendered) / 2)
    for (let y = 0; y < rendered; y += 1) {
      for (let x = 0; x < rendered; x += 1) {
        const sourceOffset = (y * rendered + x) * 4
        const targetOffset = ((start + y) * size + start + x) * 4
        const alpha = foreground[sourceOffset + 3]
        if (!backgroundColor) {
          foreground.copy(bitmap, targetOffset, sourceOffset, sourceOffset + 4)
          continue
        }
        bitmap[targetOffset] = flattenPremultipliedChannel(
          foreground[sourceOffset],
          alpha,
          bitmap[targetOffset],
        )
        bitmap[targetOffset + 1] = flattenPremultipliedChannel(
          foreground[sourceOffset + 1],
          alpha,
          bitmap[targetOffset + 1],
        )
        bitmap[targetOffset + 2] = flattenPremultipliedChannel(
          foreground[sourceOffset + 2],
          alpha,
          bitmap[targetOffset + 2],
        )
        bitmap[targetOffset + 3] = 255
      }
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  })
  if (image.isEmpty()) throw new Error(`无法合成 ${size}×${size} 图标`)
  return image
}

function rasterize(
  source: NativeImage,
  size: number,
  options: {
    opaque?: boolean
    stripAlpha?: boolean
    safeArea?: boolean
    backgroundColor: string
  },
): Buffer {
  const ratio = options.safeArea ? 66 / 108 : 1
  if (options.opaque || options.safeArea) {
    const image = createBitmapImage(
      source,
      size,
      ratio,
      options.opaque ? options.backgroundColor : undefined,
    )
    return options.stripAlpha
      ? encodeOpaqueRgbPng(image.toBitmap(), size)
      : image.toPNG()
  }
  return source.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

async function loadSource(source: string, workspacePath: string): Promise<NativeImage> {
  let image: NativeImage
  if (/^data:image\//i.test(source)) {
    image = nativeImage.createFromDataURL(source)
  } else if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(90_000) })
    if (!response.ok) throw new Error(`下载图标母图失败 HTTP ${response.status}`)
    image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  } else {
    const target = isAbsolute(source) ? resolve(source) : resolve(workspacePath, source)
    if (!isContainedPath(target, workspacePath)) throw new Error('图标母图必须位于工作区内')
    if (!existsSync(target)) throw new Error(`找不到图标母图: ${target}`)
    const realWorkspace = realpathSync.native(workspacePath)
    const realTarget = realpathSync.native(target)
    if (!isContainedPath(realTarget, realWorkspace)) throw new Error('图标母图不能通过链接跳出工作区')
    image = nativeImage.createFromBuffer(readFileSync(target))
  }

  if (image.isEmpty()) throw new Error('图标母图不是可读取的 PNG/JPEG/WebP 图片')
  const { width, height } = image.getSize()
  if (width !== height) throw new Error(`图标母图必须是正方形，当前为 ${width}×${height}`)
  if (width < 1024) throw new Error(`图标母图至少需要 1024×1024，当前为 ${width}×${height}`)
  return width === 1024
    ? image
    : image.resize({ width: 1024, height: 1024, quality: 'best' })
}

function writeRasterSpecs(
  root: string,
  source: NativeImage,
  specs: RasterIconSpec[],
  backgroundColor: string,
): void {
  for (const spec of specs) {
    writeBuffer(
      root,
      spec.path,
      rasterize(source, spec.size, {
        opaque: spec.opaque,
        stripAlpha: spec.stripAlpha,
        backgroundColor,
      }),
    )
  }
}

function writeAndroid(
  root: string,
  source: NativeImage,
  foregroundSource: NativeImage | undefined,
  monochromeSource: NativeImage | undefined,
  backgroundColor: string,
): void {
  writeRasterSpecs(root, source, ANDROID_LEGACY_SPECS, backgroundColor)
  if (!foregroundSource || !monochromeSource) {
    writeText(
      root,
      'android/README.md',
      '# Android\n\n母图背景无法可靠分离，本包只生成 legacy launcher 图标和 Google Play 图；未生成可能错误的 adaptive foreground / monochrome 图层。请提供真正透明背景的母图后重试。\n',
    )
    return
  }
  for (const spec of ANDROID_ADAPTIVE_SPECS) {
    const foreground = rasterize(foregroundSource, spec.size, {
      safeArea: true,
      backgroundColor,
    })
    const monochrome = rasterize(monochromeSource, spec.size, {
      safeArea: true,
      backgroundColor,
    })
    writeBuffer(root, spec.path, foreground)
    writeBuffer(root, spec.path.replace('foreground', 'monochrome'), monochrome)
  }
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`
  writeText(root, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', adaptiveXml)
  writeText(root, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml', adaptiveXml)
  writeText(
    root,
    'android/app/src/main/res/values/colors.xml',
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${backgroundColor}</color>\n</resources>\n`,
  )
  writeText(
    root,
    'android/README.md',
    '# Android\n\n复制 `app/src/main/res` 到 Android 工程，并在 Manifest 中使用 `@mipmap/ic_launcher`。`play-store-icon.png` 用于 Google Play，不要放进 APK。\n',
  )
}

function writeIos(root: string, source: NativeImage, backgroundColor: string): void {
  writeRasterSpecs(root, source, IOS_ICON_SPECS, backgroundColor)
  writeText(
    root,
    'ios/Assets.xcassets/AppIcon.appiconset/Contents.json',
    iosContentsJson(),
  )
  writeText(
    root,
    'ios/README.md',
    '# iOS / iPadOS\n\n把 `AppIcon.appiconset` 复制到 Xcode 的 `Assets.xcassets`。所有商店与设备图标都已铺底为不透明 PNG，系统会自动应用圆角，请勿再次烘焙圆角。\n',
  )
}

function writeMacos(
  root: string,
  source: NativeImage,
  foregroundSource: NativeImage | undefined,
  monochromeSource: NativeImage | undefined,
  backgroundColor: string,
): void {
  writeRasterSpecs(root, source, MACOS_ICON_SPECS, backgroundColor)
  if (!foregroundSource || !monochromeSource) {
    writeText(
      root,
      'macos/README.md',
      '# macOS\n\n已生成兼容的 AppIcon.iconset。母图背景无法可靠分离，因此没有生成可能错误的 Icon Composer 分层素材；请提供真正透明背景的母图后重试。\n',
    )
    return
  }
  writeBuffer(
    root,
    'macos/IconComposer/background.png',
    createBitmapImage(source, 1024, 0, backgroundColor).toPNG(),
  )
  writeBuffer(root, 'macos/IconComposer/foreground.png', foregroundSource.toPNG())
  writeBuffer(
    root,
    'macos/IconComposer/monochrome.png',
    createBitmapImage(monochromeSource, 1024, 66 / 108).toPNG(),
  )
  writeText(
    root,
    'macos/IconComposer/manifest.json',
    `${JSON.stringify(
      {
        version: 1,
        canvas: '1024x1024',
        layers: ['background.png', 'foreground.png', 'monochrome.png'],
        note: '在 macOS 上将这些图层导入 Apple Icon Composer；pi-studio 不伪造 .icon 工程文件。',
      },
      null,
      2,
    )}\n`,
  )
  writeText(
    root,
    'macos/README.md',
    '# macOS\n\n兼容方式：在 Mac 终端运行 `iconutil -c icns AppIcon.iconset` 生成 `AppIcon.icns`。现代 Xcode 可把 `IconComposer` 中的图层导入 Apple Icon Composer 后保存为 `.icon`。\n',
  )
}

function writeWindows(root: string, source: NativeImage, backgroundColor: string): void {
  writeRasterSpecs(root, source, WINDOWS_ICON_SPECS, backgroundColor)
  const frames = WINDOWS_ICO_SIZES.map((size) => ({
    size,
    png: rasterize(source, size, { backgroundColor }),
  }))
  writeBuffer(root, 'windows/app.ico', createPngIco(frames))
  writeText(
    root,
    'windows/README.md',
    '# Windows\n\nWin32、Electron 和 electron-builder 可直接使用 `app.ico`。`png` 目录同时包含 Windows 11 常用目标尺寸，便于在浅色/深色背景下逐尺寸检查。\n',
  )
}

function listFiles(root: string, current = root): string[] {
  return readdirSync(current)
    .flatMap((name) => {
      const target = resolve(current, name)
      return statSync(target).isDirectory() ? listFiles(root, target) : [relative(root, target).replaceAll('\\', '/')]
    })
    .sort()
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function nearestExistingParent(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function assertSafeOutputRoot(workspacePath: string, outputRoot: string): void {
  const realWorkspace = realpathSync.native(workspacePath)
  if (resolve(outputRoot) === resolve(workspacePath)) throw new Error('图标输出目录不能是工作区根目录')
  if (!isContainedPath(outputRoot, workspacePath)) throw new Error('图标输出目录必须位于工作区内')
  const existingParent = nearestExistingParent(outputRoot)
  const realParent = realpathSync.native(existingParent)
  if (!isContainedPath(realParent, realWorkspace)) throw new Error('图标输出目录不能通过链接跳出工作区')
  if (existsSync(outputRoot)) {
    if (lstatSync(outputRoot).isSymbolicLink()) throw new Error('图标输出目录不能是符号链接或 junction')
    const realOutput = realpathSync.native(outputRoot)
    if (!isContainedPath(realOutput, realWorkspace)) throw new Error('图标输出目录不能通过链接跳出工作区')
  }
}

function assertOwnedOutputRoot(workspacePath: string, outputRoot: string): void {
  const ownedRoot = resolve(workspacePath, '.pi-studio', 'app-icons')
  if (resolve(outputRoot) === ownedRoot || !isContainedPath(outputRoot, ownedRoot)) {
    throw new Error('图标输出目录必须位于工作区 .pi-studio/app-icons/ 的独立子目录内')
  }
  assertSafeOutputRoot(workspacePath, outputRoot)
}

/**
 * 同名目录直接覆盖会把上一次生成的整包连同 .zip 一起删掉 —— 想留住上一版结果,
 * 用户只能每跑一次就手动改一次文件夹名。目录或 .zip 已被占用就顺延一个序号,
 * 两者都空着才用这个名字。
 */
function availableOutputRoot(outputRoot: string): string {
  const taken = (candidate: string): boolean =>
    existsSync(candidate) || existsSync(`${candidate}.zip`)
  if (!taken(outputRoot)) return outputRoot
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${outputRoot}-${index}`
    if (!taken(candidate)) return candidate
  }
  throw new Error('同名图标输出目录过多，请先清理 .pi-studio/app-icons/')
}

/**
 * 同一个工作流的历次生成:去掉结尾的时间戳和重名序号,剩下的就是"家族名"。
 * `icons-20260808-083000` 和 `icons-20260808-091500-2` 同属 `icons`,
 * 而 `other-app-20260808-083000` 不会被算进来 —— 不能拿别的工作流的产物去凑数。
 */
const HISTORY_SUFFIX = /(?:-(?:\d{8}-\d{6}|\d+))+$/

function historyFamilyOf(name: string): string {
  return name.replace(HISTORY_SUFFIX, '')
}

/** 只认自己写出来的包:manifest 对不上就绝不删,免得误伤用户手放进去的目录。 */
function bundleCreatedAt(dir: string): number | null {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as {
      generator?: unknown
      createdAt?: unknown
    }
    if (manifest.generator !== 'pi-studio') return null
    const createdAt = typeof manifest.createdAt === 'string' ? Date.parse(manifest.createdAt) : NaN
    return Number.isNaN(createdAt) ? statSync(dir).mtimeMs : createdAt
  } catch {
    return null
  }
}

/**
 * 按保留上限清理同一家族的历史生成。时间戳目录会一直堆下去,而这些包不小
 * (四个平台六十多个文件),留个上限才不至于把工作区撑爆。
 */
function pruneIconHistory(workspacePath: string, outputRoot: string, keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return []
  const parent = dirname(outputRoot)
  const family = historyFamilyOf(basename(outputRoot))
  const bundles = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && historyFamilyOf(entry.name) === family)
    .map((entry) => resolve(parent, entry.name))
    .filter((dir) => isContainedPath(dir, resolve(workspacePath, '.pi-studio', 'app-icons')))
    .map((dir) => ({ dir, createdAt: bundleCreatedAt(dir) }))
    .filter((item): item is { dir: string; createdAt: number } => item.createdAt !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
  const removed: string[] = []
  for (const stale of bundles.slice(keep)) {
    rmSync(stale.dir, { recursive: true, force: true })
    rmSync(`${stale.dir}.zip`, { force: true })
    removed.push(basename(stale.dir))
  }
  return removed
}

function replaceArchiveSafely(workspacePath: string, archivePath: string, data: Buffer): void {
  const ownedRoot = resolve(workspacePath, '.pi-studio', 'app-icons')
  if (!isContainedPath(archivePath, ownedRoot)) throw new Error('图标 ZIP 路径必须位于工作区图标目录内')
  const realWorkspace = realpathSync.native(workspacePath)
  const realParent = realpathSync.native(nearestExistingParent(dirname(archivePath)))
  if (!isContainedPath(realParent, realWorkspace)) throw new Error('图标 ZIP 路径不能通过链接跳出工作区')
  if (existsSync(archivePath)) {
    const existing = lstatSync(archivePath)
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('图标 ZIP 路径必须是普通文件')
  }
  const temporary = `${archivePath}.tmp-${randomUUID()}`
  writeFileSync(temporary, data)
  if (existsSync(archivePath)) rmSync(archivePath, { force: true })
  renameSync(temporary, archivePath)
}

function rasterMetadata(path: string): {
  pixelSize?: string
  colorSpace?: 'sRGB'
  alpha?: 'opaque' | 'preserved'
} {
  const allSpecs = [
    ...ANDROID_LEGACY_SPECS,
    ...ANDROID_ADAPTIVE_SPECS,
    ...ANDROID_ADAPTIVE_SPECS.map((spec) => ({
      ...spec,
      path: spec.path.replace('foreground', 'monochrome'),
    })),
    ...IOS_ICON_SPECS,
    ...MACOS_ICON_SPECS,
    ...WINDOWS_ICON_SPECS,
  ]
  const sourceSize =
    path.startsWith('source/') || path.startsWith('macos/IconComposer/') ? 1024 : undefined
  const spec = allSpecs.find((item) => item.path === path)
  const size = spec?.size ?? sourceSize
  if (!size || !path.endsWith('.png')) return {}
  return {
    pixelSize: `${size}x${size}`,
    colorSpace: 'sRGB',
    alpha: spec?.opaque || path.endsWith('background.png') ? 'opaque' : 'preserved',
  }
}

export async function generateAppIconBundle(
  options: AppIconBundleOptions,
): Promise<AppIconBundleResult> {
  const requestedBackgroundColor = options.backgroundColor?.trim() ?? ''
  if (requestedBackgroundColor && !HEX_COLOR.test(requestedBackgroundColor)) {
    throw new Error('图标背景色必须是 #RRGGBB')
  }
  const platforms = [...new Set(options.platforms)].filter((item): item is AppIconPlatform =>
    APP_ICON_PLATFORMS.includes(item),
  )
  if (platforms.length === 0) throw new Error('至少选择一个图标平台')

  const requestedRoot = resolve(options.workspacePath, options.outputPath)
  assertOwnedOutputRoot(options.workspacePath, requestedRoot)
  const outputRoot = availableOutputRoot(requestedRoot)
  assertOwnedOutputRoot(options.workspacePath, outputRoot)
  const inputSource = await loadSource(options.source.trim(), options.workspacePath)
  const prepared = prepareAppIconLayers(
    inputSource.toBitmap(),
    1024,
    requestedBackgroundColor || undefined,
  )
  const backgroundColor = prepared.backgroundColor
  const source = nativeImage.createFromBitmap(prepared.normalizedBitmap, {
    width: 1024,
    height: 1024,
    scaleFactor: 1,
  })
  const preparedForeground = nativeImage.createFromBitmap(prepared.foregroundBitmap, {
    width: 1024,
    height: 1024,
    scaleFactor: 1,
  })
  const preparedMonochrome = nativeImage.createFromBitmap(prepared.monochromeBitmap, {
    width: 1024,
    height: 1024,
    scaleFactor: 1,
  })
  if (source.isEmpty() || preparedForeground.isEmpty() || preparedMonochrome.isEmpty()) {
    throw new Error('无法创建规范化图标图层')
  }
  const foregroundSource = prepared.adaptiveLayers ? preparedForeground : undefined
  const monochromeSource = prepared.adaptiveLayers ? preparedMonochrome : undefined
  const stagingRoot = `${outputRoot}.staging-${randomUUID()}`
  const archivePath = `${outputRoot}.zip`
  let staged = true
  try {
    mkdirSync(stagingRoot, { recursive: true })
    writeBuffer(stagingRoot, 'source/master.png', source.toPNG())
    writeBuffer(
      stagingRoot,
      'source/background.png',
      createBitmapImage(source, 1024, 0, backgroundColor).toPNG(),
    )
    if (foregroundSource && monochromeSource) {
      writeBuffer(stagingRoot, 'source/foreground.png', foregroundSource.toPNG())
      writeBuffer(stagingRoot, 'source/monochrome.png', monochromeSource.toPNG())
    }

    if (platforms.includes('android')) {
      writeAndroid(stagingRoot, source, foregroundSource, monochromeSource, backgroundColor)
    }
    if (platforms.includes('ios')) writeIos(stagingRoot, source, backgroundColor)
    if (platforms.includes('macos')) {
      writeMacos(stagingRoot, source, foregroundSource, monochromeSource, backgroundColor)
    }
    if (platforms.includes('windows')) writeWindows(stagingRoot, source, backgroundColor)

    writeText(
      stagingRoot,
      'README.md',
      `# ${options.appName?.trim() || '应用'}图标资源包\n\n由 pi-studio 应用图标工作流生成。母图没有预先烘焙系统圆角；请在真机、小尺寸、浅色和深色背景下检查后再发布。${prepared.warnings.length ? `\n\n## 检测警告\n${prepared.warnings.map((warning) => `- ${formatAppIconWarning(warning)}`).join('\n')}\n` : '\n'}`,
    )
    const filesBeforeManifest = listFiles(stagingRoot)
    const manifest = {
      schemaVersion: 1,
      generator: 'pi-studio',
      appName: options.appName?.trim() || null,
      createdAt: new Date().toISOString(),
      source: { path: 'source/master.png', size: 1024 },
      backgroundColor,
      backgroundColorSource: prepared.backgroundColorSource,
      adaptiveIconMode: prepared.adaptiveLayers ? 'layered' : 'legacy-only',
      warnings: prepared.warnings,
      platforms,
      files: filesBeforeManifest.map((path) => ({
        path,
        sha256: fileSha256(resolve(stagingRoot, path)),
        ...rasterMetadata(path),
      })),
    }
    writeText(stagingRoot, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    const archiveFiles = listFiles(stagingRoot)
    const archive = createZipArchive(
      archiveFiles.map((path) => ({
        path,
        data: readFileSync(resolve(stagingRoot, path)),
      })),
    )

    // outputRoot 已由 availableOutputRoot 挑成空位,这里不再删任何既有产物。
    renameSync(stagingRoot, outputRoot)
    staged = false
    replaceArchiveSafely(options.workspacePath, archivePath, archive)
  } finally {
    if (staged && existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true })
  }

  // 清理放在产物落地之后:先保住这一次,再回头删旧的,中途失败也不会两头空。
  const removedHistory = pruneIconHistory(
    options.workspacePath,
    outputRoot,
    options.keepHistory ?? 0,
  )

  return {
    outputPath: outputRoot,
    archivePath,
    fileCount: listFiles(outputRoot).length,
    platforms,
    warnings: prepared.warnings,
    removedHistory,
  }
}

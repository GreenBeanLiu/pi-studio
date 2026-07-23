import { nativeImage, type NativeImage } from 'electron'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createHash } from 'crypto'
import { dirname, isAbsolute, relative, resolve } from 'path'
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
  iosContentsJson,
  type AppIconPlatform,
  type RasterIconSpec,
} from './app-icon-spec'

export type AppIconBundleOptions = {
  source: string
  workspacePath: string
  outputPath: string
  appName: string
  backgroundColor: string
  platforms: readonly AppIconPlatform[]
}

export type AppIconBundleResult = {
  outputPath: string
  archivePath: string
  fileCount: number
  platforms: AppIconPlatform[]
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 256] as const

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
        const inverse = 255 - alpha
        bitmap[targetOffset] = Math.round(
          (foreground[sourceOffset] * alpha + bitmap[targetOffset] * inverse) / 255,
        )
        bitmap[targetOffset + 1] = Math.round(
          (foreground[sourceOffset + 1] * alpha + bitmap[targetOffset + 1] * inverse) / 255,
        )
        bitmap[targetOffset + 2] = Math.round(
          (foreground[sourceOffset + 2] * alpha + bitmap[targetOffset + 2] * inverse) / 255,
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
  options: { opaque?: boolean; safeArea?: boolean; backgroundColor: string },
): Buffer {
  const ratio = options.safeArea ? 66 / 108 : 1
  if (options.opaque || options.safeArea) {
    return createBitmapImage(
      source,
      size,
      ratio,
      options.opaque ? options.backgroundColor : undefined,
    ).toPNG()
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
      rasterize(source, spec.size, { opaque: spec.opaque, backgroundColor }),
    )
  }
}

function writeAndroid(root: string, source: NativeImage, backgroundColor: string): void {
  writeRasterSpecs(root, source, ANDROID_LEGACY_SPECS, backgroundColor)
  for (const spec of ANDROID_ADAPTIVE_SPECS) {
    const foreground = rasterize(source, spec.size, {
      safeArea: true,
      backgroundColor,
    })
    writeBuffer(root, spec.path, foreground)
    writeBuffer(root, spec.path.replace('foreground', 'monochrome'), foreground)
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

function writeMacos(root: string, source: NativeImage, backgroundColor: string): void {
  writeRasterSpecs(root, source, MACOS_ICON_SPECS, backgroundColor)
  writeBuffer(
    root,
    'macos/IconComposer/background.png',
    createBitmapImage(source, 1024, 0, backgroundColor).toPNG(),
  )
  writeBuffer(root, 'macos/IconComposer/foreground.png', source.toPNG())
  writeBuffer(
    root,
    'macos/IconComposer/monochrome.png',
    createBitmapImage(source, 1024, 66 / 108).toPNG(),
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
  const backgroundColor = options.backgroundColor.trim()
  if (!HEX_COLOR.test(backgroundColor)) throw new Error('图标背景色必须是 #RRGGBB')
  const platforms = [...new Set(options.platforms)].filter((item): item is AppIconPlatform =>
    APP_ICON_PLATFORMS.includes(item),
  )
  if (platforms.length === 0) throw new Error('至少选择一个图标平台')

  const outputRoot = resolve(options.workspacePath, options.outputPath)
  assertSafeOutputRoot(options.workspacePath, outputRoot)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  const source = await loadSource(options.source.trim(), options.workspacePath)
  writeBuffer(outputRoot, 'source/master.png', source.toPNG())
  writeBuffer(
    outputRoot,
    'source/background.png',
    createBitmapImage(source, 1024, 0, backgroundColor).toPNG(),
  )
  writeBuffer(outputRoot, 'source/foreground.png', source.toPNG())
  writeBuffer(
    outputRoot,
    'source/monochrome.png',
    createBitmapImage(source, 1024, 66 / 108).toPNG(),
  )

  if (platforms.includes('android')) writeAndroid(outputRoot, source, backgroundColor)
  if (platforms.includes('ios')) writeIos(outputRoot, source, backgroundColor)
  if (platforms.includes('macos')) writeMacos(outputRoot, source, backgroundColor)
  if (platforms.includes('windows')) writeWindows(outputRoot, source, backgroundColor)

  writeText(
    outputRoot,
    'README.md',
    `# ${options.appName.trim() || 'App'} 图标资源包\n\n由 pi-studio 应用图标工作流生成。母图没有预先烘焙系统圆角；请在真机、小尺寸、浅色和深色背景下检查后再发布。\n`,
  )
  const filesBeforeManifest = listFiles(outputRoot)
  const manifest = {
    schemaVersion: 1,
    generator: 'pi-studio',
    appName: options.appName.trim() || 'App',
    createdAt: new Date().toISOString(),
    source: { path: 'source/master.png', size: 1024 },
    backgroundColor,
    platforms,
    files: filesBeforeManifest.map((path) => ({
      path,
      sha256: fileSha256(resolve(outputRoot, path)),
      ...rasterMetadata(path),
    })),
  }
  writeText(outputRoot, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const archivePath = `${outputRoot}.zip`
  if (!isContainedPath(archivePath, options.workspacePath)) throw new Error('图标 ZIP 路径必须位于工作区内')
  const archiveFiles = listFiles(outputRoot)
  writeFileSync(
    archivePath,
    createZipArchive(
      archiveFiles.map((path) => ({
        path,
        data: readFileSync(resolve(outputRoot, path)),
      })),
    ),
  )

  return {
    outputPath: outputRoot,
    archivePath,
    fileCount: listFiles(outputRoot).length,
    platforms,
  }
}

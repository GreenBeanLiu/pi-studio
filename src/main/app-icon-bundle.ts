import { nativeImage, type NativeImage } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  fileCount: number
  platforms: AppIconPlatform[]
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 256] as const

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
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

function createSvgImage(source: NativeImage, size: number, ratio = 1, backgroundColor?: string): NativeImage {
  const sourceData = source.toDataURL()
  const rendered = size * ratio
  const offset = (size - rendered) / 2
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    backgroundColor ? `<rect width="${size}" height="${size}" fill="${xmlEscape(backgroundColor)}"/>` : '',
    `<image href="${xmlEscape(sourceData)}" x="${offset}" y="${offset}" width="${rendered}" height="${rendered}"/>`,
    '</svg>',
  ].join('')
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  )
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
    return createSvgImage(
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
    image = nativeImage.createFromBuffer(readFileSync(target))
  }

  if (image.isEmpty()) throw new Error('图标母图不是可读取的 PNG/JPEG/WebP 图片')
  const { width, height } = image.getSize()
  if (width !== height) throw new Error(`图标母图必须是正方形，当前为 ${width}×${height}`)
  if (width < 1024) throw new Error(`图标母图至少需要 1024×1024，当前为 ${width}×${height}`)
  return image
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
    createSvgImage(source, 1024, 0, backgroundColor).toPNG(),
  )
  writeBuffer(root, 'macos/IconComposer/foreground.png', source.toPNG())
  writeBuffer(
    root,
    'macos/IconComposer/monochrome.png',
    createSvgImage(source, 1024, 66 / 108).toPNG(),
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
  if (!isContainedPath(outputRoot, options.workspacePath)) throw new Error('图标输出目录必须位于工作区内')
  mkdirSync(outputRoot, { recursive: true })

  const source = await loadSource(options.source.trim(), options.workspacePath)
  writeBuffer(outputRoot, 'source/master.png', source.toPNG())
  writeBuffer(
    outputRoot,
    'source/background.png',
    createSvgImage(source, 1024, 0, backgroundColor).toPNG(),
  )
  writeBuffer(outputRoot, 'source/foreground.png', source.toPNG())
  writeBuffer(
    outputRoot,
    'source/monochrome.png',
    createSvgImage(source, 1024, 66 / 108).toPNG(),
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
    })),
  }
  writeText(outputRoot, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    outputPath: outputRoot,
    fileCount: listFiles(outputRoot).length,
    platforms,
  }
}

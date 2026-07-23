# App Icon 工作流研究

更新日期：2026-07-24

## 结论

pi-studio 不应把“生成 Icon”实现成一个固定尺寸的生图按钮，而应实现为：

1. 先生成或导入一张高分辨率母稿，并从最多四个候选中选定一个方案。
2. 将母稿规范化为可复用的 `背景层 + 前景层 + 单色层`。
3. 预览系统裁切、浅色/深色背景和小尺寸效果。
4. 按平台导出可直接放入工程的目录包，而不只是若干散落的 PNG。

这是必要的，因为 Android 需要自适应分层图标，Apple 当前推荐分层的 Icon Composer，同时仍支持 Asset Catalog；Win32/Electron 主要使用包含多个尺寸的 ICO，而 MSIX/Microsoft Store 又有另一套命名资产。

## 建议的工作流界面

### 1. 设计输入

- 文本生成、上传图片、图片加文字修改三种输入方式。
- 生成阶段固定使用正方形高清母稿，至少 1024×1024；内部保留无损母稿。
- 一次生成 1–4 个候选，候选处于同一批次并排显示，用户选择一个进入“平台适配”。
- 可选输入：品牌色、应用名称、功能关键词、是否偏扁平、是否需要透明外轮廓。

### 2. 图层适配

- 背景层：颜色或完整方形图，默认不透明。
- 前景层：透明 PNG 或 SVG，支持缩放和视觉居中。
- 单色层：一个清晰的单色轮廓，用于 Android 主题图标及 Apple Mono 预览。
- 自动建议分层后允许用户手动调整；不能把 AI 自动抠图结果当作最终层而不预览。

### 3. 预览与检查

- Android：圆形、圆角方形、squircle、方形遮罩；显示 66/108 安全区。
- Apple：iOS、iPadOS、macOS 的默认、深色、Mono/着色预览；显示系统圆角遮罩，但不把圆角烘焙进原图。
- Windows：16、24、32、48、256 像素实际尺寸预览，并同时放在浅色、深色任务栏背景上检查。
- 通用检查：主体越界、透明像素、非正方形、低分辨率、小尺寸糊成一团、文本过细、对比度不足。

### 4. 输出参数

- 平台：Android、iOS/iPadOS、macOS、Windows，可多选。
- 包类型：
  - Android Studio 工程包 / Google Play 商店图。
  - Apple Asset Catalog / Apple Icon Composer 素材包 / macOS iconset。
  - Windows Win32/Electron ICO / Windows MSIX 资产包。
- 文件名/资源名、背景色、是否附带源图层、是否生成 README。
- 导出为一个 ZIP；ZIP 根目录写入 `manifest.json`，记录母稿、裁切、颜色、各输出文件尺寸和哈希，便于重复构建。

## Android 输出规范

### 自适应 Launcher Icon

Android 自适应图标的彩色版本必须有前景层和背景层；单色层用于主题图标。所有层的设计画布为 108×108 dp，永不被设备遮罩裁掉的安全区为居中的 66×66 dp，主体应在 48×48 到 66×66 dp 之间；四边各 18 dp 为裁切和动态效果预留。层本身不要带外轮廓遮罩或外围阴影。Android 13 开始使用开发者提供的 `monochrome` 层进行主题着色；当前 Android 文档还说明 Android 16 QPR 2 可对未提供单色层的应用自动着色，但主动提供仍能保证品牌轮廓。[Android Adaptive Icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)

建议生成：

```text
android/
  app/src/main/res/
    mipmap-anydpi-v26/
      ic_launcher.xml
      ic_launcher_round.xml
    drawable/
      ic_launcher_background.xml
      ic_launcher_foreground.xml
      ic_launcher_monochrome.xml
    mipmap-ldpi/ic_launcher.png          # 36×36 legacy
    mipmap-mdpi/ic_launcher.png          # 48×48 legacy
    mipmap-hdpi/ic_launcher.png          # 72×72 legacy
    mipmap-xhdpi/ic_launcher.png         # 96×96 legacy
    mipmap-xxhdpi/ic_launcher.png        # 144×144 legacy
    mipmap-xxxhdpi/ic_launcher.png       # 192×192 legacy
  play-store-icon.png                    # 512×512
  README.md
```

- 优先把前景、背景和单色层输出为 VectorDrawable；无法向量化时，再按密度生成 PNG。
- 自适应 XML 放在 `mipmap-anydpi-v26`，包含 `<background>`、`<foreground>` 和 `<monochrome>`；Manifest 使用 `@mipmap/ic_launcher`。Android 官方同时建议 app icon 放在 `mipmap` 而不是 `drawable`，并给出了 legacy bitmap 的 36/48/72/96/144/192 像素密度序列。[Android density resources](https://developer.android.com/training/multiscreen/screendensities) [Android Studio Image Asset Studio](https://developer.android.com/studio/write/create-app-icons)

### Google Play 商店图

商店图与 APK 内的 Launcher Icon 是两个不同资产。Google Play 要求 512×512、32-bit PNG、sRGB、最大 1024 KB。提交原图应为完整方形，不要预先添加圆角和外部投影，Google Play 会动态应用遮罩和阴影；品牌背景最好不透明，否则透明区域会露出 Play 界面的背景色。[Google Play icon specification](https://developer.android.com/distribute/google-play/resources/icon-design-specifications)

## iOS 与 iPadOS 输出规范

Apple 当前允许 Xcode 从一张 1024×1024 高分辨率图自动生成 iOS/iPadOS 的尺寸变体，也允许在 Asset Catalog 中逐个提供图像；iOS/iPadOS 还支持默认、深色和着色外观。[Xcode asset catalog app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon/) Apple HIG 当前将 iOS、iPadOS 和 macOS 的设计画布列为 1024×1024，并说明系统会缩放出设置、通知等场景的小图标。[Apple App Icons HIG](https://developer.apple.com/design/human-interface-guidelines/app-icons/)

默认输出一个可直接复制进 Xcode 的：

```text
apple/
  Assets.xcassets/
    AppIcon.appiconset/
      AppIcon-1024.png
      Contents.json
  preview/
    AppIcon-dark.png
    AppIcon-mono.png
  README.md
```

为兼容需要“All Sizes”的项目，可以提供高级选项并生成以下像素图：

- iPhone：40、60、58、87、80、120、120、180。
- iPad：20、40、29、58、40、80、76、152、167。
- App Store：1024。

这些数值分别覆盖通知 20pt、设置 29pt、Spotlight 40pt、iPhone 主图标 60pt、iPad 主图标 76pt、iPad Pro 83.5pt 及各自 Retina 倍率。Asset Catalog 是 Apple 推荐的管理方式。[Apple App Icon asset type](https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/AppIconType.html) [Apple QA1686](https://developer.apple.com/library/archive/qa/qa1686/_index.html)

透明与裁切要求：

- 不要在源图上预先画系统圆角；iOS 会自动添加遮罩。
- 普通图标 PNG 即便含 alpha 通道，也不应有透明区域；1024×1024 App Store 大图应输出为完全不透明且移除 alpha 通道的 PNG，避免 App Store 校验失败。[Apple QA1686](https://developer.apple.com/library/archive/qa/qa1686/_index.html)
- Apple 文档同时要求 Asset Catalog 的深色外观图可使用透明背景，以露出系统背景；因此工作流必须把“App Store opaque flatten”与“深色/分层设计素材”当成不同导出目标，不能对所有 Apple 文件统一移除 alpha。[Xcode asset catalog app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon/)

## macOS 输出规范

### 当前推荐：Icon Composer 素材包

Apple 的 Icon Composer 使用一个多层文件支持 iPhone、iPad、Mac 和 Apple Watch，并可为 Default、Dark、Mono 外观分别标注。导入源图支持 SVG 或 PNG；当前 Apple 页面标明 Icon Composer 需要 macOS Tahoe 26.4 或更高版本，最新版 Xcode 会优先使用 Icon Composer 文件而不是旧 `AppIcon` Asset Catalog。[Icon Composer](https://developer.apple.com/icon-composer/) [Create an icon with Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)

由于 `.icon` 是 Apple 工具管理的多层工程文件，Windows 上的 pi-studio 不应伪造它。应输出可导入 Icon Composer 的素材：

```text
apple/IconComposer/
  background.png             # 1024×1024
  foreground.svg             # 或透明 1024×1024 PNG
  monochrome.svg
  dark-background.png        # 可选
  manifest.json
  README.md
```

用户在 Mac 上导入这些图层，再由 Icon Composer 保存 `.icon` 并在 Xcode/真机中验证 Liquid Glass、Dark 和 Mono 效果。

### 兼容导出：`.iconset` / `.icns`

完整 macOS iconset 应生成十张 PNG：

```text
macos/AppIcon.iconset/
  icon_16x16.png
  icon_16x16@2x.png           # 32
  icon_32x32.png
  icon_32x32@2x.png           # 64
  icon_128x128.png
  icon_128x128@2x.png         # 256
  icon_256x256.png
  icon_256x256@2x.png         # 512
  icon_512x512.png
  icon_512x512@2x.png         # 1024
```

这是 Apple 官方 `.iconset` 目录及命名规范。[Apple Icon Set format](https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/IconSetType.html) pi-studio 可在所有平台生成 `.iconset`；`.icns` 最稳妥的方式是在 macOS 上再运行 `iconutil -c icns AppIcon.iconset`。如果应用内置了经过验证的跨平台 ICNS 编码器，也可以额外直接输出 `AppIcon.icns`，但仍应保留 `.iconset` 作为可审计源文件。

## Windows 输出规范

### Win32 / Electron 默认包

微软指出 Windows 会优先寻找精确尺寸，找不到时才缩小下一档；最低应有 16、24、32、48、256 像素，并建议透明背景。Win32 应把多个尺寸封装到一个 ICO 中。[Microsoft Windows app icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)

建议默认生成：

```text
windows/
  app.ico                      # 多帧 32-bit ICO
  png/
    app-16.png
    app-20.png
    app-24.png
    app-30.png
    app-32.png
    app-36.png
    app-40.png
    app-48.png
    app-60.png
    app-64.png
    app-72.png
    app-80.png
    app-96.png
    app-256.png
  README.md
```

其中 ICO 至少包含 16/24/32/48/256，完整模式包含上面的全部尺寸。32-bit 图像保留 alpha；256×256 帧可使用 PNG 压缩。微软 Win32 指南也将传统应用完整集描述为 16、32、48、256，并要求 `.ico`。[Microsoft Win32 icon guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-icons)

### MSIX / Microsoft Store 高级包

如果用户选择 MSIX/Microsoft Store，另生成 `AppList.targetsize-{16,20,24,30,32,36,40,48,60,64,72,80,96,256}.png`，并提供对应的 `altform-unplated` 与 `altform-lightunplated` 变体。微软说明缺少 unplated 资产时，任务栏或开始菜单图标可能缩小并出现系统底板。Windows 11 已不使用磁贴，但 Microsoft Store 当前仍至少要求 100% 的 Medium tile；StoreLogo 的 scale 资产也是发布所需。[Microsoft Windows app icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)

因此 UI 中应把“Windows ICO（普通桌面应用）”作为默认，把“MSIX/Store 全资产”作为高级开关，避免每次都产生几十个无用文件。

## 建议的最终 ZIP

```text
my-app-icons/
  source/
    master.png
    background.png
    foreground.png
    monochrome.png
  android/...
  apple/...
  macos/...
  windows/...
  previews/
    android-masks.png
    apple-appearances.png
    windows-small-sizes.png
  manifest.json
  README.md
```

`manifest.json` 至少应记录：

- 工作流版本与生成模型。
- 批次 ID、被选中的候选图 ID。
- 母稿提示词和输入图引用。
- 背景色、前景缩放/偏移、安全区。
- 每个平台的导出预设版本。
- 每个文件的路径、像素尺寸、颜色空间、alpha 状态和 SHA-256。

## 实现边界

- 第一版可以可靠完成：候选生成、前景抠图与手动微调、平台遮罩预览、PNG/ICO/Android XML/Apple `Contents.json`/ZIP 导出。
- 第一版不应承诺自动生成最终 `.icon`；它应输出 Icon Composer 可导入的图层素材。
- `.icns` 可先输出 `.iconset`，在 macOS 上编译；跨平台直接编码要单独做格式回归测试。
- 自动向量化是增强项。位图前景可以先满足平台规范，但 Mono 层应允许用户修正，否则复杂彩图简单灰度化会在主题图标中失真。
- 所有尺寸必须从无损母稿独立缩放并在目标尺寸重新锐化，不能逐级从上一张小图继续缩放。


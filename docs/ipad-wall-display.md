# 墙上 iPad 晨读闹钟 + 信息看板（MorningWall）实现规格

> 本文是一份**可直接照着实现的需求与设计文档**,交付对象是负责编码的工程师或 LLM。
> 目标产物是一个**独立的 iPadOS 原生 App**,与 pi-studio 主工程无代码依赖,单独建 Xcode 工程。

---

## 0. 一句话目标

把一台闲置 iPad 挂在墙上,做成**长期常亮的家庭信息终端**,核心能力是:

> 每天早上按时唤醒,以渐强音量**按课程顺序**播放新概念英语,自动记住播到第几课;
> 平时则全屏显示时钟、天气、日程和学习进度。

---

## 1. 关键设计前提(务必先理解,它决定了整个架构)

iOS 开发最大的枷锁是「App 切到后台就被系统冻结」,常规闹钟类 App 必须绕着 `UNNotification` 和后台模式做设计。**但本场景不适用该约束**:

> **设备永久插电 + 屏幕常亮 + 锁定在本 App 内 = App 永远处于前台活跃态。**

因此本项目**可以且应该**直接使用前台 `Timer` 做调度、直接持有 `AVQueuePlayer` 播放、直接操作屏幕亮度。不要为了「后台可靠性」引入复杂的后台任务架构,那是过度设计。

本地通知(`UNUserNotificationCenter`)仅作为**崩溃兜底**存在,不承担主调度职责。

---

## 2. 技术栈与环境

| 项 | 选型 | 说明 |
|---|---|---|
| UI | SwiftUI | 单窗口全屏看板 |
| 最低系统 | iPadOS 17.0 | ⚠️ 见 §11 待确认项,若实机系统更低需下调并替换若干 API |
| 音频 | AVFoundation(`AVQueuePlayer`) | 需播放列表与无缝续播 |
| 天气 | WeatherKit | 开发者账号含 50 万次/月免费额度 |
| 日历 | EventKit | 读取日程 |
| 相册 | PhotoKit | 可选,照片轮播 |
| 持久化 | JSON 文件 + `UserDefaults` | 数据量极小,不需要引入数据库 |
| 依赖管理 | 无第三方依赖 | 全部使用系统框架 |

**必须在 Apple Developer 后台为 App ID 开启的 Capability:** WeatherKit。

**Info.plist 必填项:**

| Key | 用途 |
|---|---|
| `UIBackgroundModes` = `[audio]` | 意外切后台时音频不中断 |
| `UIFileSharingEnabled` = `YES` | 允许通过「文件」App / Finder 直接拖入音频 |
| `LSSupportsOpeningDocumentsInPlace` = `YES` | 同上 |
| `UISupportedInterfaceOrientations` | 仅保留横屏(按实际安装方向) |
| `NSCalendarsFullAccessUsageDescription` | 读取日程 |
| `NSPhotoLibraryUsageDescription` | 照片轮播(可选功能) |
| `NSLocationWhenInUseUsageDescription` | 天气定位(建议改为手动配置坐标,见 §7.6) |

---

## 3. 功能需求

### 3.1 MVP(第一阶段必须完成)

| 编号 | 功能 | 验收要点 |
|---|---|---|
| M1 | 全屏常亮看板 | 屏幕永不自动息屏,重启 App 后依然生效 |
| M2 | 定时闹钟 | 到达设定时刻自动开始播放,误差 ≤ 2 秒 |
| M3 | 音量渐强 | 从静音在设定时长内平滑爬升至目标音量 |
| M4 | 课程顺序播放 | 按册 → 课号排序,播完自动推进到下一课 |
| M5 | 进度持久化 | 断电重启后仍记得播到第几课、播到多少秒 |
| M6 | 亮度曲线 | 夜间自动变暗,白天恢复,过渡平滑无跳变 |
| M7 | 设置页 | 可配置闹钟时间、目标音量、渐强时长、亮度参数 |

### 3.2 第二阶段(MVP 跑通一周后再做)

- 天气显示与语音播报
- 今日日程显示
- 照片轮播背景
- 跟读模式(播一句停 N 秒)
- A-B 段落循环

**实现顺序建议:严格先完成 3.1 全部,再开始 3.2。** 不要并行。

---

## 4. 架构与模块划分

```
MorningWallApp (@main)
└── RootView
    ├── DashboardView        ← 常态看板
    ├── PlayerBarView        ← 播放中的底部条
    └── SettingsView         ← 长按齿轮进入

AppState (ObservableObject, 单一数据源)
├── LessonLibrary        音频扫描 / 编号解析 / 排序
├── PlaybackEngine       AVQueuePlayer 封装 / 渐强 / 进度回写
├── AlarmScheduler       前台轮询调度
├── BrightnessController 亮度曲线
├── KeepAwakeManager     防息屏
├── PersistenceStore     JSON 读写
├── WeatherService       (阶段二)
└── SpeechService        (阶段二)
```

各模块之间**只通过 `AppState` 通信**,不要互相直接持有引用。`PlaybackEngine` 不应知道 `AlarmScheduler` 的存在。

---

## 5. 数据模型

```swift
/// 单课音频
struct Lesson: Identifiable, Codable, Hashable {
    let id: String              // 稳定标识,用沙盒内相对路径,不要用 UUID(重启后要能对上)
    let bookNumber: Int         // 第几册,解析失败时为 0
    let index: Int              // 册内序号,解析失败时为 Int.max
    let title: String           // 展示名,默认取文件名(去扩展名)
    let relativePath: String    // 相对 Documents 的路径
    let duration: TimeInterval  // 由 AVAsset 异步读取后缓存
}

/// 播放进度(需持久化)
struct PlaybackProgress: Codable {
    var currentLessonID: String?
    var positionInLesson: TimeInterval = 0
    var completedLessonIDs: Set<String> = []
    var lastCompletedAt: Date?          // 用于判断「今天是否已完成」
}

/// 闹钟配置(需持久化)
struct AlarmConfig: Codable {
    var enabled: Bool = true
    var hour: Int = 7
    var minute: Int = 0
    var weekdays: Set<Int> = [1,2,3,4,5,6,7]   // 1=周日,遵循 Calendar 约定
    var fadeInDuration: TimeInterval = 180      // 渐强时长(秒)
    var targetVolume: Float = 0.9               // AVPlayer 音量上限 0...1
    var lessonsPerSession: Int = 1              // 每次播几课
    var autoAdvance: Bool = true                // 播完是否推进
}

/// 亮度配置(需持久化)
struct BrightnessConfig: Codable {
    var enabled: Bool = true
    var dayBrightness: Double = 0.75
    var nightBrightness: Double = 0.04
    var dayStartHour: Int = 6
    var nightStartHour: Int = 22
    var transitionMinutes: Double = 30          // 渐变时长
}
```

**持久化位置:** `FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)` 下的 `state.json`。
**写入时机:** 配置变更时立即写;播放进度**每 5 秒**写一次 + 每次暂停/切课时写。墙上设备可能被直接断电,不能只在退出时写。

---

## 6. 音频文件的导入方式

**采用「零代码导入」方案:** Info.plist 开启 `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` 后,用户可通过 iPad 上的「文件」App(或 Mac 的 Finder 连线)**直接把整个音频文件夹拖进 App 的 Documents 目录**。

App 启动时扫描 `Documents/` 下所有 `.mp3 / .m4a / .aac / .wav`,构建 `Lesson` 列表。

> 不要实现 `UIDocumentPickerViewController` 导入流程。用户是在一台墙上设备操作,文件管理走 Finder 拖拽比在触屏上点文件选择器体验好得多,且省一大块代码。

### 6.1 课程编号解析规则

按优先级依次尝试:

1. 从**父文件夹名**提取册号:匹配 `(?:Book|第|NCE)\s*([1-4一二三四])` → 归一化为 1-4
2. 从**文件名**提取课号:匹配 `[Ll](?:esson)?\s*0*(\d{1,3})`
3. 若 2 失败,退化为匹配文件名中第一个连续数字串
4. 若 3 仍失败,`index = Int.max`,并按文件名做**自然排序**兜底

⚠️ **自然排序必须用 `localizedStandardCompare`**,不要用默认的字符串比较,否则 `L10` 会排在 `L2` 前面:

```swift
files.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
```

最终排序键:`(bookNumber, index, 自然排序文件名)`。

---

## 7. 关键实现要点与坑

### 7.1 防息屏

```swift
UIApplication.shared.isIdleTimerDisabled = true
```

⚠️ 这个标志在某些场景(如从后台恢复、系统内存告警)会被重置。**必须在 `scenePhase` 变为 `.active` 时重新设置一次**,不能只在 `App.init()` 里设一次。

### 7.2 音频会话

播放前必须激活会话,否则静音开关拨到静音时不会出声:

```swift
try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
try AVAudioSession.sharedInstance().setActive(true)
```

`.playback` 类别的作用是**忽略静音开关**——这对闹钟是必需的。

### 7.3 音量渐强(重点,容易做错)

⚠️ **iOS 不允许 App 用代码修改系统音量。** `MPVolumeView` 那套 hack 早已失效,不要尝试。

正确做法:**只调 `AVPlayer.volume`(0...1),系统音量由用户在安装时手动设好一次。** 设置页里要有一行提示文案告知用户这一点。

渐强用 `Timer` 每 100ms 插值。**不要用线性插值**——人耳对响度的感知接近对数,线性会导致「前面听不见,后面突然很吵」:

```swift
// t: 0...1 的进度
let progress = elapsed / config.fadeInDuration
player.volume = config.targetVolume * Float(pow(progress, 2.5))
```

指数 2.5 是经验值,实测可在 2.0–3.0 间调。

### 7.4 闹钟调度(重点)

**不要用「设一个 8 小时后触发的 `Timer`」**。长间隔 Timer 会因系统时钟校正、休眠、时区变更产生显著漂移。

正确做法是**轮询式**:每 1 秒触发一次的 `Timer`,每次计算「当前时刻是否已越过今日目标时刻,且今日尚未触发过」:

```swift
// 伪代码
func tick() {
    guard config.enabled, config.weekdays.contains(todayWeekday) else { return }
    let target = todayAt(hour: config.hour, minute: config.minute)
    if Date() >= target, lastFiredDate.map({ !Calendar.current.isDateInToday($0) }) ?? true {
        lastFiredDate = Date()
        startMorningRoutine()
    }
}
```

`lastFiredDate` 需持久化,防止 App 在闹钟时间后重启导致重复触发。

**兜底通知:** 同时注册 `UNCalendarNotificationTrigger` 重复通知。自定义提示音文件需 < 30 秒,放入 bundle。这条通知**仅在 App 崩溃时起作用**,正常情况下用户会同时听到通知音和 App 播放——因此 `startMorningRoutine()` 执行时应主动调用 `removeAllDeliveredNotifications()` 清掉。

### 7.5 亮度控制

⚠️ `UIScreen.main` 在 iOS 16+ 已废弃,应通过 scene 获取:

```swift
guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
scene.screen.brightness = value   // 0.0 ... 1.0
```

亮度变更同样要**渐变**,直接赋值会有肉眼可见的突跳。在 `transitionMinutes` 窗口内用 Timer 插值(这里用线性即可)。

注意:用户手动调整控制中心亮度后会覆盖 App 设置,这是预期行为,不要跟用户抢——检测到外部变更时,等到下一个过渡窗口再接管。

### 7.6 天气(阶段二)

墙上设备位置固定不动。**建议在设置页提供手动输入城市/坐标的方式,不申请定位权限**——可以省掉权限弹窗、避免定位漂移,也少一个隐私声明。

```swift
let weather = try await WeatherService.shared.weather(for: CLLocation(latitude: lat, longitude: lon))
```

### 7.7 日历(阶段二)

iOS 17 起旧的 `requestAccess(to:)` 已废弃:

```swift
try await eventStore.requestFullAccessToEvents()
```

### 7.8 烧屏防护

多数 iPad 是 LCD,风险低;但 iPad Pro(M4)是 OLED。建议实现**像素偏移**:每 3 分钟将整个 UI 容器整体位移 ±2pt,用户不可察觉,但可有效避免长期静态元素残影。

```swift
.offset(x: shiftX, y: shiftY)   // 每 180s 在 [-2, 2] 内随机取值,带 2s 动画过渡
```

---

## 8. UI 规格

横屏布局,**深色底为主**(墙上设备夜间不刺眼)。

```
┌────────────────────────────────────────────────┐
│                              ┌───────────────┐ │
│                              │  天气区(阶段二)│ │
│      07:23                   └───────────────┘ │
│      ───────                 ┌───────────────┐ │
│      周一 3月10日             │  今日日程     │ │
│                              │ (阶段二)      │ │
│                              └───────────────┘ │
├────────────────────────────────────────────────┤
│  新概念第二册  47/96  ▓▓▓▓▓▓▓░░░░░░░   ✓今日已完成 ⚙│
└────────────────────────────────────────────────┘
```

**样式约定:**

| 元素 | 规格 |
|---|---|
| 时钟数字 | `.system(size: 180, weight: .thin, design: .rounded)`,纯白 |
| 日期 | 32pt,`.secondary` 灰 |
| 底部进度条 | 高 6pt,圆角,已完成部分用强调色 |
| 背景 | 纯黑或极深灰(`#0A0A0C`),不要用渐变(OLED 省电 + 夜间友好) |

**播放中**:底部条替换为播放器,显示 `当前课名 + 剩余时间 + 暂停 + 下一课` 三个大按钮(触控目标 ≥ 60×60pt,墙上是站着盲按)。

**设置入口**:右下角齿轮图标,**长按 2 秒**才进入(防止家人误触)。

---

## 9. 设备侧配置(交付时需一并说明给用户)

这部分不是代码,但属于交付物的一部分,需写进 README:

1. **单 App 模式优于引导式访问。** 用 Mac 上的 Apple Configurator(免费)把 iPad 设为**监督模式**,再开启**单 App 模式**。区别在于:引导式访问在设备重启后会退出,单 App 模式重启后会自动回到本 App。墙上设备偶尔断电重启,这一条能省掉很多次手动干预。
2. **系统音量需手动设定一次**(见 §7.3),建议设到 70–80%。
3. **关闭自动锁定** 作为双保险:设置 → 显示与亮度 → 自动锁定 → 永不。
4. **电池保护**:长期满电插电会导致电池鼓包。打开「优化电池充电」,或用智能插座定时断电,让电量在 40–80% 间循环。

---

## 10. 验收清单

实现完成后逐条验证:

- [ ] 连续运行 24 小时不息屏、不崩溃
- [ ] 到达闹钟时间自动播放,误差 ≤ 2 秒
- [ ] 音量从听不见平滑爬升,全程无突跳
- [ ] 一课播完自动接下一课,不重复不跳课
- [ ] 播放中途强制杀掉 App 并重启 → 进度停留在断点附近(误差 ≤ 5 秒)
- [ ] 设备断电重启 → 进度不丢失
- [ ] 闹钟时间之后才启动 App → **不会**立即补触发一次
- [ ] 跨天后 `lastFiredDate` 正确重置,次日正常触发
- [ ] 夜间亮度自动降低,过渡无肉眼可见跳变
- [ ] 静音开关拨到静音状态下,闹钟依然出声
- [ ] 文件名 `L2` 与 `L10` 排序正确(L2 在前)

---

## 11. 待确认项(实现前需向需求方确认)

以下两项目前**未确定**,文档已按标注的默认假设撰写:

| 项 | 当前假设 | 若不符需调整 |
|---|---|---|
| iPad 型号与系统版本 | iPadOS 17+ | 低于 17 需替换 EventKit 权限 API;低于 16 需改回 `UIScreen.main` |
| 新概念音频形式 | 本地 mp3/m4a 文件,可拖入 Documents | 若为播客订阅,需改用 `AVPlayer` 播放远程 URL,并重做进度模型 |

在确认前,**建议先按假设实现 MVP**——这两项都不影响 §4 的架构划分,后续替换成本很低。

---

## 12. 给实现者的提醒

- **不要引入第三方依赖。** 全部能力系统框架都有,加依赖只会让签名和长期维护变麻烦。
- **不要做后台任务架构。** 见 §1,这是本项目最容易被过度设计的地方。
- **不要试图用代码改系统音量。** 见 §7.3,iOS 不允许,任何声称可行的方案都是已失效的私有 API。
- **先交付 MVP(§3.1)再谈其他。** 看板类项目最常见的失败模式是功能堆砌但没人看;先让核心的晨读闹钟每天真正跑起来。

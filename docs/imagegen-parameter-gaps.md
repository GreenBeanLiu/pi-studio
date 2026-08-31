# 生图参数缺口

三个出图入口共用后端 `/imagegen`，但各自暴露的参数差很多。这份是待补清单。

## 现状对照

| 参数 | main `generateImage()` | ImageGen 页面 | 聊天 `image_gen` | 工作流 `imagegen` 步 |
| --- | --- | --- | --- | --- |
| `prompt` | 有 | 有（**截断到 500 字符**） | 有 | 有 |
| `engine` | 有 | 有（模型选择器） | 无，写死云端默认 | 有 |
| `model` | 有 | 有 | 无 | **无**，只传 engine |
| `size` | 有 | 有（8 档） | 有（**只 4 档**） | **无** |
| `quality` | 有 | 有 | 无 | 无 |
| `background` | 有 | 有 | 无 | 无 |
| `outputFormat` | 有 | 有 | 无 | 无 |
| `outputCompression` | 有 | 有 | 无 | 无 |
| `moderation` | 有 | 有 | 无 | 无 |
| `responseFormat` | 有 | 有 | 无 | 无 |
| `n`（一次生成几张） | 有 | 有 | 无，固定 1 | 无，固定 1 |
| `aspectRatio`（gemini/grok） | 有 | 有 | 无 | 无 |
| `imageSize`（gemini/grok 分辨率） | 有 | 有 | 无 | 无 |
| `providerStyle` | 有 | **无** | 无 | 无 |
| `referenceUrls`（参考图） | 有 | 有 | 有（`referencePaths`） | **无** |
| `maskDataUrl`（蒙版） | 有 | 有 | 无 | 无 |

## 按优先级

### P0 — `prompt` 500 字符上限

上限常量是 `src/renderer/src/lib/image-style-templates.ts` 的 `IMAGE_PROMPT_MAX = 500`
（原先在 `ImageGenerationWorkspace.tsx`，为了让数据层测试守住「模板骨架装得下」才挪过来的），
`ImageInputSection` 里是硬截断（`value.slice(0, promptMax)`），粘长提示词会被无声吃掉尾巴。

风格库 541 个案例里 **360 条（66%）超过 500 字符**，p90 是 2748，最长 8143。
中位数 1041。也就是说这个上限挡掉了大部分工业级提示词，也挡住了模板选择器。

要确认的是后端 `/imagegen` 有没有真实上限；如果没有，这里应该放宽到 4000 左右并改成
软提示（超了标红但不截断），而不是静默 slice。

风格模板的骨架都控制在 150 字符以内，在当前 500 的上限下可用（留了填占位符的余量），
`image-style-templates.test.ts` 会守住这条。放宽上限后骨架可以写得更细。

### P1 — 工作流 `imagegen` 步没有参考图入口

`dressup` 有 `personRef` / `garmentRef`，`model3d` 有 `imageRef`，唯独 `imagegen` 没有。
结果是工作流里做不了「上一步出图 → 这一步照着改」。
`runImagegenStep`（`src/main/routines.ts`）只传 `prompt` / `engine` / `downloadResult`。

补法需要动四处：
1. `RoutineStep` 加字段（`src/shared/ipc/contract.ts`）
2. `routineNodeSchemas('imagegen')` 校验（`src/main/routine-node-schema.ts`）
3. 节点编辑 UI（`RoutinesPage.tsx`）
4. `runImagegenStep` 传下去（`src/main/routines.ts`）

### P2 — 工作流 `imagegen` 步没有 size

同上四处。当前比例只能靠 prompt 正文描述，`media.app-icon-master` 那类预设就是这么绕的。
加了之后 `routine-node-presets.ts` 里的预设可以直接带尺寸。

### P3 — 聊天 `image_gen` 工具参数太窄

只有 `prompt` / `size`（4 档） / `referencePaths`。缺 `quality`、`background`、`n`、蒙版。
透明背景现在只能靠 prompt 里写「transparent background」哄模型，命中率不如直接传
`background: 'transparent'`。

这条最好补：扩展自己走 `cloudFetch('/imagegen')`，body 是 `Record<string, unknown>`，
**只改 `resources/pi-extensions/pi-studio-imagegen.ts` 一个文件**
（`Type.Object` 加字段 + body 加字段），不用动主进程。
`size` 的 4 档也可以直接对齐页面的 8 档。

### P4 — 页面缺 `providerStyle`

`vivid` / `natural` 在契约和 `generateImage()` 里都有，`ImageOutputSection` 的高级区没放。
一行 Select 的事。

## 备注

聊天工具和工作流是**两条独立代码路径**：工作流走主进程 `generateImage()`（参数齐全，只是没传），
聊天工具走扩展自己的 HTTP 调用。补参数时别指望改一处两边都生效。

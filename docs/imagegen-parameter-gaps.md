# 生图参数缺口

三个出图入口共用后端 `/imagegen`，但各自暴露的参数差很多。P0–P4 已于 2026-08-31 补完，
这份留作对照表和后续待办。

## 现状对照

| 参数 | main `generateImage()` | ImageGen 页面 | 聊天 `image_gen` | 工作流 `imagegen` 步 |
| --- | --- | --- | --- | --- |
| `prompt` | 有 | 有（上限 4000，超了禁用按钮不截断） | 有 | 有 |
| `engine` | 有 | 有（模型选择器） | 无，写死云端默认 | 有 |
| `model` | 有 | 有 | 无 | 无，只传 engine |
| `size` | 有 | 有（8 档） | 有（8 档） | 有（8 档 + 服务端默认） |
| `quality` | 有 | 有 | 有 | 无 |
| `background` | 有 | 有 | 有 | 无 |
| `outputFormat` | 有 | 有 | 无 | 无 |
| `outputCompression` | 有 | 有 | 无 | 无 |
| `moderation` | 有 | 有 | 无 | 无 |
| `responseFormat` | 有 | 有 | 无 | 无 |
| `n`（一次生成几张） | 有 | 有 | 有（1–4） | 无，固定 1 |
| `aspectRatio`（gemini/grok） | 有 | 有 | 无 | 无 |
| `imageSize`（gemini/grok 分辨率） | 有 | 有 | 无 | 无 |
| `providerStyle` | 有 | 有 | 无 | 无 |
| `referenceUrls`（参考图） | 有 | 有 | 有（`referencePaths`） | 有（`imageRef`） |
| `maskDataUrl`（蒙版） | 有 | 有 | 无（见下） | 无 |

## 已完成

**P0 提示词上限**（`IMAGE_PROMPT_MAX`，在 `src/renderer/src/lib/image-style-templates.ts`）
500 → 4000，且不再硬截断：超限时计数标红、生成按钮禁用并给出提示。
原来的 `value.slice(0, promptMax)` 会把粘进来的长提示词无声吃掉尾巴，
而风格库 541 个案例里 66% 超过 500 字符，p90 是 2748。
4000 取自 OpenAI images API 里最保守的那档；**后端 `/imagegen` 的真实上限没有核实过**，
如果中继那边更宽，这个值还可以再放。

**P1 工作流参考图** 复用 `imageRef` 字段（`model3d` / `app-icon` 已在用），
配 `RoutineImageReferencePicker`。默认留空 = 文生图 —— 刻意不学 `model3d`
默认吃 `{{prev.imageUrl}}`，否则每个生图节点都会悄悄变成改图。
已是公网图直接透传给云端，省掉「下载成 data URL 再传回 R2」这一趟；
配了参考图但没解析出来会报错，不静默退回文生图。

**P2 工作流尺寸** `RoutineStep.size`，节点编辑器里一个 Select（含「服务端默认」）。
`media.cover`、`media.app-icon-master` 和「表情包生成」模板已改成带 `size`，
不再靠提示词正文描述比例。

**P3 聊天工具** `size` 从 4 档补到 8 档，新增 `quality` / `background` / `n`(1–4)。
`n > 1` 时把每张图都带回给 agent 挑。工具与参数描述里点明了
「透明背景传 `background=transparent`，别只在 prompt 里写」和「每张都单独计费」。

**P4 `providerStyle`** 生图页高级区加了 `vivid` / `natural` 的 Select。

## 待办

**聊天工具的蒙版没做。** 蒙版要一张涂抹出来的 PNG，agent 手上没有这个东西，
而中继要的是上传后的 `maskUrl`。要做的话得先有「让 agent 引用页面上刚画好的蒙版」这条路径，
不是加个参数就行。

**工作流步骤缺 `quality` / `background` / `n`。** 加法和 P2 完全一样（契约 → schema →
节点编辑 UI → `runImagegenStep`），只是当时没做。透明背景在工作流里目前还只能靠提示词描述。

**`resources/pi-extensions/` 没有静态检查覆盖**，但有行为测试。
两个 tsconfig 的 `include` 都不含这个目录，`eslint` 也只扫 `src` 和 `tests`，
所以那两个扩展的 TS 从来没被 typecheck 过；`@sinclair/typebox` 甚至不在本仓库依赖里
（由 pi 宿主提供），单独跑 `tsc` 也解析不了它。

真正的保护是 `tests/imagegen-extension.test.ts` —— 它把扩展通过 pi 真加载起来，
检查注册出的 schema 和实际发给中继的 body，比 typecheck 管用。改这个扩展时以那份测试为准。
`pi-studio-codex-sessions.ts` 没有同等的测试。

## 备注

聊天工具和工作流是**两条独立代码路径**：工作流走主进程 `generateImage()`，
聊天工具走扩展自己的 `cloudFetch('/imagegen')`。补参数时别指望改一处两边生效。

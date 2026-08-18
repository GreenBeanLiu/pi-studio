---
name: interface-review
disable-model-invocation: true
description: >-
  界面审查 skill：按可访问性、布局、文案、色彩主题、排版、UI 细节与动效、桌面端特有等维度，对 pi-studio
  的界面（某个界面、流程、或未提交的改动）做一次结构化审查，输出带严重度分级的 findings 表和 verdict。
  只审界面质量，不审正确性、测试、安全、性能（那些归代码审查）。仅由用户显式调用（/skill:interface-review），
  永不自动触发。触发词：界面审查、UI review、审查界面、review UI、界面体检、ui 走查、a11y、可访问性、
  深色模式、视觉走查。
---

# 界面审查（pi-studio）

对 pi-studio 的界面做结构化审查，输出一份可执行的 findings 表。**只审界面质量**：可访问性、布局、文案、色彩、排版、动效与细节。正确性、测试、安全、性能归项目常规代码审查，点到为止、不展开。

所有修复必须用 pi-studio 自己的写法（antd-style `createStyles` + antd token），见 [project-idiom.md](references/project-idiom.md)。具体每个维度查什么，见 [review-checklist.md](references/review-checklist.md)。

## 第一步：先侦察

审查前先确认这些事实，并在输出里说明发现了哪些（或没有）：

- 目标范围：用户点名的界面 / 流程；未点名则从当前上下文推断，并在输出里**明确写下范围边界**。
- 涉及的组件文件（`src/renderer/src/components/`）。
- 已用的样式方案（antd-style / Tailwind / LobeHub UI）与主题 token。
- 是否有可运行的预览方式（`pnpm dev`），以及 `appearance` 深浅色如何切换。
- 项目有没有写过自己的界面约定文档（`docs/`、`优化.md` 等）—— 读过就点名。

读过约定文档不等于约定就是对的；约定作为「报在哪」的依据，不作为「不报」的借口。若是共享 token 或全局样式导致的，报在源头并列出受影响组件，只报一次。

## 审查顺序（先基础后润色）

1. 可访问性
2. 布局与结构
3. 文案
4. 色彩与主题
5. 排版
6. UI 细节与动效
7. 桌面端特有

逐维按 [review-checklist.md](references/review-checklist.md) 走查。深度由模式决定：

| 模式 | 覆盖 | Finding 上限 |
| --- | --- | --- |
| `quick` | 主路径 + 实际会到达的状态，只报 HIGH / MEDIUM | 5 |
| `full`（默认） | 完整范围，含空状态、加载、错误、窄窗口、深浅色 | 15 |

模式解析：第一个 token 是 `quick` 或 `full` 时当作模式，否则整个请求都是范围。范围太大审不实就收窄到一条完整流程，并在输出里说明边界和排除了什么。

## 严重度

- **HIGH**：用户会卡住、误解、或功能不可用（键盘走不通、深色模式漏光到看不清、危险按钮语义不清、点击目标太小）。
- **MEDIUM**：体验明显受损但不阻断（对比度不足、术语不一致、焦点环缺失）。
- **LOW**：打磨项（圆角不一致、退场动画生硬、间距不齐）。

## 输出格式

先一行写清范围 + 侦察结论，然后：

| # | 位置 | 维度 | 问题 | 为什么 | 改法 | 严重度 |
| --- | --- | --- | --- | --- | --- | --- |

- **位置**：组件名 + 文件路径（共享问题报源头）。
- **改法**：必须用 pi-studio 写法给具体改法（含 token 名 / 代码片段）；给不出具体改法的标「需与设计确认」。
- 超过 cap 的 finding 不报，说明截断。
- 最后给 **verdict**：一句话 + `Approve` / `Approve with nits` / `Request changes`。

改法示例（符合项目写法）：

> 焦点环缺失 → 在 `createStyles` 里加 `&:focus-visible { outline: 2px solid ${token.colorPrimary}; outline-offset: 2px; }`，不要 `outline: none`。

## 职责边界

- 文案的「怎么渲染」（截断、大小写、标点）属排版/文案，本 skill 内统一处理即可；不引入别的 skill。
- 正确性 bug、测试、安全、性能：点名一次就转到代码审查，不在这里展开。
- 本 skill 是审查方，只提改法建议；是否落地由用户决定。改法要可验证（能说出验证步骤）。

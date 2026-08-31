---
name: gpt-image-2-style-library
description: >-
  用 awesome-gpt-image-2 风格库把出图需求变成可直接执行的 gpt-image-2 提示词:先按模板分类、风格标签、
  场景标签选型,再按主体/构图/风格/文字/比例/负面约束六段式写出成品 prompt,并按 pi-studio 的生图链路
  定好尺寸和参考图。需要出图,或需要写、改、评、分类图像提示词时使用。
  Triggers on: 生图, 出图, 画一张, 做张图, 帮我画, 配图, 图像提示词, 提示词优化, prompt 优化, 风格库,
  海报, 封面, 插画, 信息图, 知识图谱, 表情包, 头像, 壁纸, App 图标, 商品图, 电商详情页, 产品图, 包装,
  品牌, logo, VI, UI 截图, 界面稿, 仪表盘, 分镜, 角色设定, 3D 玩具, 手办, 写实摄影, 古风, 排版, 版式,
  gpt-image-2, GPT-Image2, image prompt, poster, cover, infographic, product shot, app icon,
  logo design, character sheet, storyboard, style library.
---

# GPT-Image2 风格库

> 模板与分类数据改编自 [awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2)(MIT, (c) 2026 freestylefly),见本目录 `LICENSE`。

把出图需求变成 pi-studio 能直接跑的 gpt-image-2 提示词。职责边界:**只管选型和写 prompt**,画完之后的模型参数调优、生图服务故障不归它管;图生 3D 走 `object-to-threejs-procedural`,界面视觉走查走 `interface-review`。

## Quick Reference

| Concern | Reference |
| --- | --- |
| 22 个模板、13 个分类、风格/场景标签,以及每个模板的 guidance 与 pitfalls | [style-library.md](references/style-library.md) |
| pi-studio 的生图链路:模型能力、尺寸只有三档、参考图怎么传、工作流步骤怎么写 | [project-idiom.md](references/project-idiom.md) |

## 核心原则

1. **先选型再写词。** 按 模板分类 → 风格标签 → 场景标签 → 相近案例 的顺序匹配,不要凭印象直接开写。
2. **模板给的是约束,不是文案。** `style-library.md` 里只有 useWhen / guidance / pitfalls,prompt 正文得你自己写;照抄模板名和标签不算 prompt。
3. **画面里的文字逐字写死。** 中文文案必须原样写进 prompt 并标明位置,不留给模型自由发挥。
4. **比例写进正文。** pi-studio 的尺寸只有三档,4:5、21:9 这类比例只能靠 prompt 描述,见 [project-idiom.md](references/project-idiom.md)。
5. **一次只给一个方案。** 需求含糊时先问,不要一口气甩三段 prompt 让用户自己挑。
6. **跟随用户语言。** 中文提问就写中文 prompt,英文提问写英文,除非用户另行指定。

## 工作流

1. 判断输出目标:界面 / 图表 / 海报 / 商品 / 品牌 / 建筑 / 摄影 / 插画 / 角色 / 场景 / 历史 / 文档 / 特殊任务。
2. 读 [style-library.md](references/style-library.md),按核心原则 1 的顺序匹配模板。
   - 单个模板明显最合适 → 直接用。
   - 两三个都说得通 → 各给一句理由让用户选,**这一步先不要写 prompt**。
3. 读中选模板的 `Guidance` 和 `Pitfalls`,把它们翻译成本次 prompt 里的具体约束。
4. 六段式组装 prompt:主体与任务 / 构图与版式 / 风格与材质 / 文字与标注 / 比例与输出 / 负面约束。
5. 读 [project-idiom.md](references/project-idiom.md) 定尺寸和参考图,然后分流:
   - 用户要的是**图** → 调 `image_gen`;拿到图后自查文字是否准确、构图和比例是否符合,不对就改 prompt 重画。
   - 用户要的是**提示词或工作流步骤** → 只输出文本,不要调用工具。

## 输出格式

先给可复制的 prompt 正文(独立代码块),再补三行:

1. **模板**:选中的模板名 + 一句话理由。
2. **参数**:`size` 取值,以及是否需要参考图。
3. **注意**:这次特意规避掉的 1-2 条 pitfalls。

用户只要 prompt 时不要再附加解说;要出图时先出图,再补这三行。

## 失败处理

- 需求只有一个词(例如「画个海报」)→ 先问用途、画面里要出现的文字、比例,不要猜完直接生成。
- 风格库里没有对口模板 → 明说「这个方向风格库没覆盖」,按六段式自己写,不要硬套一个不相干的模板名充数。
- `image_gen` 报未配置 → 转告用户去 pi-studio 设置里填中继地址和密钥,不要反复重试。
- 涉及真人肖像、明星、他人品牌 logo 复刻 → 说明风格库案例来自公开社区内容、不保证可商用,建议改成原创描述。

## 职责边界

- 生成失败、超时、服务不可用:属于生图链路问题,如实报给用户,不在这里静默重试或偷偷换模型。
- 图生 3D、程序化建模:交给 `object-to-threejs-procedural`。
- 界面视觉走查:交给 `interface-review`。
- 代码正确性、测试、安全、性能:不在本 skill 范围,转代码审查。

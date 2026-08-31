import type { GeminiImageAspectRatio, GrokImageAspectRatio, ImageGenSize } from './api'

/**
 * 生图风格模板。分类、风格/场景标签和每个模板的适用范围来自
 * awesome-gpt-image-2(MIT, (c) 2026 freestylefly)的 style-library;
 * skeleton 正文是按该库的 guidance/pitfalls 自行编写的六段式骨架
 * (主体 / 构图 / 风格 / 文字 / 比例 / 负面约束),没有搬运上游案例提示词。
 *
 * 同一份分类体系也喂给了内置 skill gpt-image-2-style-library,
 * 聊天里让 agent 写提示词和这里点模板走的是同一套选型逻辑。
 */

/**
 * 提示词输入框的字符上限。原来是 500,但工业级提示词普遍上千字(风格库 541 个案例里
 * 66% 超过 500,p90 是 2748),旧上限是硬截断,粘长提示词会被无声吃掉尾巴。
 * 4000 取自 OpenAI images API 里最保守的那档;超了不再截断,改成禁用生成按钮 + 标红计数。
 * image-style-templates.test.ts 守住「骨架必须装得下」这条不变量。
 */
export const IMAGE_PROMPT_MAX = 4000

export type ImageStyleCategoryId =
  | 'ui'
  | 'infographic'
  | 'poster'
  | 'product'
  | 'brand'
  | 'architecture'
  | 'photography'
  | 'illustration'
  | 'character'
  | 'scene'
  | 'history'
  | 'document'
  | 'other'

export type ImageStyleCategory = {
  id: ImageStyleCategoryId
  label: string
}

export type ImageStyleTemplate = {
  id: string
  label: string
  category: ImageStyleCategoryId
  /** 一句话适用范围,鼠标悬停时显示 */
  hint: string
  /** 搜索用的风格与场景词 */
  tags: readonly string[]
  /** 推荐画幅;gpt 模型直接用,gemini/grok 走 templateAspectRatio 换算 */
  size: ImageGenSize
  /** 填进提示词输入框的六段式骨架,【】是待填占位符 */
  skeleton: string
}

export const IMAGE_STYLE_CATEGORIES: readonly ImageStyleCategory[] = [
  { id: 'ui', label: 'UI 与界面' },
  { id: 'infographic', label: '图表与信息图' },
  { id: 'poster', label: '海报与排版' },
  { id: 'product', label: '商品与电商' },
  { id: 'brand', label: '品牌与标志' },
  { id: 'architecture', label: '建筑与空间' },
  { id: 'photography', label: '摄影与写实' },
  { id: 'illustration', label: '插画与艺术' },
  { id: 'character', label: '角色与人物' },
  { id: 'scene', label: '场景与叙事' },
  { id: 'history', label: '历史与古风' },
  { id: 'document', label: '文档与出版' },
  { id: 'other', label: '其他场景' },
] as const

export const IMAGE_STYLE_TEMPLATES: readonly ImageStyleTemplate[] = [
  {
    id: 'ui-screenshot-system',
    label: 'UI 截图系统',
    category: 'ui',
    hint: 'App 截图、仪表盘、社媒截图、直播界面',
    tags: ['界面', '截图', '仪表盘', 'App', '网页', 'UI', 'dashboard'],
    size: '1024x1536',
    skeleton:
      '生成【iOS App / 网页仪表盘】的高保真界面截图。主体是【页面名与核心功能】。' +
      '版式：状态栏 + 【顶部导航】+ 主内容区 + 【底部 Tab】，层级分明、对齐规整。' +
      '风格：【设计风格与主色】。界面文案逐字为【…】，小字也要清晰可读。竖版构图。' +
      '不要设备外框、鼠标指针、水印和乱码文字。',
  },
  {
    id: 'infographic-engine',
    label: '信息图引擎',
    category: 'infographic',
    hint: '解释图、技术图解、时间线、知识卡片',
    tags: ['信息图', '图解', '知识图谱', '时间线', 'infographic', 'diagram'],
    size: '1024x1536',
    skeleton:
      '生成讲解【主题】的中文信息图。拆成【3-5】个模块：【模块一 / 模块二 / 模块三】，' +
      '用箭头和色块表达它们之间的【流程 / 因果 / 层级】关系。' +
      '风格：扁平图标 + 有限配色 + 充足留白。每个模块只配【不超过 8 字】的短标签，逐字为【…】。' +
      '竖版构图。不要整段正文、不要密集小字。',
  },
  {
    id: 'scientific-scale-diagram',
    label: '科学尺度缩放图',
    category: 'infographic',
    hint: '从微观到宏观展示尺度变化的科普图',
    tags: ['科普', '尺度', '缩放', '教育', 'science', 'scale'],
    size: '1536x1024',
    skeleton:
      '生成【主题】的尺度对比图，从【最小尺度】一路放大到【最大尺度】。' +
      '排成【6-8】个尺度框，每框标注单位与倍率，且各框的画面内容明显不同。' +
      '风格：科普插画 + 精确标注。标签用短句，逐字为【…】。横版构图。' +
      '不要放大镜套框那种通用布局，不要让各尺度框长得一样。',
  },
  {
    id: 'poster-layout-system',
    label: '海报排版系统',
    category: 'poster',
    hint: '活动海报、电影海报、封面、社媒传播视觉',
    tags: ['海报', '封面', '排版', '活动', 'poster', 'cover'],
    size: '1024x1536',
    skeleton:
      '生成一张【用途，如开业 / 演出 / 招募】海报成品。主视觉是【主体】。' +
      '版式：主标题【…】置于【上方 / 中部】且字号最大，副标题【…】次之，' +
      '底部信息栏写【时间 / 地点 / 主办方】。风格：【风格与配色】。' +
      '竖版构图。所有文字逐字照写、不增不改；不要生成拼贴展示板，不要多余装饰符号和水印。',
  },
  {
    id: 'sports-campaign-poster',
    label: '运动商业 Campaign',
    category: 'poster',
    hint: '运动品牌 Campaign、运动员海报、运动产品视觉',
    tags: ['运动', '品牌', '广告', 'campaign', 'sports'],
    size: '1024x1536',
    skeleton:
      '生成【运动项目】的品牌 Campaign 海报。主体是【运动员或产品】，处于【具体姿态】，' +
      '核心道具是【器材】。构图干净，主体占画面主导，强光影与硬边阴影。' +
      '品牌色为【…】，标题文案逐字为【…】，数据层【成绩 / 参数】要清晰可读。竖版构图。' +
      '器材形制必须正确，不要杂乱拼贴，不要虚构品牌 Logo。',
  },
  {
    id: 'conceptual-typography-poster',
    label: '概念字体海报',
    category: 'poster',
    hint: '标题文字本身就是主视觉结构的海报',
    tags: ['字体', '排版', '概念', 'typography', '创意'],
    size: '1024x1536',
    skeleton:
      '生成一张以文字为主视觉的概念海报，主标题是【文字内容】，必须拼写完全准确。' +
      '让字形本身承担画面结构：【描述字形如何变形 / 与什么元素结合】。' +
      '画面里的人物、物体或风景要服务于标题含义，不喧宾夺主。' +
      '配色控制在【2-3】种以内，风格克制。竖版构图。不要默认字效、不要无关图标、不要错字。',
  },
  {
    id: 'ink-double-exposure-poster',
    label: '水墨双重曝光海报',
    category: 'poster',
    hint: '诗意人像、水墨氛围、文化主题视觉',
    tags: ['水墨', '双重曝光', '国风', '人像', '文化'],
    size: '1024x1536',
    skeleton:
      '生成一张水墨双重曝光海报：【人物】的侧脸剪影内融入【山水 / 建筑 / 植物】的水墨景致。' +
      '保留宣纸质感、飞白与晕染，大面积留白，构图克制。主色【…】。' +
      '文字仅保留【标题或诗句】，位置在【…】，其余不加字。竖版构图。' +
      '不要廉价奇幻拼贴，不要把景物堆满画面。',
  },
  {
    id: 'nature-science-poster',
    label: '自然科普海报',
    category: 'poster',
    hint: '自然主题的干净科普海报',
    tags: ['科普', '自然', '教育', '博物', 'nature'],
    size: '1024x1536',
    skeleton:
      '生成【物种 / 自然现象】的科普海报。主体居中、形态准确，柔和阴影，大量留白。' +
      '标题【…】置于顶部，配【3-5】条短科普标签，每条不超过【12】字，逐字为【…】。' +
      '风格：博物图鉴质感，配色柔和克制。竖版构图。' +
      '不要广告促销感，不要密集的百科正文。',
  },
  {
    id: 'product-commerce-visual',
    label: '商品商业视觉',
    category: 'product',
    hint: '商品主图、包装视觉、详情页、卖点排版',
    tags: ['商品', '电商', '详情页', '包装', 'product', '卖点'],
    size: '1024x1024',
    skeleton:
      '生成【商品】的电商主图。商品居中且占画面主导，材质是【…】，' +
      '置于【场景或纯色背景】，采用【柔光棚拍 / 硬光】。' +
      '围绕商品排【2-3】条卖点标签，文案逐字为【…】，包装上的文字同样逐字照写。' +
      '正方形构图。不要与商品无关的道具，不要虚构品牌标识和认证图标。',
  },
  {
    id: 'personalized-beauty-report',
    label: '个性化美妆报告',
    category: 'product',
    hint: '美妆推荐、肤质报告、导购卡片',
    tags: ['美妆', '报告', '导购', '推荐', 'beauty'],
    size: '1024x1536',
    skeleton:
      '生成一张【肤质 / 妆容】分析报告卡片，分三层：顶部诊断结论【…】、' +
      '中部【2-3】条建议、底部【2-4】张商品卡片，每张含商品图、名称【…】和评分。' +
      '三层左右对齐，字号分级清晰。风格：干净的浅色卡片式 UI。竖版构图。' +
      '结论用生活化表达，不要医疗诊断口吻；不要难以辨认的小字。',
  },
  {
    id: 'brand-identity-package',
    label: '品牌身份包',
    category: 'brand',
    hint: 'Logo 系统、品牌板、VI 套件、应用样机',
    tags: ['品牌', 'logo', 'VI', '标志', 'brand', 'identity'],
    size: '1536x1024',
    skeleton:
      '生成【品牌名】的品牌视觉板。品牌定位是【…】。画面分区展示：' +
      '主 Logo、色卡【主色 / 辅色】、字体样例、以及【名片 / 包装 / 招牌】等应用样机。' +
      '所有分区共享同一套配色与字体逻辑，网格对齐。品牌名文字逐字为【…】，拼写必须准确。' +
      '横版构图。不要生成多个无关 Logo 变体，不要混入其它品牌元素。',
  },
  {
    id: 'brand-touchpoint-board',
    label: '品牌触点视觉板',
    category: 'brand',
    hint: '多触点 Campaign 展示、品牌落地预览',
    tags: ['品牌', '触点', 'campaign', '样机', 'mockup'],
    size: '1536x1024',
    skeleton:
      '生成【品牌 / Campaign 名】的触点展示板，包含【海报 / 包装 / 户外 / 社媒 / 周边】等' +
      '【4-6】个触点样机，排成规整网格。所有面板共享同一套配色【…】、字体和主视觉元素。' +
      '主标语逐字为【…】。横版构图。' +
      '不要混入风格不一致的 Campaign；面板多到看不清时减少触点数量而不是缩小画面。',
  },
  {
    id: 'architecture-space',
    label: '建筑与空间',
    category: 'architecture',
    hint: '室内、建筑表现、城市地图、空间规划',
    tags: ['建筑', '室内', '空间', '地图', 'architecture', 'interior'],
    size: '1536x1024',
    skeleton:
      '生成【室内 / 建筑外观 / 城市地图】表现图，对象是【…】，功能是【…】。' +
      '视角【人视 / 鸟瞰 / 轴测】，主要材质【…】，光线【自然光 / 黄昏 / 夜景】。' +
      '若是地图：标注【地标清单】，标签用中文且相对位置准确。横版构图。' +
      '透视必须合理，不要出现结构上站不住的构件。',
  },
  {
    id: 'realistic-photography',
    label: '写实摄影',
    category: 'photography',
    hint: '人像、街拍、商品摄影、电影感写实',
    tags: ['摄影', '写实', '人像', '电影感', 'photography', 'portrait'],
    size: '1024x1536',
    skeleton:
      '拍摄【主体】的写实照片。机位【平视 / 俯拍 / 低角度】，镜头【35mm / 85mm】，' +
      '光源【自然侧光 / 棚拍柔光 / 逆光】，背景【…】，主体动作是【…】。' +
      '皮肤和织物保留真实纹理与细微瑕疵，景深自然。竖版构图。' +
      '不要过度磨皮、不要塑料感；手部结构必须正确，画面中不要出现文字。',
  },
  {
    id: 'street-accident-moment',
    label: '街头意外瞬间',
    category: 'photography',
    hint: '街头抓拍、意外瞬间、手机纪实感',
    tags: ['街拍', '抓拍', '纪实', '瞬间', 'street', 'candid'],
    size: '1536x1024',
    skeleton:
      '抓拍【具体意外瞬间，如奶茶泼出的一刻】。机位【齐胸高 / 低角度】，' +
      '带轻微运动模糊和手持抖动，背景是【具体街景】，环境杂乱可信。' +
      '光线为【当下时段的自然光】。横版构图。' +
      '要像随手拍的手机照片，不要摆拍感、不要广告棚拍的干净布光，画面不要过于整洁。',
  },
  {
    id: 'illustration-art-style',
    label: '插画与艺术风格',
    category: 'illustration',
    hint: '动漫、水彩、水墨、装饰画、风格实验',
    tags: ['插画', '水彩', '动漫', '绘画', 'illustration', 'art'],
    size: '1024x1024',
    skeleton:
      '画一张【主题】插画。主体【…】位于【画面位置】，构图是【…】。' +
      '风格：【水彩 / 厚涂 / 平涂 / 版画】，笔触【…】，主色【…】，情绪【…】。' +
      '完成度：【草稿感 / 完整成稿】。正方形构图。' +
      '不要只有风格没有构图，画面中不要出现文字和签名。',
  },
  {
    id: 'character-design-sheet',
    label: '角色设定表',
    category: 'character',
    hint: '角色设定表、动作网格、一致性参考',
    tags: ['角色', '设定表', '三视图', '动作', 'character', '立绘'],
    size: '1536x1024',
    skeleton:
      '生成【角色名】的角色设定表。身份锚点：【发型 / 脸型 / 服装 / 配饰】，这些细节在每格中必须完全一致。' +
      '排成【2×3 / 3×3】网格，共【…】个动作：【动作清单】。统一底色，角色比例一致。' +
      '风格：【…】。横版构图。' +
      '不要在不同格里改变服装细节和配色；格子太挤就减少动作数量。',
  },
  {
    id: '3d-collectible-toy',
    label: '3D 收藏玩具',
    category: 'character',
    hint: '潮玩公仔、头像手办、3D 展示图',
    tags: ['3D', '手办', '潮玩', '公仔', 'toy', '收藏'],
    size: '1024x1024',
    skeleton:
      '生成【角色】的收藏级 3D 公仔展示图。保留【脸部特征 / 发型 / 服装】这些身份锚点。' +
      '材质【软胶 / 搪胶 / 哑光树脂】，配【底座】，摆在【展示台 / 包装盒前】，柔和棚拍光。' +
      '包装上的文字仅【…】，少量且准确。正方形构图。' +
      '不要做成没有身份特征的通用玩偶，不要堆砌包装文案。',
  },
  {
    id: 'scene-storytelling',
    label: '场景叙事',
    category: 'scene',
    hint: '分镜、世界观、直播场景、情绪叙事画面',
    tags: ['场景', '分镜', '叙事', '世界观', 'scene', 'storyboard'],
    size: '1536x1024',
    skeleton:
      '画一个叙事画面：【人物】在【地点】的【时间】，正在【动作】，冲突或悬念是【…】。' +
      '机位【…】，情绪【…】。场景里的道具和环境细节要能透露故事线索：【具体线索】。' +
      '风格：【…】。横版构图。' +
      '不要通用奇幻背景板，故事线索必须在画面里看得见，不要只靠氛围。',
  },
  {
    id: 'history-classical-themes',
    label: '历史与古风题材',
    category: 'history',
    hint: '古风、长卷、朝代服饰、诗词视觉',
    tags: ['古风', '历史', '长卷', '国风', '诗词', 'classical'],
    size: '1536x1024',
    skeleton:
      '生成【朝代】题材的【长卷 / 册页 / 海报】。主体是【人物或场景】，' +
      '服饰遵循【该朝代】形制，器物参考【具体器物】，建筑与纹样同朝代。' +
      '风格：【绢本设色 / 水墨 / 壁画】，气质【…】。横版构图。' +
      '不要混搭其它朝代的服饰与器物，画面中不要出现任何现代物件。',
  },
  {
    id: 'document-publishing',
    label: '文档与出版物',
    category: 'document',
    hint: '白皮书、手册、图鉴、报告页面',
    tags: ['文档', '出版', '排版', '手册', '图鉴', 'document'],
    size: '1024x1536',
    skeleton:
      '生成一页【白皮书 / 手册 / 图鉴】版面，主题【…】。' +
      '版式：【单栏 / 双栏】网格，含页眉、标题【…】、正文块、【图表 / 插图】和图注。' +
      '字体分级清晰，图表与文字对齐同一网格。风格：【…】。竖版构图。' +
      '正文可以用示意性文字块，但标题和图注要逐字照写；不要密集到看不清的小字。',
  },
  {
    id: 'concept-product-breakdown',
    label: '概念产品拆解',
    category: 'other',
    hint: '研发视觉板、爆炸图、组件拆解',
    tags: ['拆解', '爆炸图', '概念', '研发', 'breakdown', '技术'],
    size: '1536x1024',
    skeleton:
      '生成【产品】的组件拆解图。把它拆成【组件清单】，按【爆炸图 / 分层排列】展开，' +
      '组件之间用细引线连到短标签，每个标签不超过【8】字，逐字为【…】。' +
      '材质与配色体现【…】。风格：克制的技术制图感。横版构图。' +
      '组件的装配关系必须说得通，标签不要长句，不要堆无关的技术符号。',
  },
] as const

const CATEGORY_LABELS = new Map(IMAGE_STYLE_CATEGORIES.map((item) => [item.id, item.label]))

export function imageStyleCategoryLabel(id: ImageStyleCategoryId): string {
  return CATEGORY_LABELS.get(id) ?? id
}

/**
 * 关键词 + 分类的组合筛选。关键词按名称、适用范围、标签和分类名做大小写无关子串匹配;
 * 关键词为空就只按分类筛,分类为 null 就只按关键词筛,两者都空返回全部。
 */
export function filterImageStyleTemplates(
  query: string,
  category: ImageStyleCategoryId | null,
): ImageStyleTemplate[] {
  const needle = query.trim().toLowerCase()
  return IMAGE_STYLE_TEMPLATES.filter((template) => {
    if (category && template.category !== category) return false
    if (!needle) return true
    return [
      template.label,
      template.hint,
      imageStyleCategoryLabel(template.category),
      ...template.tags,
    ].some((field) => field.toLowerCase().includes(needle))
  })
}

/**
 * gemini / grok 不吃 size,只吃画幅比例。模板的三种画幅都落在两家共有的比例上,
 * 所以换模型点同一个模板,画幅意图不会丢。
 */
export function templateAspectRatio(size: ImageGenSize): GeminiImageAspectRatio & GrokImageAspectRatio {
  if (size === '1024x1536' || size === '1024x1792') return '3:4'
  if (size === '1536x1024' || size === '1792x1024') return '4:3'
  return '1:1'
}

import { describe, expect, it } from 'vitest'
import {
  IMAGE_PROMPT_MAX,
  IMAGE_STYLE_CATEGORIES,
  IMAGE_STYLE_TEMPLATES,
  filterImageStyleTemplates,
  imageStyleCategoryLabel,
  templateAspectRatio,
} from './image-style-templates'

describe('image style templates', () => {
  it('keeps one template id per entry and covers every category chip', () => {
    const ids = IMAGE_STYLE_TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const category of IMAGE_STYLE_CATEGORIES) {
      expect(filterImageStyleTemplates('', category.id).length).toBeGreaterThan(0)
    }
  })

  it('leaves room for the user to fill placeholders under the prompt cap', () => {
    for (const template of IMAGE_STYLE_TEMPLATES) {
      // 骨架本身塞满输入框就没法填占位符了,留一半余量
      expect(template.skeleton.length).toBeLessThanOrEqual(IMAGE_PROMPT_MAX / 2)
      // 上限放宽后上面那条会变得很松,再钉一个绝对值:骨架是待填的架子,不是成品长文
      expect(template.skeleton.length).toBeLessThanOrEqual(300)
    }
  })

  it('writes every skeleton as a fillable six-part prompt', () => {
    for (const template of IMAGE_STYLE_TEMPLATES) {
      expect(template.skeleton).toContain('【')
      expect(template.skeleton).toContain('构图')
      expect(template.skeleton).toContain('不要')
    }
  })

  it('recommends only canvases the picker can map to every engine', () => {
    for (const template of IMAGE_STYLE_TEMPLATES) {
      expect(['1024x1024', '1024x1536', '1536x1024']).toContain(template.size)
    }
  })

  it('filters by category, keyword, and both together', () => {
    expect(filterImageStyleTemplates('', null)).toHaveLength(IMAGE_STYLE_TEMPLATES.length)
    expect(filterImageStyleTemplates('  ', 'poster').map((item) => item.id)).toContain(
      'poster-layout-system',
    )
    // 关键词命中标签和分类名,不只是模板名
    expect(filterImageStyleTemplates('电商', null).map((item) => item.id)).toContain(
      'product-commerce-visual',
    )
    expect(filterImageStyleTemplates('dashboard', null).map((item) => item.id)).toContain(
      'ui-screenshot-system',
    )
    expect(filterImageStyleTemplates('DASHBOARD', null)).toEqual(
      filterImageStyleTemplates('dashboard', null),
    )
    // 分类与关键词互相收窄
    expect(filterImageStyleTemplates('海报', 'photography')).toHaveLength(0)
    expect(filterImageStyleTemplates('没有这种东西', null)).toHaveLength(0)
  })

  it('maps every gpt canvas onto a ratio gemini and grok both accept', () => {
    expect(templateAspectRatio('1024x1536')).toBe('3:4')
    expect(templateAspectRatio('1024x1792')).toBe('3:4')
    expect(templateAspectRatio('1536x1024')).toBe('4:3')
    expect(templateAspectRatio('1792x1024')).toBe('4:3')
    expect(templateAspectRatio('1024x1024')).toBe('1:1')
    expect(templateAspectRatio('auto')).toBe('1:1')
  })

  it('labels categories for the chips and the template rows', () => {
    expect(imageStyleCategoryLabel('poster')).toBe('海报与排版')
    expect(IMAGE_STYLE_CATEGORIES.map((item) => item.label)).not.toContain('')
  })
})

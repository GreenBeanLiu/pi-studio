import { describe, expect, it } from 'vitest'
import { extractWechatDigest, extractWechatTitle, markdownToWechatHtml } from './wechat-article'

describe('wechat article conversion', () => {
  it('converts headings, links and inline images', () => {
    const html = markdownToWechatHtml('# 标题\n\n正文 [来源](https://example.com)', ['https://img.example/a.png'])
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<a href="https://example.com">来源</a>')
    expect(html).toContain('<img src="https://img.example/a.png"')
  })

  it('extracts title and digest', () => {
    expect(extractWechatTitle('# 我的文章\n正文', 'fallback')).toBe('我的文章')
    expect(extractWechatDigest('# 我的文章\n这是摘要内容')).toBe('这是摘要内容')
  })
})

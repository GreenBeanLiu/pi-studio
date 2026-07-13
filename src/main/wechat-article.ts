import { imageInsertionPositions } from './feishu-doc-layout'

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineMarkdown(value: string): string {
  let html = escapeHtml(value)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return html
}

export function extractWechatTitle(markdown: string, fallback: string): string {
  const heading = markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()))
  return (heading?.replace(/^#\s+/, '').trim() || fallback || '未命名文章').slice(0, 64)
}

export function extractWechatDigest(markdown: string): string {
  const text = markdown
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^#{1,3}\s+/.test(line.trim()))
    .join(' ')
    .replace(/[*`]/g, '')
    .trim()
  return text.slice(0, 120)
}

/** 将 Markdown 正文和已上传到微信的图片 URL 转成公众号可接受的 HTML。 */
export function markdownToWechatHtml(markdown: string, inlineImageUrls: string[] = []): string {
  const blocks = markdown
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((line) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line)
      if (heading) return `<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`
      if (/^[-*]\s+/.test(line)) return `<p>• ${inlineMarkdown(line.slice(2))}</p>`
      return `<p>${inlineMarkdown(line)}</p>`
    })
  const positions = imageInsertionPositions(blocks.length, inlineImageUrls.length)
  const output: string[] = []
  let cursor = 0
  for (let i = 0; i < inlineImageUrls.length; i += 1) {
    const target = positions[i]
    output.push(...blocks.slice(cursor, target))
    output.push(`<p><img src="${escapeHtml(inlineImageUrls[i])}" style="max-width:100%;" /></p>`)
    cursor = target
  }
  output.push(...blocks.slice(cursor))
  return output.join('\n') || '<p>（空）</p>'
}

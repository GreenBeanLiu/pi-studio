/**
 * 共享记忆 FTS5 检索用的分词。
 *
 * Electron 42 内置的 SQLite(3.53)只编进了 FTS3/FTS5,**没有 ICU** —— 也就没有中文
 * 分词器。直接用 unicode61,一整段连续汉字会被当成一个 token,「怎么打包」搜不到
 * 「打包命令」;换 trigram 也不行,那是子串匹配,等价于迁移前的 includes(),白改。
 *
 * 这里的做法:把连续的 CJK 段炸成**重叠二元组**,非 CJK 片段原样留给 unicode61 分词。
 * 入库(segmentSearchText)和查询(buildMatchExpression)走同一套切分,两字词就能命中。
 *
 * 已知限制:索引里只有二元组,所以单个汉字的查询("包")命中不了 —— 加一元组会让
 * 索引翻倍且精度显著变差,不值得。
 */

/**
 * BMP 内的 CJK 表意文字、假名、谚文;Ext-B 以上是代理对,罕见,不处理。
 * 写成 \u 转义而不是字面字符 —— 这个仓库有 check:text 在防乱码,
 * 范围端点不该受文件编码影响。
 */
const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\uf900-\\ufaff'
const CJK_CHUNK = new RegExp(`([${CJK}]+)`)
const CJK_HEAD = new RegExp(`^[${CJK}]`)
const WORD = /[\p{L}\p{N}_]+/gu

/**
 * 把一段文本转成写进 FTS5 的索引文本:CJK 切二元组,其余原样。
 * 结果只用于检索,展示一律回读 `memories.content`。
 */
export function segmentSearchText(text: string): string {
  const out: string[] = []
  for (const chunk of text.split(CJK_CHUNK)) {
    if (!chunk) continue
    if (!CJK_HEAD.test(chunk)) {
      out.push(chunk)
      continue
    }
    // 单字段落自己就是一个 token,否则滑窗取二元组
    if (chunk.length === 1) out.push(chunk)
    for (let i = 0; i + 1 < chunk.length; i += 1) out.push(chunk.slice(i, i + 2))
  }
  return out.join(' ')
}

/**
 * 把用户查询转成 FTS5 MATCH 表达式。每个 token 单独加引号(挡掉 MATCH 语法字符),
 * 用 OR 连接 —— 命中越多 bm25 越好,天然形成排序,不必要求全词命中。
 * 没有任何可用 token 时返回 null,调用方应退化成按时间列最近条目。
 */
export function buildMatchExpression(query: string): string | null {
  const tokens = new Set<string>()
  for (const piece of segmentSearchText(query).split(/\s+/)) {
    for (const word of piece.match(WORD) ?? []) tokens.add(word.toLocaleLowerCase())
  }
  if (tokens.size === 0) return null
  return [...tokens].map((token) => `"${token}"`).join(' OR ')
}

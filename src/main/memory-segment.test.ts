import { describe, expect, it } from 'vitest'
import { buildMatchExpression, segmentSearchText } from './memory-segment'

describe('memory segmentation', () => {
  it('splits CJK runs into overlapping bigrams and keeps the rest intact', () => {
    expect(segmentSearchText('打包命令')).toBe('打包 包命 命令')
    expect(segmentSearchText('pnpm verify')).toBe('pnpm verify')
    // 非 CJK 片段整块保留(含它自己的前导空格),unicode61 会再切一次
    expect(segmentSearchText('打包命令是 pnpm package:mac')).toBe(
      '打包 包命 命令 令是  pnpm package:mac',
    )
  })

  it('keeps a lone CJK character as its own token', () => {
    expect(segmentSearchText('包')).toBe('包')
  })

  it('handles kana and hangul the same way', () => {
    expect(segmentSearchText('ひらがな')).toBe('ひら らが がな')
    expect(segmentSearchText('한국어')).toBe('한국 국어')
  })

  it('builds an OR expression with every token quoted', () => {
    expect(buildMatchExpression('怎么打包')).toBe('"怎么" OR "么打" OR "打包"')
    expect(buildMatchExpression('pnpm verify')).toBe('"pnpm" OR "verify"')
  })

  it('strips MATCH syntax by tokenizing punctuation away', () => {
    expect(buildMatchExpression('package:mac')).toBe('"package" OR "mac"')
    expect(buildMatchExpression('NOT * "')).toBe('"not"')
  })

  it('returns null when nothing is searchable', () => {
    expect(buildMatchExpression('   ')).toBeNull()
    expect(buildMatchExpression('***')).toBeNull()
  })
})

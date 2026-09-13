import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { searchTavily } from './web-search-extension'

const extensionSource = readFileSync(new URL('./web-search-extension.ts', import.meta.url), 'utf8')
const runtimeConfig = readFileSync(new URL('./agent-runtime-config.ts', import.meta.url), 'utf8')

describe('web search relay', () => {
  it('keeps the Tavily key in the main process: the generated extension talks to the local relay', () => {
    // 生成给 pi 加载的那段源码里不能出现 api.tavily.com 或 TAVILY_API_KEY
    const generated = extensionSource.slice(extensionSource.indexOf('const EXTENSION_SOURCE'))
    expect(generated).toContain("relay + '/v1/web-search'")
    expect(generated).toContain('PI_STUDIO_MEMORY_TOKEN')
    expect(generated).not.toContain('api.tavily.com')
    expect(generated).not.toContain('TAVILY_API_KEY')
    const code = runtimeConfig.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('TAVILY_API_KEY')
  })

  it('calls Tavily with the key from settings and trims what comes back', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ api_key: 'tvly-secret', query: 'pnpm 10 changelog', max_results: 5 })
      return new Response(JSON.stringify({ results: [{ title: 'pnpm', url: 'https://pnpm.io', content: 'x'.repeat(1000) }, { title: 'no url' }] }))
    }) as unknown as typeof fetch

    const out = await searchTavily('  pnpm 10 changelog ', new AbortController().signal, fetchImpl, 'tvly-secret')

    expect(out.results).toEqual([{ title: 'pnpm', url: 'https://pnpm.io', content: 'x'.repeat(400) }])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('refuses without a key or a query, and surfaces upstream errors', async () => {
    const signal = new AbortController().signal
    await expect(searchTavily('x', signal, vi.fn() as unknown as typeof fetch, '')).rejects.toThrow(/not configured/)
    await expect(searchTavily('   ', signal, vi.fn() as unknown as typeof fetch, 'k')).rejects.toThrow(/query is required/)
    const failing = vi.fn(async () => new Response('quota', { status: 432 })) as unknown as typeof fetch
    await expect(searchTavily('x', signal, failing, 'k')).rejects.toThrow(/Tavily error 432: quota/)
  })
})

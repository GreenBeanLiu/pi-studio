import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { agentConfigDir } from './settings'

/**
 * A pi extension registering a Tavily-backed `web_search` tool, written into
 * the app-private agent config dir before each workspace start. pi loads
 * extensions from <agentDir>/extensions/ via jiti (TS is fine), and the
 * `typebox` / pi package imports resolve through pi's own alias map.
 * The Tavily key reaches the subprocess via the TAVILY_API_KEY env var —
 * never written to disk.
 */
const EXTENSION_SOURCE = `import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function webSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web 搜索',
    description:
      'Search the web (Tavily) for current, up-to-date information: news, prices, package versions, API docs, anything newer than your training data. Returns the top results with title, URL and a content snippet.',
    promptSnippet: 'web_search: search the web for current information',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query keywords' }),
    }),
    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.TAVILY_API_KEY
      if (!apiKey) throw new Error('TAVILY_API_KEY not set - configure the Tavily key in pi-studio settings')
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query: params.query, max_results: 5 }),
        signal,
      })
      if (!response.ok) throw new Error('Tavily error ' + response.status + ': ' + (await response.text()))
      const json = (await response.json()) as { results?: { title: string; url: string; content: string }[] }
      const results = json.results ?? []
      const text =
        results.length === 0
          ? 'No results found.'
          : results
              .map((r, i) => i + 1 + '. ' + r.title + '\\n' + r.url + '\\n' + r.content.slice(0, 400))
              .join('\\n\\n')
      return { content: [{ type: 'text' as const, text }], details: undefined }
    },
  })
}
`

/** Write or remove the extension depending on whether a Tavily key is configured. */
export function syncWebSearchExtension(enabled: boolean): void {
  const dir = join(agentConfigDir(), 'extensions')
  const file = join(dir, 'web-search.ts')
  if (!enabled) {
    if (existsSync(file)) rmSync(file)
    return
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, EXTENSION_SOURCE, 'utf-8')
}

import { dirname, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { agentConfigDir, loadSettings } from './settings'
import { registerLocalRoute } from './shared-memory'

/**
 * A pi extension registering a Tavily-backed `web_search` tool, written into
 * the app-private agent config dir before each workspace start. pi loads
 * extensions from <agentDir>/extensions/ via jiti (TS is fine), and the
 * `typebox` / pi package imports resolve through pi's own alias map.
 *
 * The Tavily key never reaches the subprocess. Until 2026-09-13 it was
 * injected as TAVILY_API_KEY; now the extension posts the query to the
 * main process's loopback service (PI_STUDIO_MEMORY_URL, authenticated by the
 * per-launch PI_STUDIO_MEMORY_TOKEN) and the main process calls Tavily with
 * the key it keeps in settings. Same principle as the image token: the agent
 * process is the data plane and holds capabilities, not upstream secrets.
 */
export const WEB_SEARCH_ROUTE = '/v1/web-search'

type TavilyResult = { title: string; url: string; content: string }

export async function searchTavily(
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  apiKey = loadSettings().tavilyApiKey,
): Promise<{ results: TavilyResult[] }> {
  const q = query.trim()
  if (!q) throw new Error('query is required')
  if (!apiKey) throw new Error('Tavily key is not configured in pi-studio settings')
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query: q, max_results: 5 }),
    signal,
  })
  if (!response.ok) throw new Error(`Tavily error ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const json = (await response.json()) as { results?: Partial<TavilyResult>[] }
  const results = (json.results ?? [])
    .filter((r): r is TavilyResult => typeof r?.url === 'string')
    .map((r) => ({ title: r.title ?? '', url: r.url, content: (r.content ?? '').slice(0, 400) }))
  return { results }
}

/** 主进程启动时挂到本地服务上;key 只在这里被读。 */
export function registerWebSearchRelay(): void {
  registerLocalRoute(WEB_SEARCH_ROUTE, (input, signal) =>
    searchTavily(typeof input.query === 'string' ? input.query : '', signal),
  )
}

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
      // 搜索经主进程中继:key 在主进程,这里只有每次启动随机的本地 token
      const relay = process.env.PI_STUDIO_MEMORY_URL
      const token = process.env.PI_STUDIO_MEMORY_TOKEN
      if (!relay || !token) throw new Error('pi-studio local relay not available - web search needs the desktop app')
      const response = await fetch(relay + '/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ query: params.query }),
        signal,
      })
      if (!response.ok) throw new Error('web search failed ' + response.status + ': ' + (await response.text()).slice(0, 300))
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

function writeExtension(file: string, enabled: boolean): string | null {
  if (!enabled) {
    if (existsSync(file)) rmSync(file)
    return null
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, EXTENSION_SOURCE, 'utf-8')
  return file
}

/** Write or remove the extension depending on whether a Tavily key is configured. */
export function syncWebSearchExtension(enabled: boolean): string | null {
  return writeExtension(join(agentConfigDir(), 'extensions', 'web-search.ts'), enabled)
}

/** Materialize an explicitly loaded copy outside Pi's auto-discovery directory. */
export function prepareReviewedWebSearchExtension(enabled: boolean): string | null {
  return writeExtension(
    join(agentConfigDir(), 'pi-studio-reviewed-extensions', 'web-search.ts'),
    enabled,
  )
}

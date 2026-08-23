import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * 让 agent 读得到 Codex 留下的会话。
 *
 * 为什么要专门做工具而不是让 agent 自己 grep:会话是 rollout JSONL,
 * 一个 24 MB 的文件里真正的对话文本只有 22 KB —— 其余是 reasoning 轨迹、
 * 工具载荷、每轮重复的 base_instructions 和 world_state。直接 grep 会把
 * 上下文冲垮,还基本搜不到想要的东西。
 *
 * 布局(Codex 0.146):
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时间戳>-<uuid>.jsonl
 *   $CODEX_HOME/history.jsonl   每条用户提问一行 {session_id, ts, text}
 *
 * 注意 session_meta 里 id 和 session_id 不一定相同 —— resume 出来的会话
 * session_id 指向原始线程。两个都建索引,免得按 id 查不到。
 */

const MAX_MESSAGE_CHARS = 2000
const MAX_MATCHES_PER_SESSION = 5
/**
 * 读 meta 时最多扫多少行。session_meta 在第一行,但真正的 model 藏在后面的
 * thread_settings_applied 里(实测中位第 83 行、最晚第 509 行),给够余量即可 ——
 * 全文件扫的话列出 33 个会话就要啃 96 MB。
 */
const META_SCAN_LINES = 600

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

type SessionMeta = {
  file: string
  id: string
  sessionId: string
  cwd: string
  /** thread_settings 里的真实模型;拿不到就是空串 */
  model: string
  /** Codex 自己的审批评估会话:里面的"用户消息"是注入的评估提示,不是真人说的 */
  autoReview: boolean
  startedAt: string
  bytes: number
}

type Turn = { role: 'user' | 'agent'; text: string }

/** 逐行流式读:最大的会话有 24 MB,整个读进内存不合适。 */
async function eachRecord(
  file: string,
  visit: (record: { type?: string; payload?: Record<string, unknown> }) => boolean | void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      let record: { type?: string; payload?: Record<string, unknown> }
      try {
        record = JSON.parse(line)
      } catch {
        continue // 写到一半的行:跳过,不要让整个会话读不出来
      }
      if (visit(record) === false) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function listSessionFiles(): Promise<string[]> {
  const root = join(codexHome(), 'sessions')
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

/** 读会话头:session_meta 在第一行,model 要往后找一点,扫到上限就收手。 */
async function readMeta(file: string): Promise<SessionMeta | null> {
  let meta: SessionMeta | null = null
  let seen = 0
  await eachRecord(file, (record) => {
    seen += 1
    const p = (record.payload ?? {}) as Record<string, unknown>
    if (record.type === 'session_meta') {
      const id = String(p.id ?? '')
      meta = {
        file,
        id,
        sessionId: String(p.session_id ?? id),
        cwd: String(p.cwd ?? ''),
        model: '',
        autoReview: false,
        startedAt: String(p.timestamp ?? ''),
        bytes: statSync(file).size,
      }
      return
    }
    if (meta && p.type === 'thread_settings_applied') {
      const model = String(((p.thread_settings ?? {}) as Record<string, unknown>).model ?? '')
      meta.model = model
      meta.autoReview = model.includes('auto-review')
      return false // 拿到 model 就够了
    }
    if (seen >= META_SCAN_LINES) return false
  })
  return meta
}

/** 从 rollout 里抽出人读得懂的部分:只要 user_message 和 agent_message。 */
async function readTurns(file: string): Promise<Turn[]> {
  const turns: Turn[] = []
  await eachRecord(file, (record) => {
    if (record.type !== 'event_msg') return
    const p = (record.payload ?? {}) as Record<string, unknown>
    const text = typeof p.message === 'string' ? p.message : ''
    if (!text) return
    if (p.type === 'user_message') turns.push({ role: 'user', text })
    else if (p.type === 'agent_message') turns.push({ role: 'agent', text })
  })
  return turns
}

function clip(text: string, limit = MAX_MESSAGE_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…(截断,原文 ${trimmed.length} 字符)`
}

function describe(meta: SessionMeta, firstPrompt?: string): string {
  const date = meta.startedAt ? meta.startedAt.slice(0, 16).replace('T', ' ') : '未知时间'
  const size = meta.bytes > 1024 * 1024 ? `${(meta.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(meta.bytes / 1024)}KB`
  const model = meta.model ? `  ${meta.model}` : ''
  // 审批评估会话里的"用户消息"是 Codex 注入的评估提示,读之前得知道
  const kind = meta.autoReview ? '  [自动审批评估,非真人对话]' : ''
  const head = `${meta.id}  ${date}  ${size}${model}  cwd=${meta.cwd || '?'}${kind}`
  return firstPrompt ? `${head}\n    ${clip(firstPrompt, 120).replace(/\n/g, ' ')}` : head
}

/** history.jsonl:每条用户提问一行,用来给列表补一句"这个会话在聊什么"。 */
function firstPrompts(): Map<string, string> {
  const file = join(codexHome(), 'history.jsonl')
  const map = new Map<string, string>()
  if (!existsSync(file)) return map
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { session_id?: string; text?: string }
      if (entry.session_id && entry.text && !map.has(entry.session_id)) map.set(entry.session_id, entry.text)
    } catch {
      continue
    }
  }
  return map
}

const listParams = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: '最多返回几个会话,默认 30(按时间倒序)' })),
  cwd: Type.Optional(Type.String({ description: '只看工作目录包含这段文本的会话' })),
})

const searchParams = Type.Object({
  query: Type.String({ description: '要找的文本,大小写不敏感' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: '最多返回几个会话,默认 10' })),
})

const readParams = Type.Object({
  sessionId: Type.String({ description: '会话 id(从 list/search 拿)。也接受文件名。' }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: '从第几轮开始,默认 0' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: '读几轮,默认 40' })),
})

async function locate(sessionId: string): Promise<SessionMeta | null> {
  const needle = sessionId.trim()
  for (const file of await listSessionFiles()) {
    if (basename(file).includes(needle)) {
      const meta = await readMeta(file)
      if (meta) return meta
    }
  }
  // 文件名对不上再看 meta —— resume 出来的会话 session_id 与文件名 uuid 不同
  for (const file of await listSessionFiles()) {
    const meta = await readMeta(file)
    if (meta && (meta.id === needle || meta.sessionId === needle)) return meta
  }
  return null
}

const text = (body: string): AgentToolResult<{ codexHome: string }> => ({
  content: [{ type: 'text', text: body }],
  details: { codexHome: codexHome() },
})

export default function piStudioCodexSessions(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'codex_sessions_list',
    label: 'Codex 会话列表',
    description:
      '列出本机 Codex CLI 留下的会话(id、时间、工作目录、体积、开场白)。' +
      '想知道"我之前用 Codex 做过什么"就从这里开始。',
    promptSnippet: 'codex_sessions_list: 列出本机 Codex 会话',
    parameters: listParams,
    async execute(_id: string, params: Static<typeof listParams>): Promise<AgentToolResult<{ codexHome: string }>> {
      const files = await listSessionFiles()
      if (files.length === 0) return text(`没有找到 Codex 会话(找的是 ${join(codexHome(), 'sessions')})`)

      const prompts = firstPrompts()
      const metas: SessionMeta[] = []
      for (const file of files) {
        const meta = await readMeta(file)
        if (!meta) continue
        if (params.cwd && !meta.cwd.includes(params.cwd)) continue
        metas.push(meta)
      }
      metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      const shown = metas.slice(0, params.limit ?? 30)
      const lines = shown.map(
        (meta, i) => `${i + 1}. ${describe(meta, prompts.get(meta.sessionId) ?? prompts.get(meta.id))}`,
      )
      const tail = metas.length > shown.length ? `\n\n(共 ${metas.length} 个,只列了 ${shown.length} 个)` : ''
      return text(`Codex 会话(${join(codexHome(), 'sessions')}):\n\n${lines.join('\n')}${tail}`)
    },
  })

  pi.registerTool({
    name: 'codex_sessions_search',
    label: '搜索 Codex 会话',
    description:
      '在所有 Codex 会话的对话文本里搜关键词,返回命中的会话和片段。' +
      '只搜用户和 agent 的消息,不搜 reasoning 轨迹和工具载荷 —— 那些占了文件 99% 的体积但基本搜不出有用的东西。',
    promptSnippet: 'codex_sessions_search: 在 Codex 历史会话里搜关键词',
    parameters: searchParams,
    async execute(_id: string, params: Static<typeof searchParams>): Promise<AgentToolResult<{ codexHome: string }>> {
      const needle = params.query.trim().toLowerCase()
      if (!needle) return text('query 不能为空')

      const results: string[] = []
      for (const file of await listSessionFiles()) {
        const turns = await readTurns(file)
        const hits = turns.filter((turn) => turn.text.toLowerCase().includes(needle))
        if (hits.length === 0) continue
        const meta = await readMeta(file)
        if (!meta) continue
        const snippets = hits.slice(0, MAX_MATCHES_PER_SESSION).map((hit) => {
          const at = hit.text.toLowerCase().indexOf(needle)
          const from = Math.max(0, at - 120)
          const window = hit.text.slice(from, at + needle.length + 200).replace(/\s+/g, ' ').trim()
          return `    [${hit.role}] …${window}…`
        })
        const more = hits.length > snippets.length ? `\n    (本会话还有 ${hits.length - snippets.length} 处命中)` : ''
        results.push(`${describe(meta)}\n${snippets.join('\n')}${more}`)
        if (results.length >= (params.limit ?? 10)) break
      }
      if (results.length === 0) return text(`没有会话提到「${params.query}」`)
      return text(`命中 ${results.length} 个会话:\n\n${results.join('\n\n')}`)
    },
  })

  pi.registerTool({
    name: 'codex_session_read',
    label: '读 Codex 会话',
    description:
      '把一个 Codex 会话读成可读的对话记录(只保留用户和 agent 的消息)。' +
      '轮次多时用 offset/limit 分页,单条消息过长会截断。',
    promptSnippet: 'codex_session_read: 读出某个 Codex 会话的对话记录',
    parameters: readParams,
    async execute(_id: string, params: Static<typeof readParams>): Promise<AgentToolResult<{ codexHome: string }>> {
      const meta = await locate(params.sessionId)
      if (!meta) return text(`找不到会话 ${params.sessionId} —— 先用 codex_sessions_list 看看有哪些`)

      const turns = await readTurns(meta.file)
      if (turns.length === 0) return text(`${describe(meta)}\n\n这个会话里没有可读的对话消息。`)

      const offset = params.offset ?? 0
      const slice = turns.slice(offset, offset + (params.limit ?? 40))
      const body = slice
        .map((turn, i) => `── ${offset + i + 1}. ${turn.role === 'user' ? '用户' : 'Codex'} ──\n${clip(turn.text)}`)
        .join('\n\n')
      const tail =
        offset + slice.length < turns.length
          ? `\n\n(共 ${turns.length} 轮,已显示 ${offset + 1}–${offset + slice.length};继续读用 offset=${offset + slice.length})`
          : `\n\n(共 ${turns.length} 轮,已读完)`
      return text(`${describe(meta)}\n\n${body}${tail}`)
    },
  })
}

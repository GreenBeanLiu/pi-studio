import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

// resources/ 不在任何 tsconfig 里,内置扩展没有编译期保护。用 pi 自己的 loader
// 真加载真执行,并喂一份合成的 CODEX_HOME —— 不碰用户 ~/.codex 的真实数据。
const LOADER = new URL(
  '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js',
  import.meta.url,
).href
const EXTENSION = fileURLToPath(new URL('../resources/pi-extensions/pi-studio-codex-sessions.ts', import.meta.url))
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

type Tool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

async function tools(): Promise<Map<string, Tool>> {
  const { loadExtensions } = (await import(LOADER)) as {
    loadExtensions: (
      paths: string[],
      cwd: string,
    ) => Promise<{
      extensions: Array<{ tools: Map<string, { definition: Tool }> }>
      errors: Array<{ path: string; error: string }>
    }>
  }
  const result = await loadExtensions([EXTENSION], PROJECT_ROOT)
  expect(result.errors).toEqual([])
  return new Map([...result.extensions[0].tools].map(([name, t]) => [name, t.definition]))
}

const run = async (name: string, params: Record<string, unknown> = {}): Promise<string> => {
  const tool = (await tools()).get(name)
  expect(tool, `tool ${name} missing`).toBeDefined()
  const out = await tool!.execute('t', params, undefined, undefined, { cwd: PROJECT_ROOT })
  return out.content.map((c) => c.text ?? '').join('\n')
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  delete process.env.CODEX_HOME
})

/** 造一个 rollout 文件。noise 用来模拟真实文件里占 99% 体积的 reasoning/工具载荷。 */
function writeSession(
  home: string,
  opts: { id: string; cwd: string; model?: string; turns: Array<[string, string]>; noise?: number },
): void {
  const dir = join(home, 'sessions', '2026', '08', '20')
  mkdirSync(dir, { recursive: true })
  const lines: string[] = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: opts.id, session_id: opts.id, cwd: opts.cwd, timestamp: '2026-08-20T09:00:00.000Z' },
    }),
  ]
  if (opts.model) {
    lines.push(
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: opts.model } } }),
    )
  }
  for (let i = 0; i < (opts.noise ?? 0); i++) {
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: 'x'.repeat(500) } }))
  }
  for (const [role, message] of opts.turns) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: `${role}_message`, message } }))
  }
  writeFileSync(join(dir, `rollout-2026-08-20T09-00-00-${opts.id}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

describe('codex session tools', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    dirs.push(home)
    process.env.CODEX_HOME = home
    writeSession(home, {
      id: 'aaaa-1111',
      cwd: '/Users/me/alpha',
      model: 'gpt-5.6-sol',
      turns: [
        ['user', '帮我修 alpha 项目的登录问题'],
        ['agent', '已经定位到 alpha 的 token 刷新逻辑'],
      ],
      noise: 40,
    })
    writeSession(home, {
      id: 'bbbb-2222',
      cwd: '/Users/me/beta',
      model: 'codex-auto-review',
      turns: [['user', 'The following is the Codex agent history whose request action you are assessing']],
    })
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: 'aaaa-1111', ts: 1, text: '帮我修 alpha 项目的登录问题' }) + '\n',
      'utf8',
    )
  })

  it('lists sessions newest-first with their opening prompt', async () => {
    const out = await run('codex_sessions_list')
    expect(out).toContain('aaaa-1111')
    expect(out).toContain('cwd=/Users/me/alpha')
    expect(out).toContain('帮我修 alpha 项目的登录问题')
  })

  it('flags auto-review sessions, whose "user" turns are injected prompts', async () => {
    const out = await run('codex_sessions_list')
    expect(out).toContain('[自动审批评估,非真人对话]')
    // 真人会话不能被误标
    const alpha = out.split('\n').find((line) => line.includes('aaaa-1111')) ?? ''
    expect(alpha).not.toContain('自动审批评估')
    expect(alpha).toContain('gpt-5.6-sol')
  })

  it('filters by working directory', async () => {
    const out = await run('codex_sessions_list', { cwd: '/Users/me/beta' })
    expect(out).toContain('bbbb-2222')
    expect(out).not.toContain('aaaa-1111')
  })

  it('searches conversation text and shows a snippet', async () => {
    const out = await run('codex_sessions_search', { query: 'token 刷新' })
    expect(out).toContain('aaaa-1111')
    expect(out).toContain('[agent]')
    expect(out).toContain('token 刷新')
  })

  it('does not match the reasoning noise that dominates the file', async () => {
    // 真实会话里 reasoning/工具载荷占 99% 体积;搜到它们只会淹没上下文
    const out = await run('codex_sessions_search', { query: 'xxxxxxxxxx' })
    expect(out).toContain('没有会话提到')
  })

  it('reads a session as a transcript', async () => {
    const out = await run('codex_session_read', { sessionId: 'aaaa-1111' })
    expect(out).toContain('1. 用户')
    expect(out).toContain('2. Codex')
    expect(out).toContain('已经定位到 alpha 的 token 刷新逻辑')
    expect(out).toContain('已读完')
  })

  it('pages long sessions and says how to continue', async () => {
    const out = await run('codex_session_read', { sessionId: 'aaaa-1111', limit: 1 })
    expect(out).toContain('1. 用户')
    expect(out).not.toContain('2. Codex')
    expect(out).toContain('offset=1')
  })

  it('says so plainly when the session is not there', async () => {
    const out = await run('codex_session_read', { sessionId: 'nope' })
    expect(out).toContain('找不到会话')
  })

  it('does not fall over when CODEX_HOME has no sessions', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'codex-empty-'))
    dirs.push(empty)
    process.env.CODEX_HOME = empty
    expect(await run('codex_sessions_list')).toContain('没有找到 Codex 会话')
  })
})

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// resources/ 不在任何 tsconfig 里,内置扩展没有编译期保护。这里用 pi 自己的
// loader 把它加载起来跑一遍:导入写错、schema 写错、SSE 分帧写错都会在这里翻车。
const LOADER = new URL(
  '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js',
  import.meta.url,
).href
const EXTENSION = fileURLToPath(new URL('../resources/pi-extensions/pi-studio-imagegen.ts', import.meta.url))
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

type ToolDefinition = {
  label: string
  parameters: { properties: Record<string, unknown>; required?: string[] }
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>
    details: { urls: string[]; referenceCount: number }
  }>
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

type BeforeAgentStart = (event: {
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  systemPrompt: string
}) => Promise<{ systemPrompt?: string } | undefined> | { systemPrompt?: string } | undefined

type LoadedExtension = {
  tool: ToolDefinition
  beforeAgentStart: BeforeAgentStart
}

async function loadExtension(): Promise<LoadedExtension> {
  const { loadExtensions } = (await import(LOADER)) as {
    loadExtensions: (
      paths: string[],
      cwd: string,
    ) => Promise<{
      extensions: Array<{
        tools: Map<string, { definition: ToolDefinition }>
        handlers: Map<string, BeforeAgentStart[]>
      }>
      errors: Array<{ path: string; error: string }>
    }>
  }
  const result = await loadExtensions([EXTENSION], PROJECT_ROOT)
  expect(result.errors).toEqual([])
  const extension = result.extensions[0]
  const tool = extension?.tools.get('image_gen')
  const handler = extension?.handlers.get('before_agent_start')?.[0]
  expect(tool).toBeDefined()
  expect(handler).toBeDefined()
  return { tool: tool!.definition, beforeAgentStart: handler! }
}

async function loadImageGenTool(): Promise<ToolDefinition> {
  return (await loadExtension()).tool
}

/** 把 SSE 拆成两片发,确保跨 chunk 的 \n\n 分帧没写错。 */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 30))
      controller.enqueue(bytes.slice(30))
      controller.close()
    },
  })
}

type Recorded = { url: string; apiKey: string | null; body?: Record<string, unknown> }

function stubCloud(sse: string): Recorded[] {
  const calls: Recorded[] = []
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url)
    const call: Recorded = { url: href, apiKey: new Headers(init.headers).get('X-API-Key') }
    calls.push(call)

    if (href.endsWith('/imagegen/reference')) {
      call.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return { ok: true, json: async () => ({ url: 'https://r2.example/ref.png' }) }
    }
    if (href.endsWith('/imagegen')) {
      call.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return { ok: true, body: sseBody(sse) }
    }
    if (href.startsWith('https://r2.example/')) {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
      }
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as typeof fetch
  return calls
}

const RESULT_SSE =
  'event: status\ndata: {"stage":"queued"}\n\nevent: result\ndata: {"urls":["https://r2.example/out.png"]}\n\n'

const originalFetch = globalThis.fetch

describe('bundled image_gen extension', () => {
  beforeEach(() => {
    // 相当于主进程 spawn 时注入的那两个变量;末尾斜杠是故意的
    process.env.PI_CLOUD_IMAGE_RELAY = 'https://relay.example/'
    process.env.PI_CLOUD_IMAGE_KEY = 'test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.PI_CLOUD_IMAGE_RELAY
    delete process.env.PI_CLOUD_IMAGE_KEY
  })

  it('loads through pi and registers image_gen with prompt required', async () => {
    const tool = await loadImageGenTool()
    expect(Object.keys(tool.parameters.properties)).toEqual([
      'prompt',
      'size',
      'quality',
      'background',
      'n',
      'referencePaths',
    ])
    expect(tool.parameters.required).toEqual(['prompt'])
    // 尺寸要和生图页一致,不能只剩三档
    const size = tool.parameters.properties.size as { anyOf: { const: string }[] }
    expect(size.anyOf.map((option) => option.const)).toEqual([
      '256x256',
      '512x512',
      '1024x1024',
      '1024x1536',
      '1536x1024',
      '1024x1792',
      '1792x1024',
      'auto',
    ])
  })

  it('forwards transparency and quality as real parameters, not prompt begging', async () => {
    const calls = stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()
    await tool.execute(
      'call-1',
      { prompt: '图标', size: '1024x1024', background: 'transparent', quality: 'high' },
      undefined,
      undefined,
      { cwd: PROJECT_ROOT },
    )

    expect(calls[0].body).toMatchObject({
      prompt: '图标',
      size: '1024x1024',
      background: 'transparent',
      quality: 'high',
    })
  })

  it('omits the optional knobs the agent did not set', async () => {
    const calls = stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()
    await tool.execute('call-1', { prompt: '猫' }, undefined, undefined, { cwd: PROJECT_ROOT })

    // 没传就别塞进 body,交给服务端的默认值
    expect(calls[0].body).not.toHaveProperty('quality')
    expect(calls[0].body).not.toHaveProperty('background')
    expect(calls[0].body).not.toHaveProperty('n')
  })

  it('brings back every image when the agent asks for several', async () => {
    const calls = stubCloud(
      'event: result\ndata: {"urls":["https://r2.example/a.png","https://r2.example/b.png"]}\n\n',
    )
    const tool = await loadImageGenTool()

    const result = await tool.execute('call-1', { prompt: '猫', n: 2 }, undefined, undefined, {
      cwd: PROJECT_ROOT,
    })

    expect(calls[0].body).toMatchObject({ n: 2 })
    // 两张图都得回给模型,否则它没法挑
    expect(result.content.map((c) => c.type)).toEqual(['image', 'image', 'text'])
    expect(result.content[2].text).toContain('https://r2.example/a.png')
    expect(result.content[2].text).toContain('https://r2.example/b.png')
    expect(result.details).toEqual({
      urls: ['https://r2.example/a.png', 'https://r2.example/b.png'],
      referenceCount: 0,
    })
  })

  it('keeps n = 1 on the single-image shape', async () => {
    stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()
    const result = await tool.execute('call-1', { prompt: '猫', n: 1 }, undefined, undefined, {
      cwd: PROJECT_ROOT,
    })

    expect(result.content.map((c) => c.type)).toEqual(['image', 'text'])
    expect(result.content[1].text).toBe('已生成图片:https://r2.example/out.png')
  })

  it('returns the image itself so both the model and the card can see it', async () => {
    const calls = stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()

    const result = await tool.execute('call-1', { prompt: '加班到深夜的猫' }, undefined, undefined, {
      cwd: PROJECT_ROOT,
    })

    expect(result.content.map((c) => c.type)).toEqual(['image', 'text'])
    expect(result.content[0].mimeType).toBe('image/png')
    expect(result.content[0].data).toBe(PNG.toString('base64'))
    expect(result.content[1].text).toContain('https://r2.example/out.png')
    expect(result.details).toEqual({ urls: ['https://r2.example/out.png'], referenceCount: 0 })
    expect(calls.map((c) => c.url)).toEqual([
      // relay 末尾的斜杠要被去掉,否则是 //imagegen
      'https://relay.example/imagegen',
      'https://r2.example/out.png',
    ])
  })

  it('authenticates with the injected key and defaults to a square', async () => {
    const calls = stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()
    await tool.execute('call-1', { prompt: '猫' }, undefined, undefined, { cwd: PROJECT_ROOT })

    expect(calls[0].apiKey).toBe('test-key')
    expect(calls[0].body).toMatchObject({ prompt: '猫', size: '1024x1024' })
    expect(calls[0].body?.batchId).toEqual(expect.any(String))
    // 参考图为空时不能把 referenceUrls 塞进去
    expect(calls[0].body).not.toHaveProperty('referenceUrls')
  })

  it('surfaces the cloud error event instead of hanging', async () => {
    stubCloud('event: error\ndata: {"message":"上游额度不足"}\n\n')
    const tool = await loadImageGenTool()

    await expect(
      tool.execute('call-1', { prompt: '猫' }, undefined, undefined, { cwd: PROJECT_ROOT }),
    ).rejects.toThrow('上游额度不足')
  })

  it('refuses to call the relay when the desktop never injected credentials', async () => {
    delete process.env.PI_CLOUD_IMAGE_KEY
    const calls = stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()

    await expect(
      tool.execute('call-1', { prompt: '猫' }, undefined, undefined, { cwd: PROJECT_ROOT }),
    ).rejects.toThrow('云端图像服务未配置')
    expect(calls).toEqual([])
  })

  it('rejects a reference image it cannot type instead of uploading garbage', async () => {
    stubCloud(RESULT_SSE)
    const tool = await loadImageGenTool()

    await expect(
      tool.execute('call-1', { prompt: '猫', referencePaths: ['notes.txt'] }, undefined, undefined, {
        cwd: PROJECT_ROOT,
      }),
    ).rejects.toThrow('参考图格式不支持')
  })
})

// 粘贴进对话的图只存在于消息里,工具够不着(base64 塞不进工具参数)。
// before_agent_start 是唯一能同时看见 images 和系统提示的地方。
describe('pasted image bridge', () => {
  const PASTED_DIR = join(tmpdir(), 'pi-studio-pasted')

  beforeEach(() => {
    rmSync(PASTED_DIR, { recursive: true, force: true })
    process.env.PI_CLOUD_IMAGE_RELAY = 'https://relay.example/'
    process.env.PI_CLOUD_IMAGE_KEY = 'test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(PASTED_DIR, { recursive: true, force: true })
    delete process.env.PI_CLOUD_IMAGE_RELAY
    delete process.env.PI_CLOUD_IMAGE_KEY
  })

  it('stays out of the way when the turn has no images', async () => {
    const { beforeAgentStart } = await loadExtension()
    const result = await beforeAgentStart({ systemPrompt: 'base' })

    expect(result).toBeUndefined()
    expect(existsSync(PASTED_DIR)).toBe(false)
  })

  it('writes pasted images to disk and tells the model where they are', async () => {
    const { beforeAgentStart } = await loadExtension()

    const result = await beforeAgentStart({
      systemPrompt: 'base prompt',
      images: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    })

    const systemPrompt = result?.systemPrompt ?? ''
    // 原系统提示必须保留 —— 这是"追加"不是"替换"
    expect(systemPrompt.startsWith('base prompt')).toBe(true)
    expect(systemPrompt).toContain('referencePaths')

    const written = /^- (.+)$/m.exec(systemPrompt)?.[1] ?? ''
    expect(written.startsWith(PASTED_DIR)).toBe(true)
    // 落盘的必须是原字节,不是被 base64 二次编码过的东西
    expect(readFileSync(written).equals(PNG)).toBe(true)
  })

  it('skips an image whose mime type it cannot write, without failing the turn', async () => {
    const { beforeAgentStart } = await loadExtension()

    const result = await beforeAgentStart({
      systemPrompt: 'base',
      images: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/tiff' }],
    })

    // 一张都没写成 → 不动系统提示,模型仍然直接看得见那张图
    expect(result).toBeUndefined()
  })

  it('feeds a stashed path straight back through referencePaths', async () => {
    const calls = stubCloud(RESULT_SSE)
    const { tool, beforeAgentStart } = await loadExtension()

    const stashed = await beforeAgentStart({
      systemPrompt: 'base',
      images: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    })
    const path = /^- (.+)$/m.exec(stashed?.systemPrompt ?? '')?.[1] ?? ''

    await tool.execute('call-1', { prompt: '做成表情包', referencePaths: [path] }, undefined, undefined, {
      cwd: PROJECT_ROOT,
    })

    expect(calls[0].url).toBe('https://relay.example/imagegen/reference')
    expect(calls[0].body).toMatchObject({ content_type: 'image/png', image_base64: PNG.toString('base64') })
    expect(calls[1].body).toMatchObject({ referenceUrls: ['https://r2.example/ref.png'] })
  })
})

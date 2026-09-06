import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 2026-09-06:Mac 上设置页「云端模型线路」一直报 `fetch failed`,而终端里 curl 打同一个
 * 地址是 200 —— 看着像后端挂了,其实是**这台机器只能经系统代理访问那个域名**,直连连
 * DNS 都解析不了。终端通是因为 shell 里有 HTTPS_PROXY;Finder 启动的 app 一个 shell
 * 环境变量都没有,而 Node 的全局 fetch(undici)只认环境变量、不读系统代理。
 *
 * 报错 `fetch failed` 不带 URL 也不带 cause,零指向性 —— 所以这条必须钉在源码上:
 * 主进程里打云端的模块不许用全局 fetch,一律走 cloud-fetch 的 net.fetch(Chromium
 * 网络栈,原生读系统代理)。
 */
const CLOUD_MODULES = ['llm-gateway.ts', 'cloud-media.ts', 'vision-review.ts', 'model3d.ts']

describe('主进程打云端必须走 net.fetch,不能用全局 fetch', () => {
  it('cloud-fetch 这层壳确实用的是 electron net', () => {
    const shim = read('./cloud-fetch.ts')
    expect(shim).toContain("from 'electron'")
    expect(shim).toContain('net.fetch')
  })

  for (const name of CLOUD_MODULES) {
    it(`${name} 不再直接调全局 fetch`, () => {
      const source = read(`./${name}`)
      // 只看真正的调用点,注释里提到 fetch 不算
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      const bare = code.match(/(?<![.\w])fetch\s*\(/g) ?? []
      expect(bare, `${name} 里还有 ${bare.length} 处裸 fetch(`).toHaveLength(0)
      expect(code).toMatch(/from '\.\/cloud-fetch'/)
    })
  }

  it('model3d 里打绝对 URL 的地方没有被本地那个会拼中继地址的 helper 接管', () => {
    // model3d 自己有个叫 cloudFetch 的 helper,会给路径前面拼 cloud.relay 并塞 API key。
    // download()/urlToDataUrl() 拿到的是 R2 绝对链接,走那个 helper 会拼出一个坏 URL,
    // 所以它们必须用别名 netFetch。这条就是防止 import 名字撞车时悄悄绑错。
    const source = read('./model3d.ts')
    expect(source).toContain("import { cloudFetch as netFetch } from './cloud-fetch'")
    expect(source).toMatch(/netFetch\(url,/)
  })
})

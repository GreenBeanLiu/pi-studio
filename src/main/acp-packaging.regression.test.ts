import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))
}

const appPackage = readJson('../../package.json')
const sdkPackage = readJson('../../node_modules/@agentclientprotocol/sdk/package.json')

const dependencies = (appPackage.dependencies ?? {}) as Record<string, string>

// 2026-08-25:打好的 Mac 包一启动就崩:
//   Cannot find package 'zod' imported from
//   .../node_modules/@agentclientprotocol/sdk/dist/schema-deserialize.js
//
// zod 是 ACP SDK 的 peerDependency。pnpm 不会把 peer 提到顶层 node_modules,
// 开发和测试时 Node 能顺着 .pnpm 的虚拟 store 解析到,所以一路都是绿的 ——
// 但 electron-builder 只拷贝顶层能看见的那些包,peer 就丢了。
//
// typecheck、lint、测试、构建全过也挡不住这一类:它只在装好的包里炸。
describe('ACP SDK 的 peer 依赖必须是我们自己的直接依赖', () => {
  const peers = Object.keys((sdkPackage.peerDependencies ?? {}) as Record<string, string>)

  it('SDK 确实声明了 peer 依赖(这条断言本身别悄悄失效)', () => {
    expect(peers.length).toBeGreaterThan(0)
  })

  for (const peer of peers) {
    it(`${peer} 在 package.json 的 dependencies 里`, () => {
      expect(dependencies[peer]).toBeTruthy()
    })
  }

  // 顶层装出来的实际版本要满足 SDK 声明的范围,否则运行时行为对不上。
  it('顶层装的 zod 版本能满足 SDK 的要求', () => {
    const range = (sdkPackage.peerDependencies as Record<string, string>).zod
    expect(range).toBeTruthy()
    const installed = readJson('../../node_modules/zod/package.json').version as string
    expect(installed.split('.')[0]).toBe('4')
    expect(range).toContain('4.0.0')
  })
})

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/**
 * 2026-09-06 打开了 asar(之前是 false)。这几条钉的是"打开之后不能再犯的错" ——
 * 全都属于四个 gate 拦不住、只在装好的包里才炸的那一类。
 *
 * 背景:asar 最初被关掉(ad0d4f5, 7/03)是因为当时 spawn 的是**系统 node**,读不了
 * 归档内部。十天后(6000b13, 7/13)运行时换成了内嵌 Electron + ELECTRON_RUN_AS_NODE,
 * 那个理由就失效了,只是没人回头重新评估。2026-09-06 逐项实测确认:
 *
 *   readdirSync / statSync / copyFileSync / readFileSync   asar 上正常
 *   ESM import(file:// URL,两种运行模式)                  正常
 *   外部进程 require asar 内的 cli.js                       正常(系统 node 才 ENOTDIR)
 *   cpSync({ recursive: true })                            **ENOENT,不可用**
 */
describe('asar 打开后的打包约束', () => {
  const pkg = JSON.parse(read('package.json')) as {
    build?: { asar?: boolean; asarUnpack?: string[] }
  }

  it('asar 是开着的', () => {
    expect(pkg.build?.asar).toBe(true)
  })

  it('不能把 pi-coding-agent 单独解包出去', () => {
    // 反直觉但实测过:2026-09-06 曾把它加进 asarUnpack("外部进程跑的东西解出来更稳"),
    // 结果装好的包里 agent 引擎起不来 ——
    //   Cannot find package 'cross-spawn' imported from
    //     app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js
    // 因为解包只搬了这个包,它的依赖仍在归档里,而 Node 的 ESM 解析器从
    // app.asar.unpacked/ 往上找 node_modules 时**不会回退进 app.asar**。
    //
    // 全留在归档里反而是对的:同日用一个最小 asar 实测,ELECTRON_RUN_AS_NODE
    // 从归档内部解析裸包名(import 'fakedep')成功。要解包就得连整个依赖闭包一起解,
    // 那等于没开 asar。
    const patterns = pkg.build?.asarUnpack ?? []
    expect(patterns).toHaveLength(0)
  })

  it('同步内置资源不能用 cpSync 的目录递归', () => {
    // Electron 的 asar 补丁包装了 cpSync 却没实现目录递归 —— 主进程和
    // ELECTRON_RUN_AS_NODE 两种模式下都返回 ENOENT。用回它 = 装好的包里
    // skills/extensions 静默同步失败,而所有测试依然是绿的。
    const source = read('src/main/bundled-agent-resources.ts')
    // 查导入而不是查全文 —— 文件里的注释本来就要提到 cpSync 解释为什么不能用它
    const importLine = source.split('\n').find((line) => line.includes("from 'fs'")) ?? ''
    expect(importLine, 'cpSync 不该再从 fs 导入').not.toContain('cpSync')
    expect(source).toContain('function copyTree(')
    expect(source).toContain('copyFileSync')
  })

  it('copyTree 只用在 asar 上验证过的原语', () => {
    const source = read('src/main/bundled-agent-resources.ts')
    const body = source.slice(source.indexOf('function copyTree('), source.indexOf('function syncBundledDir('))
    // 这三个是实测过能在归档里工作的;换成别的(比如 opendirSync、glob)得先自己实测
    for (const primitive of ['readdirSync', 'statSync', 'copyFileSync']) {
      expect(body, `copyTree 应当只靠 ${primitive} 这类已验证原语`).toContain(primitive)
    }
  })
})

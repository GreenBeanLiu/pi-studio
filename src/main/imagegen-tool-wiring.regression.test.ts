import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runtimeConfig = readFileSync(new URL('./agent-runtime-config.ts', import.meta.url), 'utf8')
const bundledResources = readFileSync(new URL('./bundled-agent-resources.ts', import.meta.url), 'utf8')
const mainIndex = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { build: { files: string[] } }

// 2026-08-21: 对话里没法让 agent 生图 —— 生图只有 ipcMain 通道(renderer→main),
// agent 是另一个进程,够不着。改法:内置一个注册 image_gen 工具的 pi 扩展。
// 扩展本身的行为由 tests/imagegen-extension.test.ts 真跑一遍;这里只钉住
// 三处"跑不到但一坏就整个失效"的宿主接线。
describe('image_gen host wiring', () => {
  it('hands the agent process a scoped image token as env, never the admin key', () => {
    // 盘上那份 key 是 safeStorage 加密的,不能为了让扩展能用就写明文出来
    expect(runtimeConfig).toContain('PI_CLOUD_IMAGE_RELAY: cloud.relay')
    expect(runtimeConfig).toContain('PI_STUDIO_IMAGE_TOKEN: catalog.imageToken')
    // 2026-09-13 之前这里注入的是 cloud.key —— 后端的管理员主密钥(能改 LLM 线路的
    // base_url、签 chat token、读日志)。agent 是数据面,只能拿一张出图票。
    const code = runtimeConfig.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('PI_CLOUD_IMAGE_KEY')
    expect(code).not.toMatch(/cloud\.key/)
    // 云端没配置、或这次没换到票时不注入:空票打过去只换来 401,不如让扩展报"未配置"
    expect(runtimeConfig).toContain('cloud.available && catalog.imageToken')
  })

  it('syncs the bundled extension into the agent config dir on startup', () => {
    expect(bundledResources).toContain("syncBundledDir('pi-extensions', 'extensions'")
    expect(mainIndex).toContain('syncBundledExtensions()')
  })

  it('ships the extension in the installer', () => {
    // electron-builder 只打包列进 files 的目录,漏了装机版会静默少掉这个工具
    expect(packageJson.build.files).toContain('resources/pi-extensions/**')
  })
})

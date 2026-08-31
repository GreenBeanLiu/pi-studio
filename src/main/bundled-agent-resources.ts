import { app } from 'electron'
import { join } from 'path'
import { cpSync, existsSync, readdirSync, rmSync } from 'fs'
import { agentConfigDir } from './settings'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 把随应用发布的 agent 资源(resources/pi-skills、resources/pi-extensions)同步进
 * app 私有 agent 配置目录。pi 从 <agentDir>/skills/ 发现 SKILL.md、从
 * <agentDir>/extensions/ 发现扩展文件,聊天与工作流的所有 agent 会话因此都能用。
 * 每次启动整个覆盖,保持与应用版本一致。
 *
 * 当前内置:
 * - skill  object-to-threejs-procedural(参考图→程序化 three.js 建模,
 *   改编自 vinhhien112/Three.js-Object-Sculptor-Codex-Plugin,MIT)
 * - skill  interface-review
 * - skill  gpt-image-2-style-library(gpt-image-2 出图选型与提示词,
 *   模板元数据改编自 freestylefly/awesome-gpt-image-2,MIT)
 * - 扩展   pi-studio-imagegen(云端生图工具,凭据走 spawn 环境变量)
 */
function syncBundledDir(sourceName: string, destName: string, logTag: string): void {
  // asar 已禁用,dev 与打包环境下 getAppPath() 都指向含 resources/ 的应用根
  const src = join(app.getAppPath(), 'resources', sourceName)
  if (!existsSync(src)) {
    appendAppLog('warn', logTag, `内置 ${destName} 目录缺失,跳过同步`, { src })
    return
  }
  const destRoot = join(agentConfigDir(), destName)
  // 只覆盖内置的同名条目,不动用户手动放进去的其他内容
  for (const name of readdirSync(src)) {
    try {
      const dest = join(destRoot, name)
      rmSync(dest, { recursive: true, force: true })
      cpSync(join(src, name), dest, { recursive: true })
    } catch (err) {
      appendAppLog('error', logTag, `内置 ${destName} 同步失败: ${name}`, normalizeError(err))
    }
  }
}

export function syncBundledSkills(): void {
  syncBundledDir('pi-skills', 'skills', 'skills.sync')
}

/**
 * 内置扩展。注意 syncSubagentWorkflow 也往 <agentDir>/extensions/ 写(subagent/),
 * 两边按条目名各管各的,不会互相覆盖。
 */
export function syncBundledExtensions(): void {
  syncBundledDir('pi-extensions', 'extensions', 'extensions.sync')
}

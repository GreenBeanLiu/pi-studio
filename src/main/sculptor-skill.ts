import { app } from 'electron'
import { join } from 'path'
import { cpSync, existsSync, readdirSync, rmSync } from 'fs'
import { agentConfigDir } from './settings'
import { appendAppLog, normalizeError } from './app-log'

/**
 * 把内置的 pi skill(resources/pi-skills/*)同步进 app 私有 agent 配置目录。
 * pi 从 <agentDir>/skills/ 发现 SKILL.md(agentskills.io 约定)并注入系统提示,
 * 聊天与工作流的所有 agent 会话因此都能用。每次启动整目录覆盖,保持与应用版本一致。
 * 当前内置:object-to-threejs-procedural(参考图→程序化 three.js 建模,
 * 改编自 vinhhien112/Three.js-Object-Sculptor-Codex-Plugin,MIT)。
 */
export function syncBundledSkills(): void {
  // asar 已禁用,dev 与打包环境下 getAppPath() 都指向含 resources/ 的应用根
  const src = join(app.getAppPath(), 'resources', 'pi-skills')
  if (!existsSync(src)) {
    appendAppLog('warn', 'skills.sync', '内置 skill 目录缺失,跳过同步', { src })
    return
  }
  const destRoot = join(agentConfigDir(), 'skills')
  // 只覆盖内置的同名子目录,不动用户手动放进 skills/ 的其他内容
  for (const name of readdirSync(src)) {
    try {
      const dest = join(destRoot, name)
      rmSync(dest, { recursive: true, force: true })
      cpSync(join(src, name), dest, { recursive: true })
    } catch (err) {
      appendAppLog('error', 'skills.sync', `内置 skill 同步失败: ${name}`, normalizeError(err))
    }
  }
}

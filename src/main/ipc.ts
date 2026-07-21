import { ipcMain, BrowserWindow, app, clipboard, dialog, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { ImageContent } from '@earendil-works/pi-ai'
import {
  listSessions,
  deleteSession,
  buildSessionExport,
  type SessionExportFormat,
} from './pi-sessions'
import { syncWebSearchExtension } from './web-search-extension'
import {
  loadSettings,
  saveSettings,
  saveRemoteEnabled,
  addRecentWorkspace,
  removeRecentWorkspace,
  saveSelectedModelRoute,
  type PiProvider,
} from './settings'
import { piClientManager, resolvePiCliPath, type AgentStatusEvent } from './pi-client'
import { syncSecurityGuardExtension } from './security-guard-extension'
import { syncSubagentWorkflow } from './subagent-workflow'
import {
  acceptGitRunChanges,
  beginGitRunChanges,
  discardGitChanges,
  emptyGitDiffSnapshot,
  getGitDiffSnapshot,
  isGitWorkspace,
  sealGitRunChanges,
} from './git-diff'
import { listProviderModels, testProviderConnection } from './provider-test'
import { appendAppLog, normalizeError, readRecentAppLog } from './app-log'
import {
  loadWorkspaceMemory,
  saveWorkspaceMemory,
  syncWorkspaceMemoryExtension,
} from './workspace-memory'
import {
  appendSecurityPolicyRule,
  loadSecurityPolicy,
  saveSecurityPolicy,
  type SecurityPolicy,
  type SecurityPolicyRuleTarget,
} from './security-policy'
import { registerImageGenHandlers } from './image-gen'
import { getCloudConnection } from './cloud-connection'
import { ModelCatalogCoordinator } from './model-catalog'
import { parseLlmProfileSavePayload } from './ipc-contracts'
import { oneOf, parseSessionPath, parseSettingsSave, requiredString } from '../shared/ipc/validators'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const QUEUE_MODES = ['all', 'one-at-a-time'] as const
import { prepareAgentRuntime } from './agent-runtime-config'
import { registerRoutines } from './routines'
import { registerChannels } from './channels'
import { registerSandbox } from './sandbox'
import { registerModel3d } from './model3d'
import { registerCodeModel } from './code-model'
import { registerBlenderModel } from './blender-model'
import { remoteControl } from './remote-control'
import { createSettingsView } from './settings-view'

export function registerIpcHandlers(): void {
  registerImageGenHandlers()
  registerRoutines()
  registerChannels()
  registerSandbox()
  registerModel3d()
  registerCodeModel()
  registerBlenderModel()

  // 远程控制:状态变化广播给所有窗口(设置页实时更新)
  remoteControl.setStatusListener((snap) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('remote:status', snap)
    }
  })
  ipcMain.handle('remote:getStatus', () => remoteControl.snapshot())
  ipcMain.handle('remote:setEnabled', async (_e, enabled: boolean) => {
    saveRemoteEnabled(enabled)
    if (enabled) await remoteControl.enable()
    else remoteControl.disable()
    return remoteControl.snapshot()
  })
  ipcMain.handle('remote:generatePairingCode', () => remoteControl.generatePairingCode())

  const sendAgentStatus = (win: BrowserWindow | null, event: AgentStatusEvent): void => {
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:status', event)
  }

  const sealRunChanges = async (workspacePath: string, reason: string): Promise<void> => {
    try {
      await sealGitRunChanges(workspacePath)
    } catch (err) {
      appendAppLog('warn', 'git.runChanges', 'Failed to seal agent run changes', {
        workspacePath,
        reason,
        rollbackDisabled: true,
        error: normalizeError(err),
      })
    }
  }

  const notifySettingsChanged = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed')
    }
  }

  const modelCatalog = new ModelCatalogCoordinator(undefined, notifySettingsChanged)

  // ── Window controls ──────────────────────────────────────────────
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // Taskbar flash for "agent finished while unfocused"; cleared on focus.
  ipcMain.on('win:flash', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed() || win.isFocused()) return
    win.flashFrame(true)
    win.once('focus', () => win.flashFrame(false))
  })

  // ── App ──────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('clipboard:writeText', (_event, value: unknown) => {
    if (typeof value !== 'string') throw new TypeError('clipboard text must be a string')
    clipboard.writeText(value)
  })
  // 底层 pi 引擎(@earendil-works/pi-coding-agent)的版本 —— pi-studio 基于它开发
  ipcMain.handle('app:piVersion', () => {
    try {
      // resolvePiCliPath() → .../pi-coding-agent/dist/cli.js;上两级是包根
      const pkg = join(dirname(dirname(resolvePiCliPath())), 'package.json')
      return (JSON.parse(readFileSync(pkg, 'utf8')).version as string) || ''
    } catch {
      return ''
    }
  })
  ipcMain.handle('diagnostics:getLogs', () => ({ ok: true, content: readRecentAppLog() }))
  ipcMain.handle(
    'diagnostics:save',
    async (
      event,
      payload: {
        defaultPath: string
        content: string
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: '导出诊断包',
        defaultPath: payload.defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })

      if (result.canceled || !result.filePath) return { cancelled: true }

      try {
        writeFileSync(result.filePath, payload.content, 'utf-8')
        appendAppLog('info', 'diagnostics', 'Diagnostics bundle exported', {
          path: result.filePath,
        })
        return { ok: true, path: result.filePath }
      } catch (err) {
        appendAppLog('error', 'diagnostics', 'Diagnostics bundle export failed', normalizeError(err))
        return { error: (err as Error).message ?? '导出诊断包失败' }
      }
    },
  )

  // ── Settings ────────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => {
    const settings = loadSettings()
    return createSettingsView(settings, getCloudConnection().available)
  })
  ipcMain.handle(
    'settings:save',
    (
      _e,
      payload: unknown,
    ) => {
      // 原来直接 ...settings 落盘:多余字段被持久化,非字符串的
      // cloudImageKey 会在 .trim() 上崩掉 handler
      const settings = parseSettingsSave(payload)
      const current = loadSettings()
      const sandboxWas = current.sandboxEnabled
      saveSettings({
        ...settings,
        cloudImageKey: settings.clearCloudImageKey
          ? ''
          : settings.cloudImageKey.trim() || current.cloudImageKey,
      })
      // 通知所有窗口设置已变,让聊天页模型切换器等即时同步(无需重开工作区)
      notifySettingsChanged()
      // 沙箱开关变化时旧 agent 子进程还跑在旧模式里——告知渲染进程触发工作区重启
      const sandboxChanged = sandboxWas !== settings.sandboxEnabled
      return {
        ok: true,
        sandboxChanged,
        workspaceOpen: sandboxChanged && !!piClientManager.getWorkspacePath(),
      }
    },
  )
  ipcMain.handle('llmProfiles:list', async () => {
    try {
      return { ok: true, profiles: await modelCatalog.listProfiles() }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('modelCatalog:loadProviderLabels', async () => {
    try {
      return { ok: true, view: await modelCatalog.loadProviderLabels() }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('modelCatalog:reconcileFavoriteRoutes', async () => {
    try {
      return { ok: true, ...(await modelCatalog.reconcileFavoriteRoutes()) }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle(
    'llmProfiles:save',
    async (_event, payload: unknown) => {
      try {
        const result = await modelCatalog.saveProfile(parseLlmProfileSavePayload(payload))
        return { ok: true, profile: result.profile, warning: result.warning }
      } catch (err) {
        return { error: (err as Error).message ?? String(err) }
      }
    },
  )
  ipcMain.handle('llmProfiles:delete', async (_event, id: string) => {
    try {
      return { ok: true, ...(await modelCatalog.deleteProfile(id)) }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })
  ipcMain.handle('llmProfiles:refreshModels', async (_event, id: string) => {
    try {
      const result = await modelCatalog.refreshProfileModels(id)
      return { ok: true, profile: result.profile, warning: result.warning }
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
  })

  ipcMain.handle(
    'settings:testConnection',
    (
      _e,
      settings: {
        provider: PiProvider
        apiKey: string
        model: string
        baseUrl: string
      },
    ) => testProviderConnection(settings),
  )
  ipcMain.handle(
    'settings:listModels',
    (
      _e,
      settings: {
        provider: PiProvider
        apiKey: string
        model: string
        baseUrl: string
      },
    ) => listProviderModels(settings),
  )

  ipcMain.handle('securityPolicy:load', () => {
    return loadSecurityPolicy(piClientManager.getWorkspacePath())
  })
  ipcMain.handle('securityPolicy:save', (_e, policy: SecurityPolicy) => {
    try {
      const result = saveSecurityPolicy(policy, piClientManager.getWorkspacePath())
      appendAppLog('info', 'security.policy', 'Security policy saved', {
        scope: result.scope,
        workspacePath: result.workspacePath,
      })
      return { ok: true, ...result }
    } catch (err) {
      appendAppLog('error', 'security.policy', 'Failed to save security policy', normalizeError(err))
      return { error: (err as Error).message ?? '保存安全策略失败' }
    }
  })
  ipcMain.handle(
    'securityPolicy:addRule',
    (_e, payload: { target: SecurityPolicyRuleTarget; rule: string }) => {
      try {
        const result = appendSecurityPolicyRule(
          payload.target,
          payload.rule,
          piClientManager.getWorkspacePath(),
        )
        appendAppLog('info', 'security.policy', 'Security policy rule added', {
          scope: result.scope,
          workspacePath: result.workspacePath,
          target: payload.target,
          rule: payload.rule,
        })
        return { ok: true, ...result }
      } catch (err) {
        appendAppLog('error', 'security.policy', 'Failed to add security policy rule', normalizeError(err))
        return { error: (err as Error).message ?? '添加安全策略规则失败' }
      }
    },
  )

  // ── Workspaces ───────────────────────────────────────────────────
  ipcMain.handle('workspace:list', () => loadSettings().recentWorkspaces)

  ipcMain.handle('workspace:pickDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:open', async (event, workspacePath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const settings = loadSettings()

    let runtime
    try {
      runtime = await prepareAgentRuntime()
    } catch (err) {
      return { error: (err as Error).message ?? String(err) }
    }
    syncWebSearchExtension(!!settings.tavilyApiKey)
    // 安全策略 UI 已移除(隔离交给沙箱):固定卸载 securityGuard 扩展,老装机残留的也清掉
    syncSecurityGuardExtension(false)
    syncWorkspaceMemoryExtension()
    try {
      syncSubagentWorkflow(settings.subagentsEnabled)
    } catch (err) {
      appendAppLog('warn', 'workspace.open', 'Failed to sync subagent workflow', normalizeError(err))
      console.warn('Failed to sync pi-studio subagent workflow:', err)
    }

    try {
      await piClientManager.startWorkspace(
        workspacePath,
        runtime.env,
        runtime.provider,
        runtime.model,
        async (agentEvent) => {
          if (agentEvent.type === 'agent_end') {
            await sealRunChanges(workspacePath, 'agent ended')
          }
          if (win && !win.isDestroyed()) win.webContents.send('pi:event', agentEvent)
          // 远程控制开启时,把 agent 事件也转发给手机(controller)
          remoteControl.forwardEvent(agentEvent)
        },
        (statusEvent) => {
          if (statusEvent.status === 'started') {
            sendAgentStatus(win, statusEvent)
            return
          }
          void sealRunChanges(statusEvent.cwd, `agent ${statusEvent.status}`).then(() => {
            sendAgentStatus(win, statusEvent)
          })
        },
        async (stoppedWorkspacePath) => {
          await sealRunChanges(stoppedWorkspacePath, 'workspace replaced')
        },
      )
    } catch (err) {
      appendAppLog('error', 'workspace.open', 'Failed to start workspace', {
        workspacePath,
        error: normalizeError(err),
      })
      return { error: (err as Error).message ?? '启动工作区失败' }
    }

    const recentWorkspaces = addRecentWorkspace(workspacePath)
    appendAppLog('info', 'workspace.open', 'Workspace opened', { workspacePath })
    return { ok: true, recentWorkspaces }
  })

  ipcMain.handle('workspace:remove', (_e, workspacePath: string) => {
    return removeRecentWorkspace(workspacePath)
  })

  // ── Workspace memory ───────────────────────────────────────────
  ipcMain.handle('memory:load', () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      return { ok: true, memory: loadWorkspaceMemory(cwd) }
    } catch (err) {
      appendAppLog('error', 'memory.load', 'Failed to load workspace memory', normalizeError(err))
      return { error: (err as Error).message ?? '读取 Workspace Memory 失败' }
    }
  })
  ipcMain.handle('memory:save', (_e, content: string) => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      const memory = saveWorkspaceMemory(cwd, content)
      appendAppLog('info', 'memory.save', 'Workspace memory saved', { path: memory.path })
      return { ok: true, memory }
    } catch (err) {
      appendAppLog('error', 'memory.save', 'Failed to save workspace memory', normalizeError(err))
      return { error: (err as Error).message ?? '保存 Workspace Memory 失败' }
    }
  })

  // ── Sessions ─────────────────────────────────────────────────────
  ipcMain.handle('sessions:list', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return []
    const state = await piClientManager.getState()
    if (!state.sessionFile) return []
    return listSessions(dirname(state.sessionFile), cwd)
  })
  ipcMain.handle('sessions:switch', async (_e, sessionPath: unknown) => {
    const state = await piClientManager.getState()
    if (!state.sessionFile) return { cancelled: true }
    try {
      return await piClientManager.switchSession(
        parseSessionPath(sessionPath, dirname(state.sessionFile)),
      )
    } catch (err) {
      appendAppLog('warn', 'ipc.contract', 'Rejected sessions:switch', normalizeError(err))
      return { cancelled: true }
    }
  })
  ipcMain.handle('sessions:rename', (_e, name: unknown) =>
    piClientManager.setSessionName(requiredString(name, '会话名称')),
  )
  ipcMain.handle('sessions:delete', async (_e, sessionPath: unknown) => {
    const state = await piClientManager.getState()
    if (!state.sessionFile) return { error: '当前没有会话' }
    // 路径由 main 判定:必须是本工作区会话目录下的 .jsonl,
    // 否则这个接口等于把 unlinkSync 暴露给了 renderer。
    let target: string
    try {
      target = parseSessionPath(sessionPath, dirname(state.sessionFile))
    } catch (err) {
      appendAppLog('warn', 'ipc.contract', 'Rejected sessions:delete', normalizeError(err))
      return { error: (err as Error).message }
    }
    // Never delete the file the running agent is writing to
    if (resolve(state.sessionFile) === target) return { error: '不能删除当前会话' }
    deleteSession(target)
    return { ok: true }
  })
  ipcMain.handle('sessions:exportCurrent', async (event, format: SessionExportFormat) => {
    const state = await piClientManager.getState()
    if (!state.sessionFile) return { error: '当前会话还没有可导出的记录' }
    const normalizedFormat: SessionExportFormat = format === 'json' ? 'json' : 'markdown'

    try {
      const exported = buildSessionExport(state.sessionFile, normalizedFormat)
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win!, {
        title: normalizedFormat === 'json' ? '导出会话 JSON' : '导出会话 Markdown',
        defaultPath: exported.fileName,
        filters:
          normalizedFormat === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      })

      if (result.canceled || !result.filePath) return { cancelled: true }

      writeFileSync(result.filePath, exported.content, 'utf-8')
      appendAppLog('info', 'sessions.export', 'Session exported', {
        path: result.filePath,
        format: normalizedFormat,
        sessionFile: state.sessionFile,
      })
      return { ok: true, path: result.filePath }
    } catch (err) {
      appendAppLog('error', 'sessions.export', 'Session export failed', normalizeError(err))
      return { error: (err as Error).message ?? '导出会话失败' }
    }
  })

  ipcMain.handle('git:diff', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      return { ok: true, snapshot: await getGitDiffSnapshot(cwd) }
    } catch (err) {
      appendAppLog('warn', 'git.diff', 'Failed to read git diff snapshot', normalizeError(err))
      return { error: (err as Error).message ?? '读取 Git 变更失败' }
    }
  })
  ipcMain.handle('git:discardChanges', async () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    try {
      const before = await getGitDiffSnapshot(cwd)
      if (!before.status.trim()) return { ok: true, snapshot: before }
      await discardGitChanges(cwd)
      const snapshot = emptyGitDiffSnapshot()
      appendAppLog('warn', 'git.discard', 'Workspace changes discarded', {
        cwd,
        changedFiles: before.files.map((file) => file.path),
      })
      return { ok: true, snapshot }
    } catch (err) {
      appendAppLog('error', 'git.discard', 'Failed to discard workspace changes', normalizeError(err))
      return { error: (err as Error).message ?? '回滚工作区变更失败' }
    }
  })
  ipcMain.handle('git:acceptChanges', () => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }
    acceptGitRunChanges(cwd)
    return { ok: true }
  })
  ipcMain.handle('git:showFile', async (_event, filePath: string) => {
    const cwd = piClientManager.getWorkspacePath()
    if (!cwd) return { error: 'No workspace is open' }

    const workspaceRoot = resolve(cwd)
    const target = resolve(workspaceRoot, filePath)
    const workspaceRootKey = workspaceRoot.toLowerCase()
    const targetKey = target.toLowerCase()
    if (targetKey !== workspaceRootKey && !targetKey.startsWith(`${workspaceRootKey}${sep}`)) {
      return { error: '文件路径不在当前工作区内' }
    }

    try {
      if (existsSync(target)) {
        shell.showItemInFolder(target)
      } else {
        await shell.openPath(workspaceRoot)
      }
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message ?? '打开文件失败' }
    }
  })

  // ── Pi agent session ─────────────────────────────────────────────
  ipcMain.handle('pi:prompt', async (_e, message: string, images?: ImageContent[]) => {
    const cwd = piClientManager.getWorkspacePath()
    let baselineCaptured = false
    if (cwd && (await isGitWorkspace(cwd))) {
      try {
        await beginGitRunChanges(cwd)
        baselineCaptured = true
      } catch (err) {
        appendAppLog('warn', 'git.runChanges', 'Failed to capture agent run baseline', {
          workspacePath: cwd,
          error: normalizeError(err),
        })
        throw err
      }
    }
    try {
      return await piClientManager.prompt(message, images)
    } catch (err) {
      if (baselineCaptured && cwd) await sealRunChanges(cwd, 'prompt rejected')
      throw err
    }
  })
  ipcMain.handle('pi:steer', (_e, message: string, images?: ImageContent[]) =>
    piClientManager.steer(message, images),
  )
  ipcMain.handle('pi:followUp', (_e, message: string, images?: ImageContent[]) =>
    piClientManager.followUp(message, images),
  )
  ipcMain.handle('pi:abort', () => piClientManager.abort())
  ipcMain.handle('pi:bash', (_e, command: string) => piClientManager.bash(command))
  ipcMain.handle(
    'pi:extensionUiResponse',
    (
      _e,
      response: {
        type: 'extension_ui_response'
        id: string
        value?: string
        confirmed?: boolean
        cancelled?: true
      },
    ) => piClientManager.respondExtensionUi(response),
  )
  ipcMain.handle('pi:newSession', () => piClientManager.newSession())
  ipcMain.handle('pi:getState', () => piClientManager.getState())
  ipcMain.handle('pi:getMessages', () => piClientManager.getMessages())
  ipcMain.handle('pi:getAvailableModels', () => piClientManager.getAvailableModels())
  ipcMain.handle('pi:getCommands', () => piClientManager.getCommands())
  ipcMain.handle('pi:setModel', async (_e, provider: string, modelId: string) => {
    const selected = await piClientManager.setModel(provider, modelId)
    saveSelectedModelRoute(provider, modelId)
    return selected
  })
  // 这几个值原样透传给 agent,必须先确认落在枚举内(原来是 `level as never`)
  ipcMain.handle('pi:setThinkingLevel', (_e, level: unknown) =>
    piClientManager.setThinkingLevel(oneOf(level, THINKING_LEVELS, '推理等级') as never),
  )
  ipcMain.handle('pi:setSteeringMode', (_e, mode: unknown) =>
    piClientManager.setSteeringMode(oneOf(mode, QUEUE_MODES, '插话模式')),
  )
  ipcMain.handle('pi:setFollowUpMode', (_e, mode: unknown) =>
    piClientManager.setFollowUpMode(oneOf(mode, QUEUE_MODES, '排队模式')),
  )
  ipcMain.handle('pi:setAutoCompaction', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new TypeError('自动压缩开关无效')
    return piClientManager.setAutoCompaction(enabled)
  })
  ipcMain.handle('pi:compact', () => piClientManager.compact())
}

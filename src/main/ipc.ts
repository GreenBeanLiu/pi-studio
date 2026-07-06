import { ipcMain, BrowserWindow, app, dialog, shell } from 'electron'
import { existsSync, writeFileSync } from 'fs'
import { dirname, resolve, sep } from 'path'
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
  addRecentWorkspace,
  removeRecentWorkspace,
  apiKeyEnvVar,
  agentConfigDir,
  writeModelsOverride,
  type PiProvider,
} from './settings'
import { piClientManager } from './pi-client'
import { syncSecurityGuardExtension } from './security-guard-extension'
import { syncSubagentWorkflow } from './subagent-workflow'
import { discardGitChanges, getGitDiffSnapshot } from './git-diff'
import { testProviderConnection } from './provider-test'
import { appendAppLog, normalizeError, readRecentAppLog } from './app-log'
import {
  loadWorkspaceMemory,
  saveWorkspaceMemory,
  syncWorkspaceMemoryExtension,
} from './workspace-memory'
import {
  loadSecurityPolicy,
  saveSecurityPolicy,
  type SecurityPolicy,
} from './security-policy'

export function registerIpcHandlers(): void {
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
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle(
    'settings:save',
    (
      _e,
      settings: {
        provider: PiProvider
        apiKey: string
        model: string
        baseUrl: string
        favoriteModels: string
        tavilyApiKey: string
        heliconeApiKey: string
        securityGuardEnabled: boolean
        subagentsEnabled: boolean
      },
    ) => {
      saveSettings(settings)
      return { ok: true }
    },
  )
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

    if (!settings.apiKey) {
      return { error: '请先在设置中填写 API Key' }
    }

    writeModelsOverride(settings.provider, settings.baseUrl, !!settings.heliconeApiKey)
    syncWebSearchExtension(!!settings.tavilyApiKey)
    syncSecurityGuardExtension(settings.securityGuardEnabled)
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
        {
          [apiKeyEnvVar(settings.provider)]: settings.apiKey,
          PI_CODING_AGENT_DIR: agentConfigDir(),
          ...(settings.tavilyApiKey ? { TAVILY_API_KEY: settings.tavilyApiKey } : {}),
          ...(settings.heliconeApiKey ? { HELICONE_API_KEY: settings.heliconeApiKey } : {}),
        },
        settings.provider,
        settings.model || undefined,
        (agentEvent) => {
          if (win && !win.isDestroyed()) win.webContents.send('pi:event', agentEvent)
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
  ipcMain.handle('sessions:switch', (_e, sessionPath: string) =>
    piClientManager.switchSession(sessionPath),
  )
  ipcMain.handle('sessions:rename', (_e, name: string) => piClientManager.setSessionName(name))
  ipcMain.handle('sessions:delete', async (_e, sessionPath: string) => {
    // Never delete the file the running agent is writing to
    const state = await piClientManager.getState()
    if (state.sessionFile === sessionPath) return { error: '不能删除当前会话' }
    deleteSession(sessionPath)
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
      const snapshot = await getGitDiffSnapshot(cwd)
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
  ipcMain.handle('pi:prompt', (_e, message: string, images?: ImageContent[]) =>
    piClientManager.prompt(message, images),
  )
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
  ipcMain.handle('pi:setModel', (_e, provider: string, modelId: string) =>
    piClientManager.setModel(provider, modelId),
  )
  ipcMain.handle('pi:setThinkingLevel', (_e, level: string) =>
    piClientManager.setThinkingLevel(level as never),
  )
  ipcMain.handle('pi:setSteeringMode', (_e, mode: 'all' | 'one-at-a-time') =>
    piClientManager.setSteeringMode(mode),
  )
  ipcMain.handle('pi:setFollowUpMode', (_e, mode: 'all' | 'one-at-a-time') =>
    piClientManager.setFollowUpMode(mode),
  )
  ipcMain.handle('pi:setAutoCompaction', (_e, enabled: boolean) =>
    piClientManager.setAutoCompaction(enabled),
  )
  ipcMain.handle('pi:compact', () => piClientManager.compact())
}

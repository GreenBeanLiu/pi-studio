import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { dirname } from 'path'
import type { ImageContent } from '@earendil-works/pi-ai'
import { listSessions, deleteSession } from './pi-sessions'
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

  // ── Settings ────────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle(
    'settings:save',
    (_e, settings: { provider: PiProvider; apiKey: string; model: string; baseUrl: string }) => {
      saveSettings(settings)
      return { ok: true }
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

    if (!settings.apiKey) {
      return { error: '请先在设置中填写 API Key' }
    }

    writeModelsOverride(settings.provider, settings.baseUrl)

    try {
      await piClientManager.startWorkspace(
        workspacePath,
        {
          [apiKeyEnvVar(settings.provider)]: settings.apiKey,
          PI_CODING_AGENT_DIR: agentConfigDir(),
        },
        settings.provider,
        settings.model || undefined,
        (agentEvent) => {
          if (win && !win.isDestroyed()) win.webContents.send('pi:event', agentEvent)
        },
      )
    } catch (err) {
      return { error: (err as Error).message ?? '启动工作区失败' }
    }

    const recentWorkspaces = addRecentWorkspace(workspacePath)
    return { ok: true, recentWorkspaces }
  })

  ipcMain.handle('workspace:remove', (_e, workspacePath: string) => {
    return removeRecentWorkspace(workspacePath)
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
  ipcMain.handle('pi:newSession', () => piClientManager.newSession())
  ipcMain.handle('pi:getState', () => piClientManager.getState())
  ipcMain.handle('pi:getMessages', () => piClientManager.getMessages())
  ipcMain.handle('pi:getAvailableModels', () => piClientManager.getAvailableModels())
  ipcMain.handle('pi:getCommands', () => piClientManager.getCommands())
  ipcMain.handle('pi:setModel', (_e, provider: string, modelId: string) =>
    piClientManager.setModel(provider, modelId),
  )
}

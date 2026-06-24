import { ipcMain, BrowserWindow, app, dialog } from 'electron'
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
          win?.webContents.send('pi:event', agentEvent)
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

  // ── Pi agent session ─────────────────────────────────────────────
  ipcMain.handle('pi:prompt', (_e, message: string) => piClientManager.prompt(message))
  ipcMain.handle('pi:steer', (_e, message: string) => piClientManager.steer(message))
  ipcMain.handle('pi:followUp', (_e, message: string) => piClientManager.followUp(message))
  ipcMain.handle('pi:abort', () => piClientManager.abort())
  ipcMain.handle('pi:bash', (_e, command: string) => piClientManager.bash(command))
  ipcMain.handle('pi:newSession', () => piClientManager.newSession())
  ipcMain.handle('pi:getState', () => piClientManager.getState())
  ipcMain.handle('pi:getMessages', () => piClientManager.getMessages())
  ipcMain.handle('pi:getAvailableModels', () => piClientManager.getAvailableModels())
  ipcMain.handle('pi:setModel', (_e, provider: string, modelId: string) =>
    piClientManager.setModel(provider, modelId),
  )
}

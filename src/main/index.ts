import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers } from './ipc'
import { piClientManager } from './pi-client'
import { loadBackendEnv } from './app-env'

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

// App-level (not per-window): autoUpdater listeners and the update:install
// handler must only ever be registered once, so this can't live in
// createWindow.
function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null // suppress default logger noise

  autoUpdater.on('update-available', (info) => {
    broadcast('update:available', { version: info.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    // Surface the error to the renderer so the user can see it
    broadcast('update:error', { message: err.message ?? String(err) })
  })

  ipcMain.on('update:install', () => {
    // isSilent=true: run the NSIS installer with /S so updates install
    // in-place without re-showing the assisted-install wizard
    // (oneClick:false only makes sense for FIRST installs).
    // isForceRunAfter=true: relaunch the app when done.
    autoUpdater.quitAndInstall(true, true)
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      broadcast('update:error', { message: err.message ?? String(err) })
    })
  }

  // 启动后 3 秒再检查，避免影响启动速度；之后每 4 小时查一次
  setTimeout(check, 3000)
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 820,
    minHeight: 580,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('cc.glanger.pi-studio')
  loadBackendEnv()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  piClientManager.warmup()
  if (!is.dev) setupAutoUpdater()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  piClientManager.stop().catch(() => {})
})

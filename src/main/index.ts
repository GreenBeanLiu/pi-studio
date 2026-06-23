import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers } from './ipc'
import { piClientManager } from './pi-client'

function setupAutoUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null // suppress default logger noise

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update:available', { version: info.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    // Surface the error to the renderer so the user can see it
    win.webContents.send('update:error', { message: err.message ?? String(err) })
  })

  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // 启动后 3 秒再检查，避免影响启动速度
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      win.webContents.send('update:error', { message: err.message ?? String(err) })
    })
  }, 3000)
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

  ipcMain.on('win:minimize', () => mainWindow.minimize())
  ipcMain.on('win:maximize', () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow.close())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    setupAutoUpdater(mainWindow)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('cc.glanger.pi-studio')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
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

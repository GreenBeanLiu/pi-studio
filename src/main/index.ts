import { app, shell, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers } from './ipc'
import { clearAllGitRunChanges } from './git-diff'
import { piClientManager } from './pi-client'
import { appendAppLog, attachWindowLoggers, installProcessLoggers, normalizeError } from './app-log'
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from './network-policy'
import { cleanupStaleRunChangeTempDirs } from './run-change-set'

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_RETRY_DELAY_MS = 30 * 1000
const UPDATE_MAX_RETRIES = 3

let tray: Tray | null = null
let isQuitting = false

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createTray(win: BrowserWindow): void {
  if (process.platform !== 'win32' || tray) return

  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    appendAppLog('warn', 'app', 'Tray icon is unavailable', { iconPath })
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('pi-studio')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 pi-studio', click: () => showMainWindow(win) },
      { type: 'separator' },
      {
        label: '退出 pi-studio',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => {
    if (win.isVisible()) win.hide()
    else showMainWindow(win)
  })
}

// App-level (not per-window): autoUpdater listeners and the update:install
// handler must only ever be registered once, so this can't live in
// createWindow.
function setupAutoUpdater(): void {
  let retryCount = 0
  let retryTimer: NodeJS.Timeout | null = null
  let checkInFlight = false

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null // suppress default logger noise

  const isTransientUpdateError = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err)
    return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(
      message,
    )
  }

  const scheduleRetry = (err: unknown): boolean => {
    if (!isTransientUpdateError(err) || retryCount >= UPDATE_MAX_RETRIES) return false
    retryCount += 1
    if (retryTimer) clearTimeout(retryTimer)
    appendAppLog('warn', 'updater', 'Update check transient failure; retrying', {
      error: normalizeError(err),
      retryCount,
      retryDelayMs: UPDATE_RETRY_DELAY_MS,
    })
    retryTimer = setTimeout(() => {
      retryTimer = null
      check()
    }, UPDATE_RETRY_DELAY_MS)
    return true
  }

  autoUpdater.on('update-available', (info) => {
    retryCount = 0
    appendAppLog('info', 'updater', 'Update available', { version: info.version })
    broadcast('update:available', { version: info.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    retryCount = 0
    appendAppLog('info', 'updater', 'Update downloaded', { version: info.version })
    broadcast('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    if (checkInFlight) {
      appendAppLog('warn', 'updater', 'Auto update emitted an error during active check', normalizeError(err))
      return
    }
    if (scheduleRetry(err)) return
    appendAppLog('error', 'updater', 'Auto update failed', normalizeError(err))
    broadcast('update:error', { message: err.message ?? String(err) })
  })

  ipcMain.on('update:install', () => {
    appendAppLog('info', 'updater', 'Installing downloaded update')
    // isSilent=true: run the NSIS installer with /S so updates install
    // in-place without re-showing the assisted-install wizard
    // (oneClick:false only makes sense for FIRST installs).
    // isForceRunAfter=true: relaunch the app when done.
    autoUpdater.quitAndInstall(true, true)
  })

  function check(): void {
    if (checkInFlight) return
    checkInFlight = true
    autoUpdater
      .checkForUpdates()
      .then(() => {
        retryCount = 0
      })
      .catch((err) => {
        if (scheduleRetry(err)) return
        appendAppLog('error', 'updater', 'Update check failed', normalizeError(err))
        broadcast('update:error', { message: err.message ?? String(err) })
      })
      .finally(() => {
        checkInFlight = false
      })
  }

  // 启动后 3 秒再检查，避免影响启动速度；之后每 4 小时查一次
  setTimeout(check, 3000)
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
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

  attachWindowLoggers(mainWindow)

  mainWindow.on('close', (event) => {
    if (process.platform !== 'win32' || isQuitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  const openAllowedExternalUrl = (url: string): void => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        appendAppLog('warn', 'navigation', 'Failed to open external URL', {
          error: normalizeError(err),
        })
      })
    } else {
      appendAppLog('warn', 'navigation', 'Blocked external URL with disallowed protocol')
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (
      is.dev &&
      isAllowedRendererNavigation(details.url, process.env['ELECTRON_RENDERER_URL'])
    ) {
      return
    }
    details.preventDefault()
    if (details.isMainFrame) openAllowedExternalUrl(details.url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  installProcessLoggers()
  const cleanedSnapshots = cleanupStaleRunChangeTempDirs()
  appendAppLog('info', 'app', 'App ready', { version: app.getVersion() })
  if (cleanedSnapshots > 0) {
    appendAppLog('info', 'git.runChanges', 'Cleaned stale Git snapshot directories', {
      count: cleanedSnapshots,
    })
  }

  electronApp.setAppUserModelId('cc.glanger.pi-studio')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  piClientManager.warmup()
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CONTENT_SECURITY_POLICY],
        },
      })
    })
  }
  if (!is.dev) setupAutoUpdater()
  createWindow()

  const [mainWindow] = BrowserWindow.getAllWindows()
  if (mainWindow) createTray(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
  tray = null
  appendAppLog('info', 'app', 'App quitting')
  clearAllGitRunChanges()
  piClientManager.stop().catch(() => {})
})

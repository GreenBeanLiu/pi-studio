import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // 窗口控制
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    flash: () => ipcRenderer.send('win:flash'),
  },

  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },

  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (s: unknown) => ipcRenderer.invoke('settings:save', s),
  },

  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    pickDirectory: () => ipcRenderer.invoke('workspace:pickDirectory'),
    open: (path: string) => ipcRenderer.invoke('workspace:open', path),
    remove: (path: string) => ipcRenderer.invoke('workspace:remove', path),
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    switch: (sessionPath: string) => ipcRenderer.invoke('sessions:switch', sessionPath),
    rename: (name: string) => ipcRenderer.invoke('sessions:rename', name),
    delete: (sessionPath: string) => ipcRenderer.invoke('sessions:delete', sessionPath),
  },

  pi: {
    prompt: (message: string, images?: unknown[]) =>
      ipcRenderer.invoke('pi:prompt', message, images),
    steer: (message: string, images?: unknown[]) => ipcRenderer.invoke('pi:steer', message, images),
    followUp: (message: string, images?: unknown[]) =>
      ipcRenderer.invoke('pi:followUp', message, images),
    abort: () => ipcRenderer.invoke('pi:abort'),
    bash: (command: string) => ipcRenderer.invoke('pi:bash', command),
    newSession: () => ipcRenderer.invoke('pi:newSession'),
    getState: () => ipcRenderer.invoke('pi:getState'),
    getMessages: () => ipcRenderer.invoke('pi:getMessages'),
    getAvailableModels: () => ipcRenderer.invoke('pi:getAvailableModels'),
    setModel: (provider: string, modelId: string) =>
      ipcRenderer.invoke('pi:setModel', provider, modelId),
    onEvent: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('pi:event', handler)
      return () => ipcRenderer.off('pi:event', handler)
    },
  },

  update: {
    onAvailable: (cb: (data: { version: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('update:available', handler)
      return () => ipcRenderer.off('update:available', handler)
    },
    onDownloaded: (cb: (data: { version: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('update:downloaded', handler)
      return () => ipcRenderer.off('update:downloaded', handler)
    },
    onError: (cb: (data: { message: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('update:error', handler)
      return () => ipcRenderer.off('update:error', handler)
    },
    install: () => ipcRenderer.send('update:install'),
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

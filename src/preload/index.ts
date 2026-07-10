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

  diagnostics: {
    getLogs: () => ipcRenderer.invoke('diagnostics:getLogs'),
    save: (payload: { defaultPath: string; content: string }) =>
      ipcRenderer.invoke('diagnostics:save', payload),
  },

  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (s: unknown) => ipcRenderer.invoke('settings:save', s),
    testConnection: (s: unknown) => ipcRenderer.invoke('settings:testConnection', s),
    listModels: (s: unknown) => ipcRenderer.invoke('settings:listModels', s),
  },

  securityPolicy: {
    load: () => ipcRenderer.invoke('securityPolicy:load'),
    save: (policy: unknown) => ipcRenderer.invoke('securityPolicy:save', policy),
    addRule: (payload: { target: string; rule: string }) =>
      ipcRenderer.invoke('securityPolicy:addRule', payload),
  },

  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    pickDirectory: () => ipcRenderer.invoke('workspace:pickDirectory'),
    open: (path: string) => ipcRenderer.invoke('workspace:open', path),
    remove: (path: string) => ipcRenderer.invoke('workspace:remove', path),
  },

  memory: {
    load: () => ipcRenderer.invoke('memory:load'),
    save: (content: string) => ipcRenderer.invoke('memory:save', content),
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    switch: (sessionPath: string) => ipcRenderer.invoke('sessions:switch', sessionPath),
    rename: (name: string) => ipcRenderer.invoke('sessions:rename', name),
    delete: (sessionPath: string) => ipcRenderer.invoke('sessions:delete', sessionPath),
    exportCurrent: (format: 'markdown' | 'json') =>
      ipcRenderer.invoke('sessions:exportCurrent', format),
  },

  git: {
    diff: () => ipcRenderer.invoke('git:diff'),
    discardChanges: () => ipcRenderer.invoke('git:discardChanges'),
    showFile: (path: string) => ipcRenderer.invoke('git:showFile', path),
  },

  pi: {
    prompt: (message: string, images?: unknown[]) =>
      ipcRenderer.invoke('pi:prompt', message, images),
    steer: (message: string, images?: unknown[]) => ipcRenderer.invoke('pi:steer', message, images),
    followUp: (message: string, images?: unknown[]) =>
      ipcRenderer.invoke('pi:followUp', message, images),
    abort: () => ipcRenderer.invoke('pi:abort'),
    bash: (command: string) => ipcRenderer.invoke('pi:bash', command),
    extensionUiResponse: (response: {
      type: 'extension_ui_response'
      id: string
      value?: string
      confirmed?: boolean
      cancelled?: true
    }) => ipcRenderer.invoke('pi:extensionUiResponse', response),
    newSession: () => ipcRenderer.invoke('pi:newSession'),
    getState: () => ipcRenderer.invoke('pi:getState'),
    getMessages: () => ipcRenderer.invoke('pi:getMessages'),
    getAvailableModels: () => ipcRenderer.invoke('pi:getAvailableModels'),
    getCommands: () => ipcRenderer.invoke('pi:getCommands'),
    setModel: (provider: string, modelId: string) =>
      ipcRenderer.invoke('pi:setModel', provider, modelId),
    setThinkingLevel: (level: string) => ipcRenderer.invoke('pi:setThinkingLevel', level),
    setSteeringMode: (mode: string) => ipcRenderer.invoke('pi:setSteeringMode', mode),
    setFollowUpMode: (mode: string) => ipcRenderer.invoke('pi:setFollowUpMode', mode),
    setAutoCompaction: (enabled: boolean) => ipcRenderer.invoke('pi:setAutoCompaction', enabled),
    compact: () => ipcRenderer.invoke('pi:compact'),
    onEvent: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('pi:event', handler)
      return () => ipcRenderer.off('pi:event', handler)
    },
    onStatus: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('agent:status', handler)
      return () => ipcRenderer.off('agent:status', handler)
    },
  },

  routines: {
    list: () => ipcRenderer.invoke('routines:list'),
    save: (routine: unknown) => ipcRenderer.invoke('routines:save', routine),
    delete: (id: string) => ipcRenderer.invoke('routines:delete', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('routines:toggle', id, enabled),
    runNow: (id: string) => ipcRenderer.invoke('routines:runNow', id),
    running: () => ipcRenderer.invoke('routines:running'),
    onRunFinished: (cb: (run: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('routines:runFinished', handler)
      return () => ipcRenderer.off('routines:runFinished', handler)
    },
  },

  imageGen: {
    health: () => ipcRenderer.invoke('imageGen:health'),
    generate: (payload: { prompt: string; engine: 'openai' | 'comfy'; referenceUrls?: string[] }) =>
      ipcRenderer.invoke('imageGen:generate', payload),
    history: () => ipcRenderer.invoke('imageGen:history'),
    historyDelete: (id: string) => ipcRenderer.invoke('imageGen:historyDelete', id),
    comfyStart: () => ipcRenderer.invoke('imageGen:comfyStart'),
    comfyStop: () => ipcRenderer.invoke('imageGen:comfyStop'),
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

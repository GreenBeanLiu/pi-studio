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
    piVersion: () => ipcRenderer.invoke('app:piVersion'),
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
    syncCustomModels: (ids: string[]) => ipcRenderer.invoke('settings:syncCustomModels', ids),
    onChanged: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.off('settings:changed', handler)
    },
  },

  sandbox: {
    detect: () => ipcRenderer.invoke('sandbox:detect'),
    imageStatus: () => ipcRenderer.invoke('sandbox:imageStatus'),
    buildImage: () => ipcRenderer.invoke('sandbox:buildImage'),
    onBuildProgress: (cb: (line: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('sandbox:buildProgress', handler)
      return () => ipcRenderer.off('sandbox:buildProgress', handler)
    },
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
    acceptChanges: () => ipcRenderer.invoke('git:acceptChanges'),
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
    state: () => ipcRenderer.invoke('routines:state'),
    onRunFinished: (cb: (run: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('routines:runFinished', handler)
      return () => ipcRenderer.off('routines:runFinished', handler)
    },
    onStepProgress: (cb: (progress: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('routines:stepProgress', handler)
      return () => ipcRenderer.off('routines:stepProgress', handler)
    },
    reviewRespond: (reviewId: string, decision: 'approve' | 'reject', comment?: string) =>
      ipcRenderer.invoke('routines:reviewRespond', reviewId, decision, comment),
    onReviewRequested: (cb: (request: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('routines:reviewRequested', handler)
      return () => ipcRenderer.off('routines:reviewRequested', handler)
    },
    onReviewCancelled: (cb: (payload: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data)
      ipcRenderer.on('routines:reviewCancelled', handler)
      return () => ipcRenderer.off('routines:reviewCancelled', handler)
    },
  },

  channels: {
    list: () => ipcRenderer.invoke('channels:list'),
    save: (channels: unknown[]) => ipcRenderer.invoke('channels:save', channels),
    test: (channel: unknown) => ipcRenderer.invoke('channels:test', channel),
  },

  imageGen: {
    health: () => ipcRenderer.invoke('imageGen:health'),
    generate: (payload: {
      prompt: string
      engine: 'openai' | 'comfy'
      referenceUrls?: string[]
      maskDataUrl?: string
      size?: 'square_hd' | 'landscape_4_3' | 'portrait_4_3'
    }) =>
      ipcRenderer.invoke('imageGen:generate', payload),
    history: (limit?: number) => ipcRenderer.invoke('imageGen:history', limit),
    historyDelete: (id: string) => ipcRenderer.invoke('imageGen:historyDelete', id),
    uploadReference: (dataUrl: string) => ipcRenderer.invoke('imageGen:uploadReference', dataUrl),
    comfyStart: () => ipcRenderer.invoke('imageGen:comfyStart'),
    comfyStop: () => ipcRenderer.invoke('imageGen:comfyStop'),
  },

  model3d: {
    health: () => ipcRenderer.invoke('model3d:health'),
    generate: (payload: {
      mode: 'text' | 'image'
      prompt: string
      imageDataUrl?: string
      options?: Record<string, unknown>
    }) => ipcRenderer.invoke('model3d:generate', payload),
    generateCode: (payload: { prompt: string; sourceId?: string }) =>
      ipcRenderer.invoke('model3d:generateCode', payload),
    generateBlender: (payload: { prompt: string; sourceId?: string }) =>
      ipcRenderer.invoke('model3d:generateBlender', payload),
    blenderHealth: () => ipcRenderer.invoke('model3d:blenderHealth'),
    history: () => ipcRenderer.invoke('model3d:history'),
    historyDelete: (id: string) => ipcRenderer.invoke('model3d:historyDelete', id),
    saveThumbnail: (payload: { id: string; dataUrl: string }) =>
      ipcRenderer.invoke('model3d:saveThumbnail', payload),
    onProgress: (
      cb: (data: {
        id: string
        status: string
        progress: number
        prompt?: string
        mode?: 'text' | 'image'
      }) => void,
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('model3d:progress', handler)
      return () => ipcRenderer.off('model3d:progress', handler)
    },
    onScored: (
      cb: (data: { id: string; fidelity: { score: number; notes: string; model: string } }) => void,
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('model3d:scored', handler)
      return () => ipcRenderer.off('model3d:scored', handler)
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
  // @ts-ignore -- Electron fallback when context isolation is disabled.
  window.electron = electronAPI
  // @ts-ignore -- Electron fallback when context isolation is disabled.
  window.api = api
}

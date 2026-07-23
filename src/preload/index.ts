import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { LlmProfileSavePayload, SettingsSaveInput } from '../shared/contracts'
import type {
  AgentRuntimeSnapshot,
  AgentStatusEvent,
  DesktopApi,
  Model3DOptions,
  Model3DProvider,
  PiRuntimeEvent,
  RemoteControlSnapshot,
  RoutineReviewRequest,
  RoutineRun,
  RoutineStepProgress,
} from '../shared/ipc/contract'

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

  clipboard: {
    writeText: (value: string) => ipcRenderer.invoke('clipboard:writeText', value),
  },

  diagnostics: {
    getLogs: () => ipcRenderer.invoke('diagnostics:getLogs'),
    save: (payload: { defaultPath: string; content: string }) =>
      ipcRenderer.invoke('diagnostics:save', payload),
  },

  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (s: SettingsSaveInput) => ipcRenderer.invoke('settings:save', s),
    testConnection: (s: unknown) => ipcRenderer.invoke('settings:testConnection', s),
    listModels: (s: unknown) => ipcRenderer.invoke('settings:listModels', s),
    onChanged: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.off('settings:changed', handler)
    },
  },

  llmProfiles: {
    list: () => ipcRenderer.invoke('llmProfiles:list'),
    save: (payload: LlmProfileSavePayload) =>
      ipcRenderer.invoke('llmProfiles:save', payload),
    delete: (id: string) => ipcRenderer.invoke('llmProfiles:delete', id),
    refreshModels: (id: string) => ipcRenderer.invoke('llmProfiles:refreshModels', id),
  },

  modelCatalog: {
    loadProviderLabels: () => ipcRenderer.invoke('modelCatalog:loadProviderLabels'),
    reconcileFavoriteRoutes: () => ipcRenderer.invoke('modelCatalog:reconcileFavoriteRoutes'),
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

  remote: {
    getStatus: () => ipcRenderer.invoke('remote:getStatus'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('remote:setEnabled', enabled),
    generatePairingCode: () => ipcRenderer.invoke('remote:generatePairingCode'),
    onStatus: (cb: (snap: RemoteControlSnapshot) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, snap: RemoteControlSnapshot): void => cb(snap)
      ipcRenderer.on('remote:status', handler)
      return () => ipcRenderer.off('remote:status', handler)
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
    onEvent: (cb: (event: PiRuntimeEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: PiRuntimeEvent) => cb(data)
      ipcRenderer.on('pi:event', handler)
      return () => ipcRenderer.off('pi:event', handler)
    },
    onStatus: (cb: (event: AgentStatusEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: AgentStatusEvent) => cb(data)
      ipcRenderer.on('agent:status', handler)
      return () => ipcRenderer.off('agent:status', handler)
    },
    getRuntimeSnapshot: () => ipcRenderer.invoke('pi:getRuntimeSnapshot'),
    onRuntime: (cb: (snapshot: AgentRuntimeSnapshot) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: AgentRuntimeSnapshot) => cb(data)
      ipcRenderer.on('agent:runtime', handler)
      return () => ipcRenderer.off('agent:runtime', handler)
    },
  },

  routines: {
    list: () => ipcRenderer.invoke('routines:list'),
    save: (routine: unknown) => ipcRenderer.invoke('routines:save', routine),
    delete: (id: string) => ipcRenderer.invoke('routines:delete', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('routines:toggle', id, enabled),
    runNow: (id: string) => ipcRenderer.invoke('routines:runNow', id),
    state: () => ipcRenderer.invoke('routines:state'),
    onRunFinished: (cb: (run: RoutineRun) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: RoutineRun) => cb(data)
      ipcRenderer.on('routines:runFinished', handler)
      return () => ipcRenderer.off('routines:runFinished', handler)
    },
    onStepProgress: (cb: (progress: RoutineStepProgress) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: RoutineStepProgress) => cb(data)
      ipcRenderer.on('routines:stepProgress', handler)
      return () => ipcRenderer.off('routines:stepProgress', handler)
    },
    reviewRespond: (reviewId: string, decision: 'approve' | 'reject', comment?: string) =>
      ipcRenderer.invoke('routines:reviewRespond', reviewId, decision, comment),
    onReviewRequested: (cb: (request: RoutineReviewRequest) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: RoutineReviewRequest) => cb(data)
      ipcRenderer.on('routines:reviewRequested', handler)
      return () => ipcRenderer.off('routines:reviewRequested', handler)
    },
    onReviewCancelled: (cb: (payload: { reviewId: string; reason: string }) => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        data: { reviewId: string; reason: string },
      ) => cb(data)
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
      engine: 'openai' | 'gemini' | 'grok'
      batchId?: string
      referenceUrls?: string[]
      maskDataUrl?: string
      size?: '256x256' | '512x512' | '1024x1024' | '1024x1536' | '1536x1024' | '1024x1792' | '1792x1024' | 'auto'
      aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | '2:1' | '1:2' | '19.5:9' | '9:19.5' | '20:9' | '9:20' | 'auto'
      imageSize?: '1K' | '2K' | '4K'
      n?: number
      quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
      background?: 'auto' | 'transparent' | 'opaque'
      outputFormat?: 'png' | 'jpeg' | 'webp'
      outputCompression?: number
      moderation?: 'auto' | 'low'
      responseFormat?: 'b64_json' | 'url'
      model?: | 'gpt-image-2'
      | 'gemini-3.1-flash-image-preview'
      | 'gemini-3-pro-image-preview'
      | 'grok-imagine-image'
      | 'grok-imagine-image-quality'
      user?: string
    }) =>
      ipcRenderer.invoke('imageGen:generate', payload),
    history: (limit?: number) => ipcRenderer.invoke('imageGen:history', limit),
    historyDelete: (id: string) => ipcRenderer.invoke('imageGen:historyDelete', id),
    historyDeleteBatch: (batchId: string) => ipcRenderer.invoke('imageGen:historyDeleteBatch', batchId),
    uploadReference: (dataUrl: string) => ipcRenderer.invoke('imageGen:uploadReference', dataUrl),
  },

  model3d: {
    health: () => ipcRenderer.invoke('model3d:health'),
    generate: (payload: {
      mode: 'text' | 'image' | 'code' | 'blender'
      prompt: string
      imageDataUrl?: string
      aiImage?: boolean
      provider?: Model3DProvider
      options?: Model3DOptions
    }) => ipcRenderer.invoke('model3d:generate', payload),
    generateCode: (payload: { prompt: string; sourceId?: string }) =>
      ipcRenderer.invoke('model3d:generateCode', payload),
    generateBlender: (payload: { prompt: string; sourceId?: string }) =>
      ipcRenderer.invoke('model3d:generateBlender', payload),
    blenderHealth: () => ipcRenderer.invoke('model3d:blenderHealth'),
    blenderStatus: () => ipcRenderer.invoke('model3d:blenderStatus'),
    setupBlender: () => ipcRenderer.invoke('model3d:setupBlender'),
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

  dressup: {
    health: () => ipcRenderer.invoke('dressup:health'),
    generate: (payload: {
      firstFrameDataUrl: string
      tailFrameDataUrl: string
      prompt?: string
      mode?: 'std' | 'pro'
      duration?: '5' | '10'
      model?: string
    }) => ipcRenderer.invoke('dressup:generate', payload),
    workflow: (payload: {
      personDataUrl: string
      garmentDataUrl: string
      firstFrameDataUrl: string
      prompt?: string
    }) => ipcRenderer.invoke('dressup:workflow', payload),
    history: () => ipcRenderer.invoke('dressup:history'),
    historyDelete: (id: string) => ipcRenderer.invoke('dressup:historyDelete', id),
    onProgress: (
      cb: (data: { id: string; status: string; progress: number; prompt?: string }) => void,
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('dressup:progress', handler)
      return () => ipcRenderer.off('dressup:progress', handler)
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
} satisfies DesktopApi

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore -- Electron fallback when context isolation is disabled.
  window.electron = electronAPI
  // @ts-ignore -- Electron fallback when context isolation is disabled.
  window.api = api
}

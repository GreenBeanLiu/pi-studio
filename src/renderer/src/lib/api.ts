import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
} from '@earendil-works/pi-ai/compat'
import type {
  LlmProfileSavePayload,
  LlmProviderProfile,
  ModelCatalogView,
  PiProvider,
  SettingsSaveInput,
  SettingsView,
  Workspace,
} from '../../../shared/contracts'

export type {
  LlmProfileWrite,
  LlmProfileSavePayload,
  LlmProviderProfile,
  ModelCatalogView,
  PiProvider,
  SettingsSaveInput,
  SettingsView,
  Workspace,
} from '../../../shared/contracts'

// Type-safe wrapper around window.api (exposed by preload)
declare global {
  interface Window {
    api: {
      win: {
        minimize: () => void
        maximize: () => void
        close: () => void
        flash: () => void
      }
      app: {
        version: () => Promise<string>
        piVersion: () => Promise<string>
      }
      clipboard: {
        writeText: (value: string) => Promise<void>
      }
      diagnostics: {
        getLogs: () => Promise<{ ok: true; content: string }>
        save: (payload: {
          defaultPath: string
          content: string
        }) => Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
      }
      settings: {
        load: () => Promise<SettingsView>
        save: (s: SettingsSaveInput) => Promise<{
          ok: boolean
          sandboxChanged?: boolean
          workspaceOpen?: boolean
        }>
        testConnection: (s: {
          provider: PiProvider
          apiKey: string
          model: string
          baseUrl: string
        }) => Promise<ProviderConnectionResult>
        listModels: (s: {
          provider: PiProvider
          apiKey: string
          model: string
          baseUrl: string
        }) => Promise<ProviderModelListResult>
        onChanged: (cb: () => void) => () => void
      }
      llmProfiles: {
        list: () => Promise<LlmProfileListResult>
        save: (payload: LlmProfileSavePayload) => Promise<
          { ok: true; profile: LlmProviderProfile; warning?: string } | { error: string }
        >
        delete: (id: string) => Promise<{ ok: true; warning?: string } | { error: string }>
        refreshModels: (
          id: string,
        ) => Promise<
          { ok: true; profile: LlmProviderProfile; warning?: string } | { error: string }
        >
      }
      modelCatalog: {
        loadProviderLabels: () => Promise<
          { ok: true; view: ModelCatalogView } | { error: string }
        >
        reconcileFavoriteRoutes: () => Promise<
          { ok: true; changed: boolean; warning?: string } | { error: string }
        >
      }
      sandbox: {
        detect: () => Promise<SandboxDetect>
        imageStatus: () => Promise<SandboxImageStatus>
        buildImage: () => Promise<{ ok: true } | { error: string }>
        onBuildProgress: (cb: (line: string) => void) => () => void
      }
      remote: {
        getStatus: () => Promise<RemoteControlSnapshot>
        setEnabled: (enabled: boolean) => Promise<RemoteControlSnapshot>
        generatePairingCode: () => Promise<
          { code: string; expiresAt: number } | { error: string }
        >
        onStatus: (cb: (snap: RemoteControlSnapshot) => void) => () => void
      }
      securityPolicy: {
        load: () => Promise<SecurityPolicyLoadResult>
        save: (
          policy: SecurityPolicy,
        ) => Promise<
          | ({ ok: true } & SecurityPolicyLoadResult)
          | { error: string }
        >
        addRule: (
          payload: { target: SecurityPolicyRuleTarget; rule: string },
        ) => Promise<({ ok: true } & SecurityPolicyLoadResult) | { error: string }>
      }
      workspace: {
        list: () => Promise<Workspace[]>
        pickDirectory: () => Promise<string | null>
        open: (path: string) => Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }>
        remove: (path: string) => Promise<Workspace[]>
      }
      memory: {
        load: () => Promise<{ ok: true; memory: WorkspaceMemory } | { error: string }>
        save: (
          content: string,
        ) => Promise<{ ok: true; memory: WorkspaceMemory } | { error: string }>
      }
      sessions: {
        list: () => Promise<SessionInfo[]>
        switch: (sessionPath: string) => Promise<{ cancelled: boolean }>
        rename: (name: string) => Promise<void>
        delete: (sessionPath: string) => Promise<{ ok: true } | { error: string }>
        exportCurrent: (
          format: SessionExportFormat,
        ) => Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
      }
      git: {
        diff: () => Promise<{ ok: true; snapshot: GitDiffSnapshot } | { error: string }>
        acceptChanges: () => Promise<{ ok: true } | { error: string }>
        discardChanges: () => Promise<{ ok: true; snapshot: GitDiffSnapshot } | { error: string }>
        showFile: (path: string) => Promise<{ ok: true } | { error: string }>
      }
      pi: {
        prompt: (message: string, images?: ImageContent[]) => Promise<void>
        steer: (message: string, images?: ImageContent[]) => Promise<void>
        followUp: (message: string, images?: ImageContent[]) => Promise<void>
        abort: () => Promise<void>
        bash: (command: string) => Promise<unknown>
        extensionUiResponse: (response: ExtensionUiResponse) => Promise<void>
        newSession: () => Promise<{ cancelled: boolean }>
        getState: () => Promise<RpcSessionState>
        getMessages: () => Promise<AgentMessage[]>
        getAvailableModels: () => Promise<ModelInfo[]>
        getCommands: () => Promise<SlashCommand[]>
        setModel: (provider: string, modelId: string) => Promise<{ provider: string; id: string }>
        setThinkingLevel: (level: ThinkingLevel) => Promise<void>
        setSteeringMode: (mode: QueueMode) => Promise<void>
        setFollowUpMode: (mode: QueueMode) => Promise<void>
        setAutoCompaction: (enabled: boolean) => Promise<void>
        compact: () => Promise<unknown>
        onEvent: (cb: (event: PiRuntimeEvent) => void) => () => void
        onStatus: (cb: (event: AgentStatusEvent) => void) => () => void
      }
      routines: {
        list: () => Promise<{ routines: Routine[]; runs: RoutineRun[] }>
        save: (
          routine: Partial<Routine> &
            Pick<Routine, 'name' | 'steps' | 'workspacePath' | 'schedule' | 'notify'>,
        ) => Promise<Routine[]>
        delete: (id: string) => Promise<Routine[]>
        toggle: (id: string, enabled: boolean) => Promise<Routine[]>
        runNow: (id: string) => Promise<{ ok: true } | { error: string }>
        state: () => Promise<{
          runningIds: string[]
          queuedIds: string[]
          progress?: RoutineStepProgress[]
        }>
        onRunFinished: (cb: (run: RoutineRun) => void) => () => void
        onStepProgress: (cb: (progress: RoutineStepProgress) => void) => () => void
        reviewRespond: (reviewId: string, decision: 'approve' | 'reject', comment?: string) => Promise<{ ok: true } | { error: string }>
        onReviewRequested: (cb: (request: RoutineReviewRequest) => void) => () => void
        onReviewCancelled: (cb: (payload: { reviewId: string; reason: string }) => void) => () => void
      }
      channels: {
        list: () => Promise<Channel[]>
        save: (channels: Channel[]) => Promise<Channel[]>
        test: (channel: Channel) => Promise<{ ok: true } | { error: string }>
      }
      imageGen: {
        health: () => Promise<ImageGenHealth>
        generate: (payload: {
          prompt: string
          engine: ImageGenEngine
          batchId?: string
          referenceUrls?: string[]
          maskDataUrl?: string
          size?: ImageGenSize
          aspectRatio?: GeminiImageAspectRatio | GrokImageAspectRatio
          imageSize?: GeminiImageResolution | GrokImageResolution
          n?: number
          quality?: ImageGenQuality
          background?: ImageGenBackground
          outputFormat?: ImageGenOutputFormat
          outputCompression?: number
          moderation?: ImageGenModeration
          responseFormat?: ImageGenResponseFormat
          providerStyle?: ImageGenProviderStyle
          user?: string
          model?: 'gpt-image-2' | 'gemini-3-pro-image-preview' | 'grok-imagine-image' | 'grok-imagine-image-quality'
        }) => Promise<{ dataUrl: string; publicUrl: string | null; urls?: string[] } | { error: string }>
        history: (limit?: number) => Promise<ImageGenHistoryItem[] | { error: string }>
        historyDelete: (id: string) => Promise<{ ok: boolean }>
        historyDeleteBatch: (batchId: string) => Promise<{ ok: boolean }>
        uploadReference: (dataUrl: string) => Promise<{ ok: true; url: string } | { error: string }>
      }
      model3d: {
        health: () => Promise<Model3DHealth>
        generate: (payload: {
          mode: 'text' | 'image' | 'code' | 'blender'
          prompt: string
          imageDataUrl?: string
          provider?: Model3DProvider
          options?: Model3DOptions
        }) => Promise<Model3DHistoryItem | { error: string }>
        generateBlender: (payload: {
          prompt: string
          sourceId?: string
        }) => Promise<Model3DHistoryItem | { error: string }>
        blenderHealth: () => Promise<boolean>
        blenderStatus: () => Promise<BlenderSetupStatus>
        setupBlender: () => Promise<BlenderSetupStatus>
        generateCode: (payload: {
          prompt: string
          sourceId?: string
        }) => Promise<Model3DHistoryItem | { error: string }>
        history: () => Promise<Model3DHistoryItem[]>
        historyDelete: (id: string) => Promise<{ ok: boolean }>
        saveThumbnail: (payload: {
          id: string
          dataUrl: string
        }) => Promise<Model3DHistoryItem | { error: string }>
        onProgress: (
          cb: (data: {
            id: string
            status: string
            progress: number
            prompt?: string
            mode?: 'text' | 'image'
          }) => void,
        ) => () => void
        onScored: (cb: (data: { id: string; fidelity: Model3DFidelity }) => void) => () => void
      }
      update: {
        onAvailable: (cb: (data: { version: string }) => void) => () => void
        onDownloaded: (cb: (data: { version: string }) => void) => () => void
        onError: (cb: (data: { message: string }) => void) => () => void
        install: () => void
      }
    }
  }
}

export type LlmProfileListResult =
  | { ok: true; profiles: LlmProviderProfile[] }
  | { error: string }

export type ImageGenEngine = 'openai' | 'gemini' | 'grok'

export type GeminiImageAspectRatio =
  | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
export type GeminiImageResolution = '1K' | '2K' | '4K'
export type GrokImageAspectRatio =
  | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  | '2:1' | '1:2' | '19.5:9' | '9:19.5' | '20:9' | '9:20' | 'auto'
export type GrokImageResolution = '1K' | '2K'

export type Model3DHealth = {
  configured: boolean
  /** 各 3D 服务商密钥是否就绪;探测失败时缺失 */
  providers?: Record<Model3DProvider, boolean>
}

export type BlenderSetupStatus = {
  connected: boolean
  blenderFound: boolean
  addonInstalled: boolean
  blenderPath?: string
  version?: string
  ok?: boolean
  error?: string
}

/** 云端 3D 服务商。Hi3D 是纯 image-to-3D,没有文生 3D 接口。 */
export type Model3DProvider = 'tripo' | 'hi3d'

export type Model3DOptions = {
  modelVersion?: string
  faceLimit?: number
  texture?: boolean
  pbr?: boolean
  style?: string
  /** Hi3D 专有:分辨率档位,合法值随 modelVersion 变化 */
  resolution?: string
}

export type Model3DFidelity = { score: number; notes: string; model: string }

export type Model3DHistoryItem = {
  id: string
  prompt: string
  mode: 'text' | 'image' | 'code' | 'blender'
  modelUrl: string
  cloudModelUrl?: string
  thumbnailUrl: string | null
  createdAt: number
  options?: Model3DOptions
  fidelity?: Model3DFidelity
}

/** TikHub/OpenAI-compatible images API documented size values. */
export type ImageGenSize =
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'
  | '1024x1792'
  | '1792x1024'
  | 'auto'

export type ImageGenQuality = 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd'
export type ImageGenBackground = 'auto' | 'transparent' | 'opaque'
export type ImageGenOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageGenModeration = 'auto' | 'low'
export type ImageGenResponseFormat = 'b64_json' | 'url'
export type ImageGenProviderStyle = 'vivid' | 'natural'

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  model: string
  r2: boolean
}

export type RoutineSchedule =
  | { type: 'manual' }
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

export type RoutineNotify = 'always' | 'error' | 'never'

export type RoutineStepType = 'agent' | 'folder-input' | 'imagegen' | 'review' | 'notify' | 'export' | 'feishu-doc' | 'wechat-draft'

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  prompt?: string
  engine?: ImageGenEngine
  channelId?: string
  message?: string
  path?: string
  format?: 'markdown' | 'html'
}

export type Routine = {
  id: string
  name: string
  input?: string
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  notifyChannelId?: string
  pushEachStep?: boolean
  createdAt: number
  lastRunAt?: number
}

export type RoutineStepResult = {
  id: string
  name: string
  status: 'ok' | 'error' | 'timeout' | 'skipped'
  summary: string
  imageUrl?: string
  artifactPath?: string
  durationMs: number
}

export type RoutineReviewRequest = {
  reviewId: string
  routineId: string
  routineName: string
  stepId: string
  stepName: string
  message: string
  artifactPath?: string
  preview: string
}

export type ChannelType = 'feishu-webhook' | 'feishu-app' | 'wechat-official' | 'webhook' | 'local'

export type Channel = {
  id: string
  name: string
  type: ChannelType
  url?: string
  secret?: string
  appId?: string
  appSecret?: string
  chatId?: string
  folderToken?: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
  triggerSource?: 'manual' | 'schedule'
  summary: string
  steps?: RoutineStepResult[]
  error?: string
}

export type RoutineStepProgress = {
  routineId: string
  stepId: string
  stepIndex: number
  totalSteps: number
  status: 'running' | 'ok' | 'error' | 'timeout'
}

export type ImageGenHistoryItem = {
  id: string
  batch_id: string
  prompt: string
  engine: string
  model: string | null
  provider: string | null
  url: string
  created_at: number
}

export type ProviderConnectionResult =
  | { ok: true; message: string; details?: string }
  | { ok: false; message: string; details?: string }

export type ProviderModelListResult =
  | { ok: true; message: string; models: string[] }
  | { ok: false; message: string; details?: string }

export type SandboxDetect = {
  docker: { cliFound: boolean; daemonRunning: boolean; version: string }
  /** 首选执行路径:pi-studio-sandbox WSL 发行版是否就绪 */
  wslSandboxReady: boolean
  wsl: { available: boolean; distros: string[] }
}

export type SandboxImageStatus = {
  tag: string
  exists: boolean
  daemonRunning: boolean
}

export type RemoteControlSnapshot = {
  enabled: boolean
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  controllers: number
  lastError: string
}

export type WorkspaceMemory = {
  path: string
  exists: boolean
  content: string
}

export type SecurityPolicy = {
  commandAllowlist: string[]
  commandBlocklist: string[]
  writeAllowlist: string[]
  writeBlocklist: string[]
  requireConfirmationForDangerousCommands: boolean
  blockProtectedPaths: boolean
  blockOutsideWorkspace: boolean
}

export type SecurityPolicyRuleTarget =
  | 'commandAllowlist'
  | 'commandBlocklist'
  | 'writeAllowlist'
  | 'writeBlocklist'

export type SecurityPolicyLoadResult = {
  scope: 'default' | 'workspace'
  workspacePath?: string
  policy: SecurityPolicy
}

export type QueueMode = 'all' | 'one-at-a-time'

export type RpcSessionState = {
  model?: { provider: string; id: string }
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
  autoCompactionEnabled: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  messageCount: number
  pendingMessageCount: number
}

export type ModelInfo = {
  provider: string
  id: string
  contextWindow: number
  reasoning: boolean
  // pi registry 的完整模型对象还带这些(RPC 原样透传;老版本/自定义条目可能缺,全部可选)
  name?: string
  api?: string
  baseUrl?: string
  input?: string[]
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type SlashCommand = {
  /** Command name (without leading slash) */
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
}

export type ExtensionUiRequest =
  | {
      type: 'extension_ui_request'
      id: string
      method: 'confirm'
      title: string
      message: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'notify'
      message: string
      notifyType?: 'info' | 'warning' | 'error'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'select'
      title: string
      options: string[]
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'input'
      title: string
      placeholder?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text' | 'editor'
      [key: string]: unknown
    }

export type ExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

export type PiRuntimeEvent = AgentSessionEvent | ExtensionUiRequest

export type AgentStatusEvent =
  | {
      status: 'started'
      cwd: string
      restoredSession: boolean
      sessionFile?: string
      sandbox?: 'wsl' | 'docker'
    }
  | { status: 'exited'; cwd: string; code: number | null; signal: string | null; expected: boolean; message: string }
  | { status: 'error'; cwd: string; message: string }

export type SessionInfo = {
  path: string
  id: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  modified: string
}

export type SessionExportFormat = 'markdown' | 'json'

export type GitDiffSnapshot = {
  status: string
  files: GitChangedFile[]
  unstagedStat: string
  unstagedDiff: string
  stagedStat: string
  stagedDiff: string
  truncated: boolean
}

export type GitChangedFile = {
  path: string
  originalPath?: string
  statusCode: string
  staged: boolean
  unstaged: boolean
}

export type {
  AgentSessionEvent,
  AgentMessage,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
}

export const api = window.api

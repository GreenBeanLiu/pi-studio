import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
} from '@earendil-works/pi-ai/base'

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
      }
      diagnostics: {
        getLogs: () => Promise<{ ok: true; content: string }>
        save: (payload: {
          defaultPath: string
          content: string
        }) => Promise<{ ok: true; path: string } | { cancelled: true } | { error: string }>
      }
      settings: {
        load: () => Promise<{
          provider: PiProvider
          apiKey: string
          model: string
          baseUrl: string
          favoriteModels: string
          tavilyApiKey: string
          heliconeApiKey: string
          securityGuardEnabled: boolean
          subagentsEnabled: boolean
          feishuWebhookUrl: string
          feishuSecret: string
          feishuAppId: string
          feishuAppSecret: string
          feishuChatId: string
          imageEngine: '' | 'comfy' | 'openai'
          comfyDir: string
          comfyPythonPath: string
          comfyLaunchArgs: string
          comfyCheckpoint: string
          cloudImageRelay: string
          cloudImageKey: string
          recentWorkspaces: Workspace[]
        }>
        save: (s: {
          provider: PiProvider
          apiKey: string
          model: string
          baseUrl: string
          favoriteModels: string
          tavilyApiKey: string
          heliconeApiKey: string
          securityGuardEnabled: boolean
          subagentsEnabled: boolean
          feishuWebhookUrl: string
          feishuSecret: string
          feishuAppId: string
          feishuAppSecret: string
          feishuChatId: string
          imageEngine: '' | 'comfy' | 'openai'
          comfyDir: string
          comfyPythonPath: string
          comfyLaunchArgs: string
          comfyCheckpoint: string
          cloudImageRelay: string
          cloudImageKey: string
        }) => Promise<{ ok: boolean }>
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
        syncCustomModels: (ids: string[]) => Promise<{ ok: boolean }>
        onChanged: (cb: () => void) => () => void
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
        state: () => Promise<{ runningIds: string[]; queuedIds: string[] }>
        onRunFinished: (cb: (run: RoutineRun) => void) => () => void
        onStepProgress: (cb: (progress: RoutineStepProgress) => void) => () => void
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
          referenceUrls?: string[]
          maskDataUrl?: string
        }) => Promise<{ dataUrl: string; publicUrl: string | null } | { error: string }>
        history: (limit?: number) => Promise<ImageGenHistoryItem[] | { error: string }>
        historyDelete: (id: string) => Promise<{ ok: boolean }>
        comfyStart: () => Promise<
          | { ok: true; health: ImageGenHealth }
          | { error: string; health: ImageGenHealth }
        >
        comfyStop: () => Promise<{ ok: boolean; external: boolean }>
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

export type PiProvider = 'anthropic' | 'openai'

export type ImageGenEngine = 'openai' | 'comfy'

export type ImageGenHealth = {
  ok: boolean
  keyConfigured: boolean
  comfy: boolean
  comfyManaged: boolean
  comfyCheckpoint: string
  comfyCheckpointAvailable: boolean | null
  comfyCheckpoints: string[]
  comfyWorkflowReady: boolean
  comfyPythonVersion?: string
  comfyTorchVersion?: string
  comfyDevices: string[]
  comfyLastError?: string
  model: string
  r2: boolean
}

export type RoutineSchedule =
  | { type: 'interval'; minutes: number }
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; day: number; time: string }

export type RoutineNotify = 'always' | 'error' | 'never'

export type RoutineStepType = 'agent' | 'imagegen' | 'notify'

export type RoutineStep = {
  id: string
  name: string
  type: RoutineStepType
  prompt?: string
  engine?: ImageGenEngine
  channelId?: string
  message?: string
}

export type Routine = {
  id: string
  name: string
  prompt?: string
  steps: RoutineStep[]
  workspacePath: string
  schedule: RoutineSchedule
  enabled: boolean
  notify: RoutineNotify
  notifyChannelId?: string
  createdAt: number
  lastRunAt?: number
}

export type RoutineStepResult = {
  id: string
  name: string
  status: 'ok' | 'error' | 'timeout' | 'skipped'
  summary: string
  imageUrl?: string
  durationMs: number
}

export type ChannelType = 'feishu-webhook' | 'feishu-app' | 'webhook' | 'local'

export type Channel = {
  id: string
  name: string
  type: ChannelType
  url?: string
  secret?: string
  appId?: string
  appSecret?: string
  chatId?: string
}

export type RoutineRun = {
  id: string
  routineId: string
  routineName: string
  startedAt: number
  endedAt: number
  status: 'ok' | 'error' | 'timeout'
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
  prompt: string
  engine: string
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

export type Workspace = {
  path: string
  name: string
  lastOpenedAt: string
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

export type PiRuntimeEvent = AgentEvent | ExtensionUiRequest

export type AgentStatusEvent =
  | { status: 'started'; cwd: string; restoredSession: boolean; sessionFile?: string }
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
  AgentEvent,
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

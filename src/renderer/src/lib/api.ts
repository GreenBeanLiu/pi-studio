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

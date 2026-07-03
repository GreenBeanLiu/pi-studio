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
      settings: {
        load: () => Promise<{
          provider: PiProvider
          apiKey: string
          model: string
          baseUrl: string
          recentWorkspaces: Workspace[]
        }>
        save: (s: { provider: PiProvider; apiKey: string; model: string; baseUrl: string }) => Promise<{ ok: boolean }>
      }
      workspace: {
        list: () => Promise<Workspace[]>
        pickDirectory: () => Promise<string | null>
        open: (path: string) => Promise<{ ok: true; recentWorkspaces: Workspace[] } | { error: string }>
        remove: (path: string) => Promise<Workspace[]>
      }
      sessions: {
        list: () => Promise<SessionInfo[]>
        switch: (sessionPath: string) => Promise<{ cancelled: boolean }>
        rename: (name: string) => Promise<void>
        delete: (sessionPath: string) => Promise<{ ok: true } | { error: string }>
      }
      pi: {
        prompt: (message: string, images?: ImageContent[]) => Promise<void>
        steer: (message: string, images?: ImageContent[]) => Promise<void>
        followUp: (message: string, images?: ImageContent[]) => Promise<void>
        abort: () => Promise<void>
        bash: (command: string) => Promise<unknown>
        newSession: () => Promise<{ cancelled: boolean }>
        getState: () => Promise<RpcSessionState>
        getMessages: () => Promise<AgentMessage[]>
        getAvailableModels: () => Promise<ModelInfo[]>
        setModel: (provider: string, modelId: string) => Promise<{ provider: string; id: string }>
        onEvent: (cb: (event: AgentEvent) => void) => () => void
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

export type Workspace = {
  path: string
  name: string
  lastOpenedAt: string
}

export type RpcSessionState = {
  model?: { provider: string; id: string }
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
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

export type SessionInfo = {
  path: string
  id: string
  cwd: string
  name?: string
  firstMessage: string
  messageCount: number
  modified: string
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

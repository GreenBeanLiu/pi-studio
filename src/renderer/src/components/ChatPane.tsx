import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createStyles } from 'antd-style'
import { Spin, Popover, Segmented, Switch, Button, message as antdMessage, Modal, Tabs, Empty } from 'antd'
import { Markdown } from '@lobehub/ui'
import {
  SendHorizontal,
  ArrowDown,
  Square,
  FolderOpen,
  X,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Check,
  SlashSquare,
  Puzzle,
  FileText,
  Download,
  GitCompare,
  ExternalLink,
  RotateCcw,
  ShieldCheck,
  Activity,
} from 'lucide-react'
import {
  api,
  type Workspace,
  type AgentMessage,
  type ImageContent,
  type ModelInfo,
  type SlashCommand,
  type ThinkingLevel,
  type QueueMode,
  type GitDiffSnapshot,
  type GitChangedFile,
  type PiRuntimeEvent,
  type SessionExportFormat,
  type AgentStatusEvent,
} from '../lib/api'
import ToolCallCard, { type ToolExecutionState } from './ToolCallCard'

type AgentIssue = Exclude<AgentStatusEvent, { status: 'started' }>

type Props = {
  workspace: Workspace | null
  /** Agent subprocess is still booting for this workspace */
  starting?: boolean
  /** Non-recovering agent process failure reported by the main process */
  agentIssue?: AgentIssue | null
  restarting?: boolean
  onRestartAgent?: () => void
}

type RunStatus = 'running' | 'done' | 'error' | 'aborted'

type RunTimelineItem = {
  id: string
  type: 'event' | 'tool'
  label: string
  detail?: string
  timestamp: string
  status?: RunStatus
}

type RunToolRecord = {
  id: string
  toolName: string
  args?: unknown
  status: ToolExecutionState['status']
  result?: unknown
  startedAt: string
  endedAt?: string
}

type RunRecord = {
  id: string
  workspaceName?: string
  workspacePath?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  model?: string
  provider?: string
  thinking: ThinkingLevel
  tools: RunToolRecord[]
  timeline: RunTimelineItem[]
}

type MemorySuggestion = {
  id: string
  createdAt: string
  content: string
}

const useStyles = createStyles(({ token, css }) => ({
  pane: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    /* min-height:0 is essential: without it a flex item won't shrink below
       its content height, so a long conversation makes this pane grow past
       the overflow:hidden shell — clipping the input box off the bottom and
       leaving nothing for the messages area to scroll. */
    min-height: 0;
    background: ${token.colorBgBase};
  `,

  errorBanner: css`
    flex-shrink: 0;
    margin: 12px 16px 0;
    padding: 8px 14px;
    border-radius: ${token.borderRadius}px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: ${token.colorErrorBg};
    border: 1px solid ${token.colorErrorBorder};
    color: ${token.colorError};
    animation: slide-in-down 0.18s ease-out both;
  `,

  errorDismiss: css`
    background: none;
    border: none;
    color: ${token.colorError};
    cursor: pointer;
    opacity: 0.6;
    flex-shrink: 0;
    font-size: 14px;
    padding: 0;
    transition: opacity ${token.motionDurationFast};
    &:hover { opacity: 1; }
  `,

  messages: css`
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,

  messagesInner: css`
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
    padding: 16px 24px 88px;
    display: flex;
    flex-direction: column;
    flex: 1;
  `,

  emptyState: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    text-align: center;
    padding: 0 24px;
    color: ${token.colorTextSecondary};
  `,

  emptyTitle: css`
    font-size: 16px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0;
  `,

  emptyHint: css`
    font-size: 13px;
    color: ${token.colorTextTertiary};
    margin: 0;
    max-width: 360px;
    line-height: 1.6;
  `,

  msgRow: css`
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px 24px 6px;
    animation: msg-in 0.2s ease-out both;
  `,

  msgRowUser: css`
    flex-direction: row-reverse;
  `,

  msgContent: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 100%;
    flex: 1;
    min-width: 0;
  `,

  msgContentUser: css`
    align-items: flex-end;
    max-width: 70%;
  `,

  avatarBox: css`
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
  `,

  userAvatar: css`
    background: ${token.colorFill};
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
  `,

  agentAvatar: css`
    background: ${token.colorPrimaryBg};
    border: 1px solid ${token.colorPrimaryBorder};
    color: ${token.colorPrimary};
  `,

  msgBubble: css`
    padding: 9px 13px;
    font-size: 15px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-words;
    border-radius: ${token.borderRadiusLG}px;
    font-family: ${token.fontFamily};
  `,

  msgBubbleUser: css`
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
  `,

  msgBubbleAssistant: css`
    background: transparent;
    border: none;
    color: ${token.colorText};
    padding: 0;
    white-space: normal;
  `,

  thinkingToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 2px 0;
    cursor: pointer;
    user-select: none;
    width: fit-content;

    &:hover {
      color: ${token.colorTextSecondary};
    }
  `,

  thinkingChevron: css`
    transition: transform ${token.motionDurationFast};
  `,

  thinkingChevronOpen: css`
    transform: rotate(90deg);
  `,

  thinkingBlock: css`
    font-size: 12px;
    font-style: italic;
    color: ${token.colorTextTertiary};
    padding: 4px 0 4px 15px;
    white-space: pre-wrap;
  `,

  errorText: css`
    font-size: 13px;
    color: ${token.colorError};
    background: ${token.colorErrorBg};
    border: 1px solid ${token.colorErrorBorder};
    border-radius: ${token.borderRadius}px;
    padding: 8px 12px;
    white-space: pre-wrap;
    margin-top: 4px;
  `,

  runStatus: css`
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 0 4px 8px;
    user-select: none;
  `,

  runStatusDot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: ${token.colorPrimary};
    animation: typing-dot 1.4s ease-in-out infinite;
  `,

  inputArea: css`
    flex-shrink: 0;
    padding: 16px 20px 20px;
    background: color-mix(in srgb, ${token.colorBgBase} 88%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  `,

  inputAreaInner: css`
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
  `,

  inputBox: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-radius: 16px;
    padding: 12px 14px 8px;
    background: ${token.colorBgElevated};
    border: 1px solid ${token.colorBorder};
    box-shadow: ${token.boxShadowSecondary};
    transition: border-color ${token.motionDurationFast}, box-shadow ${token.motionDurationFast};
  `,

  inputControls: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,

  inputBoxFocused: css`
    border-color: ${token.colorPrimaryBorder};
    box-shadow: ${token.boxShadowSecondary}, 0 0 0 2px ${token.colorPrimary}18;
  `,

  inputTextarea: css`
    flex: 1;
    resize: none;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: ${token.colorText};
    font-family: ${token.fontFamily};
    line-height: 1.6;
    min-height: 46px;
    max-height: 200px;
    overflow-y: auto;
    padding: 0;

    &::placeholder {
      color: ${token.colorTextTertiary};
    }

    &:disabled {
      cursor: not-allowed;
    }
  `,

  sendBtn: css`
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background ${token.motionDurationFast}, color ${token.motionDurationFast}, opacity ${token.motionDurationFast};
    outline: none;

    &:disabled {
      cursor: not-allowed;
      opacity: 0.35;
    }
  `,

  modelChip: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid transparent;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    outline: none;
    font-family: ${token.fontFamily};
    transition: all ${token.motionDurationFast};

    &:hover {
      border-color: ${token.colorBorderSecondary};
      background: ${token.colorFillTertiary};
      color: ${token.colorTextSecondary};
    }
  `,

  diffMeta: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  `,

  reviewHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  `,

  reviewTitle: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,

  reviewName: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  reviewHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,

  reviewBody: css`
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    gap: 12px;
    min-height: 420px;
  `,

  reviewSidebar: css`
    min-width: 0;
    border-right: 1px solid ${token.colorBorderSecondary};
    padding-right: 12px;
  `,

  fileList: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 58vh;
    overflow-y: auto;
  `,

  fileRow: css`
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) 26px;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border-radius: ${token.borderRadiusSM}px;
    color: ${token.colorTextSecondary};

    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,

  fileStatus: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  filePath: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-family: ${token.fontFamilyCode};
  `,

  fileAction: css`
    width: 24px;
    height: 24px;
    border: none;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }
  `,

  reviewDiffPane: css`
    min-width: 0;
  `,

  memoryPath: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 8px;
    font-family: ${token.fontFamilyCode};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  memoryTextarea: css`
    width: 100%;
    min-height: 440px;
    resize: vertical;
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorText};
    padding: 12px;
    outline: none;
    font-family: ${token.fontFamilyCode};
    font-size: 13px;
    line-height: 1.65;

    &:focus {
      border-color: ${token.colorPrimaryBorder};
      box-shadow: 0 0 0 2px ${token.colorPrimary}18;
    }
  `,

  memorySuggestionHint: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.55;
    padding: 8px 10px;
    margin-bottom: 10px;
  `,

  diffMetaBlock: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    padding: 8px 10px;
    min-width: 0;
  `,

  diffMetaTitle: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
  `,

  diffPre: css`
    margin: 0;
    max-height: 58vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorText};
    padding: 12px;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.55;
  `,

  runSummaryGrid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
  `,

  runMetric: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    padding: 9px 10px;
    min-width: 0;
  `,

  runMetricLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 3px;
  `,

  runMetricValue: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  runList: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 60vh;
    overflow-y: auto;
    padding-right: 4px;
  `,

  runItem: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    overflow: hidden;
  `,

  runItemHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};
  `,

  runItemTitle: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,

  runItemName: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  runItemMeta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  runStatusBadge: css`
    flex-shrink: 0;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 12px;
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    background: ${token.colorBgElevated};
  `,

  runTimeline: css`
    display: flex;
    flex-direction: column;
    padding: 8px 12px 12px;
  `,

  runTimelineRow: css`
    display: grid;
    grid-template-columns: 72px 16px minmax(0, 1fr);
    gap: 8px;
    min-height: 30px;
    align-items: flex-start;
    color: ${token.colorTextSecondary};
    font-size: 12px;
  `,

  runTimelineTime: css`
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    padding-top: 3px;
  `,

  runTimelineDot: css`
    width: 8px;
    height: 8px;
    margin-top: 7px;
    border-radius: 50%;
    background: ${token.colorBorder};
  `,

  runTimelineText: css`
    min-width: 0;
    padding: 2px 0 7px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  runTimelineLabel: css`
    color: ${token.colorText};
    font-weight: 500;
  `,

  runTimelineDetail: css`
    margin-top: 2px;
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  paramsPanel: css`
    width: 300px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-family: ${token.fontFamily};

    .ant-segmented {
      width: 100%;
      font-family: ${token.fontFamily};
    }

    .ant-segmented-item-label {
      min-width: 0;
      padding-inline: 8px;
      overflow: visible;
      text-overflow: clip;
    }
  `,

  paramLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 5px;
    line-height: 1.4;
    user-select: none;
  `,

  paramHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 4px 0;
  `,

  modelList: css`
    max-height: 168px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,

  modelRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: ${token.borderRadiusSM}px;
    border: none;
    background: transparent;
    color: ${token.colorText};
    font-size: 12px;
    font-family: ${token.fontFamilyCode};
    cursor: pointer;
    outline: none;
    text-align: left;
    width: 100%;

    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,

  modelRowActive: css`
    background: ${token.colorFillSecondary};
    color: ${token.colorPrimary};
  `,

  paramGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  `,

  slashPanel: css`
    margin-bottom: 8px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowSecondary};
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
  `,

  slashItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: ${token.borderRadiusSM}px;
    cursor: pointer;
    font-size: 13px;
    color: ${token.colorText};
  `,

  slashItemActive: css`
    background: ${token.colorFillSecondary};
  `,

  slashName: css`
    font-weight: 500;
    flex-shrink: 0;
  `,

  slashDesc: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  imageStrip: css`
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  `,

  imageThumb: css`
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorder};
    overflow: hidden;
    flex-shrink: 0;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  `,

  imageRemove: css`
    position: absolute;
    top: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  `,

  scrollBottomBtn: css`
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorBgElevated};
    color: ${token.colorTextSecondary};
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: ${token.boxShadow};
    outline: none;
    z-index: 10;
  `,
}))

function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

function truncateString(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}\n...[truncated ${value.length - 4000} chars]` : value
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(startedAt: string, endedAt?: string): string {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  const total = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function summarizeToolArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object') {
    const obj = args as Record<string, unknown>
    const candidate = obj.command ?? obj.path ?? obj.file_path ?? obj.pattern ?? obj.query
    if (typeof candidate === 'string') return candidate
  }
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function runStatusLabel(status: RunStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'done') return '已完成'
  if (status === 'error') return '失败'
  return '已停止'
}

function runStatusColor(status: RunStatus, token: ReturnType<typeof useStyles>['theme']): string {
  if (status === 'running') return token.colorPrimary
  if (status === 'done') return token.colorSuccess
  if (status === 'error') return token.colorError
  return token.colorTextTertiary
}

function firstLine(value: string, limit = 220): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit)}...` : line
}

function latestUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if ((message as { role?: string }).role !== 'user') continue
    return firstLine(textOf((message as { content: never }).content))
  }
  return ''
}

function uniqueList(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, limit)
}

function bashCommandOf(tool: RunToolRecord): string | null {
  if (tool.toolName !== 'bash') return null
  if (!tool.args || typeof tool.args !== 'object') return null
  const command = (tool.args as Record<string, unknown>).command
  return typeof command === 'string' ? firstLine(command, 160) : null
}

function buildMemorySuggestion(
  workspace: Workspace | null,
  messages: AgentMessage[],
  run: RunRecord | undefined,
  diff: GitDiffSnapshot | null,
): MemorySuggestion | null {
  const task = latestUserText(messages)
  const changedFiles = uniqueList(diff?.files.map((file) => file.path) ?? [], 8)
  const commands = uniqueList((run?.tools ?? []).map(bashCommandOf).filter((cmd): cmd is string => !!cmd), 5)
  const tools = uniqueList((run?.tools ?? []).map((tool) => tool.toolName), 8)

  if (!task && changedFiles.length === 0 && commands.length === 0 && tools.length === 0) {
    return null
  }

  const createdAt = new Date().toISOString()
  const lines = [
    `## Session Note - ${createdAt.slice(0, 10)}`,
    workspace?.name ? `- Workspace: ${workspace.name}` : null,
    task ? `- Task: ${task}` : null,
    run ? `- Outcome: ${runStatusLabel(run.status)}` : null,
    changedFiles.length > 0 ? `- Files changed: ${changedFiles.join(', ')}` : null,
    commands.length > 0 ? `- Commands used: ${commands.join(' | ')}` : null,
    tools.length > 0 ? `- Tools used: ${tools.join(', ')}` : null,
  ].filter((line): line is string => !!line)

  return {
    id: `${createdAt}:memory:${shortId()}`,
    createdAt,
    content: lines.join('\n'),
  }
}

function sanitizeForDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max depth]'
  if (value == null) return value
  if (typeof value === 'string') return truncateString(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeForDiagnostics(item, depth + 1))

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase()
    if (
      normalized === 'data' ||
      normalized.includes('apikey') ||
      normalized.includes('api_key') ||
      normalized.includes('authorization') ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('token')
    ) {
      output[key] = '[redacted]'
      continue
    }
    output[key] = sanitizeForDiagnostics(item, depth + 1)
  }
  return output
}

function diagnosticFileName(workspaceName: string): string {
  const safeName = workspaceName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 48) || 'workspace'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `pi-studio-diagnostics-${safeName}-${stamp}.json`
}

function gitStatusLabel(file: GitChangedFile): string {
  if (file.statusCode === '??') return 'NEW'
  if (file.statusCode.includes('D')) return 'DEL'
  if (file.statusCode.includes('R')) return 'REN'
  if (file.statusCode.includes('A')) return 'ADD'
  if (file.statusCode.includes('M')) return 'MOD'
  return file.statusCode.trim() || 'CHG'
}

function agentIssueMessage(issue: AgentIssue): string {
  if (issue.status === 'exited') {
    const detail =
      issue.code === null ? `signal ${issue.signal ?? 'unknown'}` : `exit code ${issue.code}`
    return `Agent 进程已退出（${detail}）。当前会话记录仍保留，重启 agent 后可继续。`
  }
  return `Agent 进程异常：${issue.message}`
}

export default function ChatPane({
  workspace,
  starting = false,
  agentIssue = null,
  restarting = false,
  onRestartAgent,
}: Props) {
  const { styles, cx, theme: token } = useStyles()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolExecutions, setToolExecutions] = useState<Record<string, ToolExecutionState>>({})
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<{ provider: string; id: string } | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel>('off')
  const [steeringMode, setSteeringMode] = useState<QueueMode>('all')
  const [followUpMode, setFollowUpMode] = useState<QueueMode>('all')
  const [autoCompaction, setAutoCompaction] = useState(true)
  const [compacting, setCompacting] = useState(false)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [favoriteModels, setFavoriteModels] = useState<string[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffSnapshot, setDiffSnapshot] = useState<GitDiffSnapshot | null>(null)
  const [sessionExportLoading, setSessionExportLoading] = useState<SessionExportFormat | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySaving, setMemorySaving] = useState(false)
  const [memoryPath, setMemoryPath] = useState('')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memorySuggestionOpen, setMemorySuggestionOpen] = useState(false)
  const [memorySuggestionSaving, setMemorySuggestionSaving] = useState(false)
  const [memorySuggestion, setMemorySuggestion] = useState<MemorySuggestion | null>(null)
  const [memorySuggestionDraft, setMemorySuggestionDraft] = useState('')
  const [runTimelineOpen, setRunTimelineOpen] = useState(false)
  const [runRecords, setRunRecords] = useState<RunRecord[]>([])
  // Follow the stream only while the user is at the bottom; scrolling up
  // pauses following so reading history isn't fought by auto-scroll.
  const [autoFollow, setAutoFollow] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Index of the message currently being streamed (set by message_start),
  // so update/end events replace the right slot even if other messages
  // (e.g. tool results) land in between.
  const streamingIndexRef = useRef<number | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const messagesStateRef = useRef(messages)
  const runRecordsRef = useRef(runRecords)
  messagesStateRef.current = messages
  runRecordsRef.current = runRecords

  useEffect(() => {
    if (!agentIssue) return
    setSending(false)
    const runId = activeRunIdRef.current
    activeRunIdRef.current = null
    if (!runId) return

    const timestamp = new Date().toISOString()
    setRunRecords((prev) =>
      prev.map((run) =>
        run.id === runId
          ? {
              ...run,
              status: 'error',
              endedAt: timestamp,
              timeline: [
                ...run.timeline,
                {
                  id: `${runId}:agent-disconnect:${shortId()}`,
                  type: 'event',
                  label: 'Agent 已断开',
                  detail: agentIssueMessage(agentIssue),
                  timestamp,
                  status: 'error',
                },
              ],
            }
          : run,
      ),
    )
  }, [agentIssue])

  useEffect(() => {
    // Switching workspaces kills the old agent subprocess, so its agent_end
    // never arrives — reset streaming state here or the input stays disabled.
    setSending(false)
    setError(null)
    streamingIndexRef.current = null
    if (!workspace || starting) {
      setMessages([])
      setToolExecutions({})
      setRunRecords([])
      setMemorySuggestion(null)
      setMemorySuggestionDraft('')
      activeRunIdRef.current = null
      return
    }
    api.pi.getMessages().then(setMessages).catch(() => {})
    api.pi.getAvailableModels().then(setModels).catch(() => {})
    api.pi.getCommands().then(setCommands).catch(() => {})
    api.settings
      .load()
      .then((s) =>
        setFavoriteModels(
          (s.favoriteModels ?? '')
            .split(/[,，\n]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      )
      .catch(() => {})
    api.pi
      .getState()
      .then((s) => {
        if (!s) return
        setCurrentModel(s.model ? { provider: s.model.provider, id: s.model.id } : null)
        if (s.thinkingLevel) setThinking(s.thinkingLevel as ThinkingLevel)
        if (s.steeringMode) setSteeringMode(s.steeringMode)
        if (s.followUpMode) setFollowUpMode(s.followUpMode)
        if (typeof s.autoCompactionEnabled === 'boolean') setAutoCompaction(s.autoCompactionEnabled)
      })
      .catch(() => {})
  }, [workspace?.path])

  // For the completion notification — the event subscription effect runs once,
  // so it reads the current workspace through a ref.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const currentModelRef = useRef(currentModel)
  currentModelRef.current = currentModel
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking

  useEffect(() => {
    const off = api.pi.onEvent((event: PiRuntimeEvent) => {
      if (event.type === 'extension_ui_request') {
        const runId = activeRunIdRef.current
        if (runId) {
          const timestamp = new Date().toISOString()
          setRunRecords((prev) =>
            prev.map((run) =>
              run.id === runId
                ? {
                    ...run,
                    timeline: [
                      ...run.timeline,
                      {
                        id: `${timestamp}:ui:${shortId()}`,
                        type: 'event',
                        label:
                          event.method === 'confirm'
                            ? '等待用户确认'
                            : event.method === 'notify'
                              ? '扩展通知'
                              : '扩展请求',
                        detail: 'message' in event ? String(event.message) : event.method,
                        timestamp,
                        status: event.method === 'confirm' ? 'running' : undefined,
                      },
                    ],
                  }
                : run,
            ),
          )
        }
        if (event.method === 'confirm') {
          Modal.confirm({
            title: event.title,
            content: <div style={{ whiteSpace: 'pre-wrap' }}>{event.message}</div>,
            okText: '允许执行',
            cancelText: '拒绝',
            okButtonProps: { danger: true },
            onOk: () =>
              api.pi.extensionUiResponse({
                type: 'extension_ui_response',
                id: event.id,
                confirmed: true,
              }),
            onCancel: () =>
              api.pi.extensionUiResponse({
                type: 'extension_ui_response',
                id: event.id,
                confirmed: false,
              }),
          })
        } else if (event.method === 'notify') {
          const notify = event.notifyType === 'error' ? antdMessage.error : event.notifyType === 'warning' ? antdMessage.warning : antdMessage.info
          notify(event.message)
        } else if (event.method === 'input' || event.method === 'select' || event.method === 'editor') {
          api.pi
            .extensionUiResponse({
              type: 'extension_ui_response',
              id: event.id,
              cancelled: true,
            })
            .catch(() => {})
        }
        return
      }

      switch (event.type) {
        case 'agent_start':
          {
            const timestamp = new Date().toISOString()
            const id = `${timestamp}:run:${shortId()}`
            const model = currentModelRef.current
            activeRunIdRef.current = id
            setRunRecords((prev) =>
              [
                {
                  id,
                  workspaceName: workspaceRef.current?.name,
                  workspacePath: workspaceRef.current?.path,
                  startedAt: timestamp,
                  status: 'running',
                  model: model?.id,
                  provider: model?.provider,
                  thinking: thinkingRef.current,
                  tools: [],
                  timeline: [
                    {
                      id: `${id}:start`,
                      type: 'event',
                      label: 'Agent 开始',
                      detail: workspaceRef.current?.name,
                      timestamp,
                      status: 'running',
                    },
                  ],
                },
                ...prev,
              ].slice(0, 20),
            )
          }
          setSending(true)
          break
        case 'agent_end':
          let completedRunId: string | null = null
          let completedRunForMemory: RunRecord | undefined
          {
            const runId = activeRunIdRef.current
            const timestamp = new Date().toISOString()
            if (runId) {
              completedRunId = runId
              const currentRun = runRecordsRef.current.find((run) => run.id === runId)
              if (currentRun) {
                const status: RunStatus =
                  currentRun.status === 'aborted'
                    ? 'aborted'
                    : currentRun.tools.some((tool) => tool.status === 'error')
                      ? 'error'
                      : 'done'
                completedRunForMemory = { ...currentRun, endedAt: timestamp, status }
              }
              setRunRecords((prev) =>
                prev.map((run) =>
                  run.id === runId
                    ? {
                        ...run,
                        endedAt: timestamp,
                        status:
                          run.status === 'aborted'
                            ? 'aborted'
                            : run.tools.some((tool) => tool.status === 'error')
                              ? 'error'
                              : 'done',
                        timeline: [
                          ...run.timeline,
                          {
                            id: `${runId}:end`,
                            type: 'event',
                            label: 'Agent 结束',
                            timestamp,
                            status:
                              run.status === 'aborted'
                                ? 'aborted'
                                : run.tools.some((tool) => tool.status === 'error')
                                  ? 'error'
                                  : 'done',
                          },
                        ],
                      }
                    : run,
                ),
              )
            }
            activeRunIdRef.current = null
          }
          setSending(false)
          api.git
            .diff()
            .then((result) => {
              const snapshot = 'ok' in result ? result.snapshot : null
              if ('ok' in result && result.snapshot.status.trim()) {
                setDiffSnapshot(result.snapshot)
                setDiffOpen(true)
                antdMessage.info('Agent 修改了工作区，请检查后接受或回滚')
                if (completedRunId) {
                  const timestamp = new Date().toISOString()
                  setRunRecords((prev) =>
                    prev.map((run) =>
                      run.id === completedRunId
                        ? {
                            ...run,
                            timeline: [
                              ...run.timeline,
                              {
                                id: `${completedRunId}:git:${shortId()}`,
                                type: 'event',
                                label: '检测到 Git 变更',
                                detail: `${result.snapshot.files.length} 个文件变更`,
                                timestamp,
                                status: 'done',
                              },
                            ],
                          }
                        : run,
                    ),
                  )
                }
              }
              const suggestion = buildMemorySuggestion(
                workspaceRef.current,
                messagesStateRef.current,
                completedRunForMemory,
                snapshot,
              )
              if (suggestion) {
                setMemorySuggestion(suggestion)
                setMemorySuggestionDraft(suggestion.content)
                antdMessage.info('已生成 Workspace Memory 建议，可在“记忆建议”中确认')
              }
            })
            .catch(() => {
              const suggestion = buildMemorySuggestion(
                workspaceRef.current,
                messagesStateRef.current,
                completedRunForMemory,
                null,
              )
              if (suggestion) {
                setMemorySuggestion(suggestion)
                setMemorySuggestionDraft(suggestion.content)
                antdMessage.info('已生成 Workspace Memory 建议，可在“记忆建议”中确认')
              }
            })
          if (!document.hasFocus()) {
            api.win.flash()
            try {
              new Notification('任务完成', {
                body: workspaceRef.current ? `${workspaceRef.current.name} 的 agent 已完成` : 'agent 已完成',
                silent: false,
              })
            } catch {
              // Notification unavailable — taskbar flash already covers it
            }
          }
          break
        case 'message_start':
          setMessages((prev) => {
            streamingIndexRef.current = prev.length
            return [...prev, { ...event.message }]
          })
          break
        case 'message_update':
        case 'message_end':
          setMessages((prev) => {
            const idx = streamingIndexRef.current
            if (idx === null || idx >= prev.length) {
              streamingIndexRef.current = prev.length
              return [...prev, { ...event.message }]
            }
            const next = prev.slice()
            next[idx] = { ...event.message }
            return next
          })
          break
        case 'tool_execution_start':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              const timestamp = new Date().toISOString()
              const detail = summarizeToolArgs(event.args)
              setRunRecords((prev) =>
                prev.map((run) =>
                  run.id === runId
                    ? {
                        ...run,
                        tools: [
                          ...run.tools.filter((tool) => tool.id !== event.toolCallId),
                          {
                            id: event.toolCallId,
                            toolName: event.toolName,
                            args: event.args,
                            status: 'running',
                            startedAt: timestamp,
                          },
                        ],
                        timeline: [
                          ...run.timeline,
                          {
                            id: `${timestamp}:tool-start:${event.toolCallId}`,
                            type: 'tool',
                            label: `开始 ${event.toolName}`,
                            detail,
                            timestamp,
                            status: 'running',
                          },
                        ],
                      }
                    : run,
                ),
              )
            }
          }
          setToolExecutions((prev) => ({
            ...prev,
            [event.toolCallId]: { toolName: event.toolName, args: event.args, status: 'running' },
          }))
          break
        case 'tool_execution_update':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              setRunRecords((prev) =>
                prev.map((run) =>
                  run.id === runId
                    ? {
                        ...run,
                        tools: run.tools.map((tool) =>
                          tool.id === event.toolCallId ? { ...tool, result: event.partialResult } : tool,
                        ),
                      }
                    : run,
                ),
              )
            }
          }
          setToolExecutions((prev) => ({
            ...prev,
            [event.toolCallId]: {
              ...(prev[event.toolCallId] ?? { toolName: event.toolName, args: event.args, status: 'running' }),
              result: event.partialResult,
            },
          }))
          break
        case 'tool_execution_end':
          {
            const runId = activeRunIdRef.current
            if (runId) {
              const timestamp = new Date().toISOString()
              setRunRecords((prev) =>
                prev.map((run) =>
                  run.id === runId
                    ? {
                        ...run,
                        tools: run.tools.map((tool) =>
                          tool.id === event.toolCallId
                            ? {
                                ...tool,
                                toolName: event.toolName,
                                status: event.isError ? 'error' : 'done',
                                result: event.result,
                                endedAt: timestamp,
                              }
                            : tool,
                        ),
                        timeline: [
                          ...run.timeline,
                          {
                            id: `${timestamp}:tool-end:${event.toolCallId}`,
                            type: 'tool',
                            label: `${event.isError ? '失败' : '完成'} ${event.toolName}`,
                            timestamp,
                            status: event.isError ? 'error' : 'done',
                          },
                        ],
                      }
                    : run,
                ),
              )
            }
          }
          setToolExecutions((prev) => ({
            ...prev,
            [event.toolCallId]: {
              toolName: event.toolName,
              args: prev[event.toolCallId]?.args,
              status: event.isError ? 'error' : 'done',
              result: event.result,
            },
          }))
          break
        default:
          break
      }
    })
    return off
  }, [])

  useEffect(() => {
    // Scroll the messages container directly — scrollIntoView also scrolls
    // every scrollable ANCESTOR (overflow:hidden ones included), which
    // shoved the whole app shell up: title bar and input box vanished.
    const el = messagesRef.current
    if (el && autoFollow) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, autoFollow])

  // Elapsed-time ticker for the run status strip
  useEffect(() => {
    if (!sending) return
    setElapsed(0)
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(timer)
  }, [sending])

  // Tool cards get their status from the live event map, but that map is only
  // built from streaming events — reloaded history (getMessages on open /
  // session switch / remount) has toolCall blocks with no live entry, so they
  // would spin forever. pi persists each result as a `toolResult` message;
  // seed the map from those so historical (and just-finished) tools resolve.
  useEffect(() => {
    setToolExecutions((prev) => {
      let changed = false
      const next = { ...prev }
      for (const m of messages) {
        if ((m as { role: string }).role !== 'toolResult') continue
        const tr = m as unknown as {
          toolCallId: string
          toolName: string
          isError: boolean
          content: unknown
        }
        const status: ToolExecutionState['status'] = tr.isError ? 'error' : 'done'
        const existing = next[tr.toolCallId]
        if (!existing || existing.status !== status || existing.result === undefined) {
          next[tr.toolCallId] = { toolName: tr.toolName, args: existing?.args, status, result: tr.content }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [messages])

  const runningTool = useMemo(() => {
    const running = Object.values(toolExecutions).filter((t) => t.status === 'running')
    return running.length > 0 ? running[running.length - 1].toolName : null
  }, [toolExecutions])

  const latestRun = runRecords[0]
  const latestRunErrors = latestRun?.tools.filter((tool) => tool.status === 'error').length ?? 0

  const copyRunTimeline = useCallback(async () => {
    if (runRecords.length === 0) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(runRecords, null, 2))
      antdMessage.success('运行记录 JSON 已复制')
    } catch (err) {
      antdMessage.error((err as Error).message ?? '复制运行记录失败')
    }
  }, [runRecords])

  const abortCurrentRun = useCallback(async () => {
    const runId = activeRunIdRef.current
    if (runId) {
      const timestamp = new Date().toISOString()
      setRunRecords((prev) =>
        prev.map((run) =>
          run.id === runId
            ? {
                ...run,
                status: 'aborted',
                timeline: [
                  ...run.timeline,
                  {
                    id: `${runId}:abort:${shortId()}`,
                    type: 'event',
                    label: '用户停止',
                    timestamp,
                    status: 'aborted',
                  },
                ],
              }
            : run,
        ),
      )
    }
    await api.pi.abort()
  }, [])

  const exportDiagnostics = useCallback(async () => {
    if (!workspace) return

    try {
      const [state, appVersion, settings, logs] = await Promise.all([
        api.pi.getState().catch(() => null),
        api.app.version().catch(() => 'unknown'),
        api.settings.load().catch(() => null),
        api.diagnostics.getLogs().catch((err) => ({
          error: (err as Error).message ?? 'Failed to read app logs',
        })),
      ])
      const diagnostic = {
        exportedAt: new Date().toISOString(),
        app: {
          version: appVersion,
        },
        workspace: {
          name: workspace.name,
          path: workspace.path,
        },
        settings: settings
          ? {
              provider: settings.provider,
              model: settings.model,
              baseUrlConfigured: !!settings.baseUrl,
              apiKeyConfigured: !!settings.apiKey,
              tavilyConfigured: !!settings.tavilyApiKey,
              heliconeConfigured: !!settings.heliconeApiKey,
              securityGuardEnabled: settings.securityGuardEnabled,
              subagentsEnabled: settings.subagentsEnabled,
            }
          : null,
        session: sanitizeForDiagnostics(state),
        runtime: {
          sending,
          compacting,
          thinking,
          steeringMode,
          followUpMode,
          autoCompaction,
          currentModel,
          commandCount: commands.length,
          commands,
          messageCount: messages.length,
          toolExecutionCount: Object.keys(toolExecutions).length,
          runningTool,
          runRecordCount: runRecords.length,
          agentIssue: sanitizeForDiagnostics(agentIssue),
        },
        logs,
        toolExecutions: sanitizeForDiagnostics(toolExecutions),
        runRecords: sanitizeForDiagnostics(runRecords),
        messages: sanitizeForDiagnostics(messages.slice(-80)),
      }

      const result = await api.diagnostics.save({
        defaultPath: diagnosticFileName(workspace.name),
        content: JSON.stringify(diagnostic, null, 2),
      })

      if ('error' in result) {
        antdMessage.error(result.error)
      } else if ('ok' in result) {
        antdMessage.success('诊断包已导出')
      }
    } catch (err) {
      antdMessage.error((err as Error).message ?? '导出诊断包失败')
    }
  }, [
    workspace,
    sending,
    compacting,
    agentIssue,
    thinking,
    steeringMode,
    followUpMode,
    autoCompaction,
    currentModel,
    commands,
    messages,
    toolExecutions,
    runningTool,
    runRecords,
  ])

  const exportCurrentSession = useCallback(
    async (format: SessionExportFormat) => {
      if (!workspace || sessionExportLoading) return
      setSessionExportLoading(format)
      try {
        const result = await api.sessions.exportCurrent(format)
        if ('error' in result) {
          antdMessage.error(result.error)
        } else if ('ok' in result) {
          antdMessage.success(format === 'json' ? '会话 JSON 已导出' : '会话 Markdown 已导出')
        }
      } catch (err) {
        antdMessage.error((err as Error).message ?? '导出会话失败')
      } finally {
        setSessionExportLoading(null)
      }
    },
    [workspace, sessionExportLoading],
  )

  const openWorkspaceMemory = useCallback(async () => {
    if (!workspace || memoryLoading) return
    setMemoryOpen(true)
    setMemoryLoading(true)
    try {
      const result = await api.memory.load()
      if ('error' in result) {
        antdMessage.error(result.error)
        setMemoryOpen(false)
        return
      }
      setMemoryPath(result.memory.path)
      setMemoryDraft(result.memory.content)
    } catch (err) {
      antdMessage.error((err as Error).message ?? '读取 Workspace Memory 失败')
      setMemoryOpen(false)
    } finally {
      setMemoryLoading(false)
    }
  }, [workspace, memoryLoading])

  const saveWorkspaceMemory = useCallback(async () => {
    if (!workspace || memorySaving) return
    setMemorySaving(true)
    try {
      const result = await api.memory.save(memoryDraft)
      if ('error' in result) {
        antdMessage.error(result.error)
        return
      }
      setMemoryPath(result.memory.path)
      setMemoryDraft(result.memory.content)
      setMemoryOpen(false)
      antdMessage.success('Workspace Memory 已保存，下一轮任务生效')
    } catch (err) {
      antdMessage.error((err as Error).message ?? '保存 Workspace Memory 失败')
    } finally {
      setMemorySaving(false)
    }
  }, [workspace, memorySaving, memoryDraft])

  const applyMemorySuggestion = useCallback(async () => {
    if (!workspace || !memorySuggestionDraft.trim() || memorySuggestionSaving) return
    setMemorySuggestionSaving(true)
    try {
      const loaded = await api.memory.load()
      if ('error' in loaded) {
        antdMessage.error(loaded.error)
        return
      }

      const current = loaded.memory.content.trimEnd()
      const nextContent = `${current}\n\n${memorySuggestionDraft.trim()}\n`
      const saved = await api.memory.save(nextContent)
      if ('error' in saved) {
        antdMessage.error(saved.error)
        return
      }

      setMemoryPath(saved.memory.path)
      setMemoryDraft(saved.memory.content)
      setMemorySuggestion(null)
      setMemorySuggestionDraft('')
      setMemorySuggestionOpen(false)
      antdMessage.success('记忆建议已写入 Workspace Memory，下一轮任务生效')
    } catch (err) {
      antdMessage.error((err as Error).message ?? '保存记忆建议失败')
    } finally {
      setMemorySuggestionSaving(false)
    }
  }, [workspace, memorySuggestionDraft, memorySuggestionSaving])

  const openGitDiff = useCallback(async () => {
    if (!workspace) return
    setDiffOpen(true)
    setDiffLoading(true)
    try {
      const result = await api.git.diff()
      if ('error' in result) {
        antdMessage.error(result.error)
        setDiffSnapshot(null)
      } else {
        setDiffSnapshot(result.snapshot)
      }
    } catch (err) {
      antdMessage.error((err as Error).message ?? '读取 Git 变更失败')
      setDiffSnapshot(null)
    } finally {
      setDiffLoading(false)
    }
  }, [workspace])

  const acceptGitChanges = useCallback(() => {
    setDiffOpen(false)
    antdMessage.success('已接受当前工作区变更')
  }, [])

  const openChangedFile = useCallback(async (file: GitChangedFile) => {
    try {
      const result = await api.git.showFile(file.path)
      if ('error' in result) antdMessage.error(result.error)
    } catch (err) {
      antdMessage.error((err as Error).message ?? '打开文件失败')
    }
  }, [])

  const discardGitChanges = useCallback(() => {
    Modal.confirm({
      title: '回滚当前工作区变更？',
      content: '这会执行 git reset --hard 并删除未跟踪文件，当前未提交的代码修改会丢失。',
      okText: '回滚变更',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDiffLoading(true)
        try {
          const result = await api.git.discardChanges()
          if ('error' in result) {
            antdMessage.error(result.error)
            return
          }
          setDiffSnapshot(result.snapshot)
          antdMessage.success('工作区变更已回滚')
        } catch (err) {
          antdMessage.error((err as Error).message ?? '回滚工作区变更失败')
        } finally {
          setDiffLoading(false)
        }
      },
    })
  }, [])

  // While the agent runs, Enter queues a follow-up and Ctrl+Enter steers
  // (interrupts); when idle both are a plain prompt.
  const sendMessage = useCallback(
    async (mode: 'queue' | 'steer' = 'queue') => {
      const text = input.trim()
      if ((!text && images.length === 0) || !workspace || starting || agentIssue) return
      const imgs = images.length > 0 ? images : undefined
      setInput('')
      setImages([])
      setError(null)
      try {
        if (!sending) {
          setSending(true)
          await api.pi.prompt(text, imgs)
        } else if (mode === 'steer') {
          await api.pi.steer(text, imgs)
        } else {
          await api.pi.followUp(text, imgs)
        }
      } catch (err) {
        setError((err as Error).message ?? '发送失败')
        if (!sending) setSending(false)
      }
    },
    [input, images, sending, workspace, starting, agentIssue],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Slash palette captures navigation keys while open
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectSlash(slashMatches[Math.min(slashIndex, slashMatches.length - 1)])
        return
      }
    }
    if (slashFilter !== null && e.key === 'Escape') {
      setSlashDismissed(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(e.ctrlKey || e.metaKey ? 'steer' : 'queue')
    }
  }

  // ── Slash command palette ────────────────────────────────────────
  // Visible while the first token is being typed (`/…` with no space yet).
  const slashFilter =
    workspace && /^\/\S*$/.test(input) && !slashDismissed ? input.slice(1).toLowerCase() : null
  const slashMatches = useMemo(() => {
    if (slashFilter === null || commands.length === 0) return []
    return commands
      .filter(
        (c) =>
          c.name.toLowerCase().includes(slashFilter) ||
          (c.description ?? '').toLowerCase().includes(slashFilter),
      )
      .slice(0, 12)
  }, [slashFilter, commands])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashFilter])

  function selectSlash(cmd: SlashCommand) {
    setInput(`/${cmd.name} `)
    inputRef.current?.focus()
  }

  // ── Model switcher ───────────────────────────────────────────────
  const modelMenuItems = useMemo(() => {
    const favSet = new Set(favoriteModels.map((f) => f.toLowerCase()))
    const byProvider = new Map<string, ModelInfo[]>()
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? []
      list.push(m)
      byProvider.set(m.provider, list)
    }
    // User-configured favorites win; otherwise the registry appends models
    // chronologically, so the tail is the newest — show the latest few.
    const anyFavoriteExists =
      favSet.size > 0 && models.some((m) => favSet.has(m.id.toLowerCase()))
    return [...byProvider.entries()]
      .map(([provider, list]) => {
        const shown = anyFavoriteExists
          ? list.filter((m) => favSet.has(m.id.toLowerCase()))
          : list.slice(-8).reverse()
        return {
          type: 'group' as const,
          label: provider,
          children: shown.map((m) => ({
            key: `${m.provider}::${m.id}`,
            label: m.id,
          })),
        }
      })
      .filter((g) => g.children.length > 0)
  }, [models, favoriteModels])

  // ── Thinking level ───────────────────────────────────────────────
  const THINKING_LEVELS: { key: ThinkingLevel; label: string }[] = [
    { key: 'off', label: '关闭' },
    { key: 'minimal', label: '极简' },
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
    { key: 'xhigh', label: '极高' },
  ]
  const thinkingLabel = THINKING_LEVELS.find((t) => t.key === thinking)?.label ?? '关闭'

  async function handleThinkingSelect(level: ThinkingLevel) {
    try {
      await api.pi.setThinkingLevel(level)
      setThinking(level)
    } catch (err) {
      setError((err as Error).message ?? '切换推理深度失败')
    }
  }

  // Flat model list for the params panel (favorites, else newest-8 per provider)
  const modelList = useMemo(
    () => modelMenuItems.flatMap((g) => g.children.map((c) => ({ key: c.key, label: c.label }))),
    [modelMenuItems],
  )

  async function pickModel(key: string) {
    const sep = key.indexOf('::')
    try {
      const result = await api.pi.setModel(key.slice(0, sep), key.slice(sep + 2))
      setCurrentModel(result)
    } catch (err) {
      setError((err as Error).message ?? '切换模型失败')
    }
  }

  async function handleSteering(mode: QueueMode) {
    setSteeringMode(mode)
    api.pi.setSteeringMode(mode).catch(() => {})
  }
  async function handleFollowUp(mode: QueueMode) {
    setFollowUpMode(mode)
    api.pi.setFollowUpMode(mode).catch(() => {})
  }
  async function handleAutoCompaction(enabled: boolean) {
    setAutoCompaction(enabled)
    api.pi.setAutoCompaction(enabled).catch(() => {})
  }
  async function handleCompact() {
    setCompacting(true)
    try {
      await api.pi.compact()
    } catch (err) {
      setError((err as Error).message ?? '压缩失败')
    } finally {
      setCompacting(false)
    }
  }

  const paramsPanel = (
    <div className={styles.paramsPanel}>
      <div>
        <div className={styles.paramLabel}>模型</div>
        <div className={styles.modelList}>
          {modelList.length === 0 && <div className={styles.paramHint}>暂无可选模型</div>}
          {modelList.map((m) => {
            const active = currentModel && `${currentModel.provider}::${currentModel.id}` === m.key
            return (
              <button
                key={m.key}
                className={cx(styles.modelRow, active && styles.modelRowActive)}
                onClick={() => pickModel(m.key)}
              >
                {active && <Check size={12} />}
                <span style={{ marginLeft: active ? 0 : 18 }}>{m.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className={styles.paramLabel}>推理深度</div>
        <Segmented
          size="small"
          block
          value={thinking}
          onChange={(v) => handleThinkingSelect(v as ThinkingLevel)}
          options={THINKING_LEVELS.map((t) => ({ label: t.label, value: t.key }))}
        />
      </div>

      <div className={styles.paramGrid}>
        <div style={{ flex: 1 }}>
          <div className={styles.paramLabel}>插话模式</div>
          <Segmented
            size="small"
            block
            value={steeringMode}
            onChange={(v) => handleSteering(v as QueueMode)}
            options={[
              { label: '全部', value: 'all' },
              { label: '逐条', value: 'one-at-a-time' },
            ]}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className={styles.paramLabel}>排队模式</div>
          <Segmented
            size="small"
            block
            value={followUpMode}
            onChange={(v) => handleFollowUp(v as QueueMode)}
            options={[
              { label: '全部', value: 'all' },
              { label: '逐条', value: 'one-at-a-time' },
            ]}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className={styles.paramLabel} style={{ marginBottom: 0 }}>自动压缩上下文</span>
        <Switch size="small" checked={autoCompaction} onChange={handleAutoCompaction} />
      </div>

      <Button size="small" block loading={compacting} onClick={handleCompact}>
        立即压缩上下文
      </Button>
    </div>
  )

  const sessionExportPanel = (
    <div className={styles.paramsPanel} style={{ width: 180 }}>
      <Button
        size="small"
        block
        loading={sessionExportLoading === 'markdown'}
        onClick={() => exportCurrentSession('markdown')}
      >
        <FileText size={13} />
        Markdown
      </Button>
      <Button
        size="small"
        block
        loading={sessionExportLoading === 'json'}
        onClick={() => exportCurrentSession('json')}
      >
        <Download size={13} />
        JSON
      </Button>
    </div>
  )

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length === 0) return
    e.preventDefault()
    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        setImages((prev) => [...prev, { type: 'image', data: base64, mimeType: file.type }])
      }
      reader.readAsDataURL(file)
    }
  }

  const isEmpty = messages.length === 0
  const hasGitChanges = !!diffSnapshot?.status.trim()
  const changedFiles = diffSnapshot?.files ?? []
  const stagedCount = changedFiles.filter((file) => file.staged).length
  const unstagedCount = changedFiles.filter((file) => file.unstaged).length
  const diffReviewModal = (
    <Modal
      open={diffOpen}
      onCancel={() => setDiffOpen(false)}
      title="工作区变更审批"
      width={1120}
      centered
      footer={[
        <Button key="refresh" onClick={openGitDiff} loading={diffLoading}>
          刷新
        </Button>,
        <Button key="discard" danger disabled={!hasGitChanges || diffLoading} onClick={discardGitChanges}>
          <RotateCcw size={13} />
          回滚变更
        </Button>,
        <Button key="accept" type="primary" disabled={!hasGitChanges || diffLoading} onClick={acceptGitChanges}>
          <ShieldCheck size={13} />
          接受变更
        </Button>,
      ]}
    >
      {diffLoading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : !diffSnapshot ? (
        <Empty description="暂无 Git 信息" />
      ) : !hasGitChanges ? (
        <Empty description="工作区没有变更" />
      ) : (
        <>
          <div className={styles.reviewHeader}>
            <div className={styles.reviewTitle}>
              <div className={styles.reviewName}>{workspace?.name ?? 'Workspace'}</div>
              <div className={styles.reviewHint}>
                {changedFiles.length} 个文件变更，未暂存 {unstagedCount}，已暂存 {stagedCount}
              </div>
            </div>
            <div className={styles.reviewHint}>
              接受会保留当前变更；回滚会丢弃未提交修改和未跟踪文件。
            </div>
          </div>

          {diffSnapshot.truncated && (
            <div className={styles.errorText} style={{ marginBottom: 12 }}>
              Diff 内容较大，已截断显示。完整内容可在终端用 git diff 查看。
            </div>
          )}

          <div className={styles.reviewBody}>
            <div className={styles.reviewSidebar}>
              <div className={styles.diffMetaBlock} style={{ marginBottom: 10 }}>
                <div className={styles.diffMetaTitle}>文件</div>
                <div className={styles.fileList}>
                  {changedFiles.map((file) => (
                    <div key={`${file.statusCode}:${file.path}`} className={styles.fileRow}>
                      <span className={styles.fileStatus}>{gitStatusLabel(file)}</span>
                      <span
                        className={styles.filePath}
                        title={file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
                      >
                        {file.path}
                      </span>
                      <button
                        className={styles.fileAction}
                        onClick={() => openChangedFile(file)}
                        title="在文件夹中显示"
                      >
                        <ExternalLink size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.diffMetaBlock}>
                <div className={styles.diffMetaTitle}>统计</div>
                <pre className={styles.diffPre} style={{ maxHeight: 150 }}>
                  {[diffSnapshot.unstagedStat, diffSnapshot.stagedStat].filter(Boolean).join('\n') || '无'}
                </pre>
              </div>
            </div>

            <div className={styles.reviewDiffPane}>
              <Tabs
                items={[
                  {
                    key: 'unstaged',
                    label: '未暂存 diff',
                    children: diffSnapshot.unstagedDiff ? (
                      <pre className={styles.diffPre}>{diffSnapshot.unstagedDiff}</pre>
                    ) : (
                      <Empty description="没有未暂存 diff" />
                    ),
                  },
                  {
                    key: 'staged',
                    label: '已暂存 diff',
                    children: diffSnapshot.stagedDiff ? (
                      <pre className={styles.diffPre}>{diffSnapshot.stagedDiff}</pre>
                    ) : (
                      <Empty description="没有已暂存 diff" />
                    ),
                  },
                  {
                    key: 'status',
                    label: '状态',
                    children: <pre className={styles.diffPre}>{diffSnapshot.status || '无'}</pre>,
                  },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </Modal>
  )

  const workspaceMemoryModal = (
    <Modal
      open={memoryOpen}
      onCancel={() => setMemoryOpen(false)}
      title="Workspace Memory"
      width={780}
      centered
      footer={[
        <Button key="cancel" onClick={() => setMemoryOpen(false)}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={memorySaving} onClick={saveWorkspaceMemory}>
          保存记忆
        </Button>,
      ]}
    >
      {memoryLoading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : (
        <>
          <div className={styles.memoryPath} title={memoryPath}>
            {memoryPath || '.pi-studio/memory.md'}
          </div>
          <textarea
            className={styles.memoryTextarea}
            value={memoryDraft}
            onChange={(e) => setMemoryDraft(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
    </Modal>
  )

  const memorySuggestionModal = (
    <Modal
      open={memorySuggestionOpen}
      onCancel={() => setMemorySuggestionOpen(false)}
      title="Workspace Memory 建议"
      width={760}
      centered
      footer={[
        <Button
          key="discard"
          onClick={() => {
            setMemorySuggestion(null)
            setMemorySuggestionDraft('')
            setMemorySuggestionOpen(false)
          }}
        >
          丢弃建议
        </Button>,
        <Button key="cancel" onClick={() => setMemorySuggestionOpen(false)}>
          稍后处理
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={memorySuggestionSaving}
          disabled={!memorySuggestionDraft.trim()}
          onClick={applyMemorySuggestion}
        >
          写入记忆
        </Button>,
      ]}
    >
      {memorySuggestion ? (
        <>
          <div className={styles.memorySuggestionHint}>
            Pi Studio 根据刚结束的任务生成了这段候选记忆。请编辑后再写入；保存后会追加到当前工作区的
            .pi-studio/memory.md，并从下一轮任务开始注入上下文。
          </div>
          <textarea
            className={styles.memoryTextarea}
            value={memorySuggestionDraft}
            onChange={(e) => setMemorySuggestionDraft(e.target.value)}
            spellCheck={false}
            style={{ minHeight: 260 }}
          />
        </>
      ) : (
        <Empty description="暂无记忆建议" />
      )}
    </Modal>
  )

  const runTimelineModal = (
    <Modal
      open={runTimelineOpen}
      onCancel={() => setRunTimelineOpen(false)}
      title="运行记录"
      width={900}
      centered
      footer={[
        <Button key="copy" disabled={runRecords.length === 0} onClick={copyRunTimeline}>
          <Download size={13} />
          复制 JSON
        </Button>,
        <Button key="close" type="primary" onClick={() => setRunTimelineOpen(false)}>
          关闭
        </Button>,
      ]}
    >
      {runRecords.length === 0 ? (
        <Empty description="还没有运行记录" />
      ) : (
        <>
          <div className={styles.runSummaryGrid}>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>最近状态</div>
              <div className={styles.runMetricValue}>{runStatusLabel(latestRun.status)}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>耗时</div>
              <div className={styles.runMetricValue}>{formatDuration(latestRun.startedAt, latestRun.endedAt)}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>工具调用</div>
              <div className={styles.runMetricValue}>{latestRun.tools.length}</div>
            </div>
            <div className={styles.runMetric}>
              <div className={styles.runMetricLabel}>失败工具</div>
              <div className={styles.runMetricValue}>{latestRunErrors}</div>
            </div>
          </div>

          <div className={styles.runList}>
            {runRecords.map((run) => {
              const statusColor = runStatusColor(run.status, token)
              return (
                <div key={run.id} className={styles.runItem}>
                  <div className={styles.runItemHeader}>
                    <div className={styles.runItemTitle}>
                      <div className={styles.runItemName}>
                        {run.workspaceName ?? 'Workspace'} · {formatDuration(run.startedAt, run.endedAt)}
                      </div>
                      <div className={styles.runItemMeta}>
                        {formatClock(run.startedAt)}
                        {run.model ? ` · ${run.provider ?? 'model'}:${run.model}` : ''}
                        {` · 推理 ${run.thinking}`}
                        {` · ${run.tools.length} 个工具`}
                      </div>
                    </div>
                    <span
                      className={styles.runStatusBadge}
                      style={{ color: statusColor, borderColor: `${statusColor}55` }}
                    >
                      {runStatusLabel(run.status)}
                    </span>
                  </div>

                  <div className={styles.runTimeline}>
                    {run.timeline.map((item) => {
                      const itemColor = item.status ? runStatusColor(item.status, token) : token.colorBorder
                      return (
                        <div key={item.id} className={styles.runTimelineRow}>
                          <span className={styles.runTimelineTime}>{formatClock(item.timestamp)}</span>
                          <span className={styles.runTimelineDot} style={{ background: itemColor }} />
                          <div className={styles.runTimelineText}>
                            <div className={styles.runTimelineLabel}>{item.label}</div>
                            {item.detail && (
                              <div className={styles.runTimelineDetail} title={item.detail}>
                                {item.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )

  return (
    <div className={styles.pane}>
      {diffReviewModal}
      {workspaceMemoryModal}
      {memorySuggestionModal}
      {runTimelineModal}
      {error && (
        <div className={styles.errorBanner}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className={styles.errorDismiss} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {agentIssue && (
        <div className={styles.errorBanner}>
          <span style={{ flex: 1 }}>{agentIssueMessage(agentIssue)}</span>
          {onRestartAgent && (
            <Button size="small" type="primary" loading={restarting} onClick={onRestartAgent}>
              重启 agent
            </Button>
          )}
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          className={styles.messages}
          ref={messagesRef}
          // Wheel-up means "I want to read" — pause following immediately.
          // The scroll-position check alone can't do this: one wheel notch
          // (~100px) stays inside any reasonable near-bottom threshold, so
          // the next stream tick would snap the view right back.
          onWheel={(e) => {
            if (e.deltaY < 0) setAutoFollow(false)
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight
            setShowScrollBtn(dist > 200)
            if (dist < 20) setAutoFollow(true) // truly back at the bottom
            else if (dist > 150) setAutoFollow(false) // scrollbar drags etc.
          }}
        >
          <div className={styles.messagesInner}>
            {!workspace ? (
              <div className={styles.emptyState}>
                <FolderOpen size={36} color={token.colorTextTertiary} />
                <p className={styles.emptyTitle}>还没有打开工作区</p>
                <p className={styles.emptyHint}>从左上角选择一个项目目录，开始和 agent 对话。</p>
              </div>
            ) : starting ? (
              <div className={styles.emptyState}>
                <Spin size="small" />
                <p className={styles.emptyTitle}>{workspace.name}</p>
                <p className={styles.emptyHint}>正在启动 agent 进程…</p>
              </div>
            ) : isEmpty ? (
              <div className={styles.emptyState}>
                <p className={styles.emptyTitle}>{workspace.name}</p>
                <p className={styles.emptyHint}>向 agent 描述你想做的事，它可以读文件、跑命令、改代码。</p>
              </div>
            ) : (
              messages.map((msg, i) => (
                <MessageBubble
                  key={i}
                  msg={msg}
                  toolExecutions={toolExecutions}
                  styles={styles}
                  cx={cx}
                />
              ))
            )}

          </div>
        </div>

        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, pointerEvents: 'none',
          background: `linear-gradient(to bottom, transparent, ${token.colorBgBase})`,
        }} />

        {showScrollBtn && (
          <button
            className={styles.scrollBottomBtn}
            onClick={() => {
              const el = messagesRef.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>

      <div className={styles.inputArea}>
        <div className={styles.inputAreaInner}>
          {sending && (
            <div className={styles.runStatus}>
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className={styles.runStatusDot}
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
              <span>
                {runningTool ? `正在执行 ${runningTool}` : '思考中'} · 已运行 {elapsed}s
              </span>
            </div>
          )}
          {slashFilter !== null && slashMatches.length === 0 && (
            <div className={styles.slashPanel}>
              <div className={styles.slashItem} style={{ cursor: 'default' }}>
                <span className={styles.slashDesc}>
                  {commands.length === 0
                    ? '此工作区没有可用命令 — 把 skills / prompt 模板放进工作区的 .pi/ 目录或 pi 的配置目录后重新打开'
                    : '没有匹配的命令'}
                </span>
              </div>
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className={styles.slashPanel}>
              {slashMatches.map((c, i) => {
                const SourceIcon =
                  c.source === 'extension' ? Puzzle : c.source === 'prompt' ? FileText : SlashSquare
                return (
                  <div
                    key={`${c.source}:${c.name}`}
                    className={cx(styles.slashItem, i === slashIndex && styles.slashItemActive)}
                    onMouseEnter={() => setSlashIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault() // keep textarea focus
                      selectSlash(c)
                    }}
                  >
                    <SourceIcon size={13} color={token.colorTextTertiary} />
                    <span className={styles.slashName}>/{c.name}</span>
                    {c.description && <span className={styles.slashDesc}>{c.description}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <div className={cx(styles.inputBox, inputFocused && styles.inputBoxFocused)}>
            {images.length > 0 && (
              <div className={styles.imageStrip}>
                {images.map((img, i) => (
                  <div key={i} className={styles.imageThumb}>
                    <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                    <button
                      className={styles.imageRemove}
                      onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setSlashDismissed(false)
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={
                !workspace
                  ? '请先打开一个工作区'
                  : starting
                    ? '正在启动 agent…'
                    : agentIssue
                      ? 'Agent 已断开，请重启后继续'
                      : sending
                        ? 'Agent 运行中，Enter 排队 · Ctrl+Enter 立即插话'
                        : '向 agent 描述任务，/ 唤起命令，可粘贴截图'
              }
              rows={1}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className={styles.inputTextarea}
              disabled={!workspace || starting || !!agentIssue}
            />
            <div className={styles.inputControls}>
              {workspace && (
                <Popover
                  trigger={['hover', 'click']}
                  placement="topLeft"
                  mouseEnterDelay={0.15}
                  mouseLeaveDelay={0.25}
                  content={paramsPanel}
                >
                  <button className={styles.modelChip} title="模型与参数">
                    <SlidersHorizontal size={11} />
                    {currentModel ? currentModel.id : '默认模型'}
                    <span style={{ opacity: 0.6 }}>· 推理：{thinkingLabel}</span>
                    <ChevronDown size={11} />
                  </button>
                </Popover>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={exportDiagnostics} title="导出诊断包">
                  <Download size={11} />
                  诊断包
                </button>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={() => setRunTimelineOpen(true)} title="查看运行记录">
                  <Activity size={11} />
                  运行
                </button>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={openWorkspaceMemory} title="编辑 Workspace Memory">
                  <FileText size={11} />
                  记忆
                </button>
              )}
              {workspace && memorySuggestion && (
                <button
                  className={styles.modelChip}
                  onClick={() => setMemorySuggestionOpen(true)}
                  title="查看 Workspace Memory 建议"
                  style={{ color: token.colorPrimary }}
                >
                  <Check size={11} />
                  记忆建议
                </button>
              )}
              {workspace && (
                <Popover
                  trigger={['click']}
                  placement="top"
                  content={sessionExportPanel}
                >
                  <button className={styles.modelChip} title="导出当前会话">
                    <FileText size={11} />
                    会话
                  </button>
                </Popover>
              )}
              {workspace && (
                <button className={styles.modelChip} onClick={openGitDiff} title="查看工作区变更">
                  <GitCompare size={11} />
                  变更
                </button>
              )}
              <div style={{ flex: 1 }} />
              {sending && (
                <button
                  onClick={abortCurrentRun}
                  className={styles.sendBtn}
                  style={{ background: token.colorFill, color: token.colorTextSecondary }}
                  title="停止"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                onClick={() => sendMessage('queue')}
                disabled={(!input.trim() && images.length === 0) || !workspace || starting || !!agentIssue}
                className={styles.sendBtn}
                title={sending ? '排队（跑完后执行）' : '发送'}
                style={{
                  background:
                    input.trim() || images.length > 0
                      ? token.colorPrimary
                      : token.colorFillSecondary,
                  color: input.trim() || images.length > 0 ? '#ffffff' : token.colorTextTertiary,
                }}
              >
                <SendHorizontal size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type StylesType = ReturnType<typeof useStyles>['styles']
type CxType = ReturnType<typeof useStyles>['cx']

// Thinking is collapsed by default — it's the model's scratch reasoning,
// useful on demand but noise in the normal read.
function ThinkingBlock({ text, styles, cx }: { text: string; styles: StylesType; cx: CxType }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div className={styles.thinkingToggle} onClick={() => setOpen((v) => !v)}>
        <ChevronRight
          size={11}
          className={cx(styles.thinkingChevron, open && styles.thinkingChevronOpen)}
        />
        思考过程
      </div>
      {open && <div className={styles.thinkingBlock}>{text}</div>}
    </div>
  )
}

// memo: during streaming only the message being updated changes reference,
// so earlier bubbles skip re-rendering (and re-parsing their Markdown).
const MessageBubble = memo(function MessageBubble({
  msg,
  toolExecutions,
  styles,
  cx,
}: {
  msg: AgentMessage
  toolExecutions: Record<string, ToolExecutionState>
  styles: StylesType
  cx: CxType
}) {
  if (msg.role !== 'user' && msg.role !== 'assistant') return null

  const isUser = msg.role === 'user'

  return (
    <div className={cx(styles.msgRow, isUser && styles.msgRowUser)}>
      <div className={cx(styles.avatarBox, isUser ? styles.userAvatar : styles.agentAvatar)}>
        {isUser ? '我' : 'π'}
      </div>

      <div className={cx(styles.msgContent, isUser && styles.msgContentUser)}>
        {isUser ? (
          <div className={cx(styles.msgBubble, styles.msgBubbleUser)}>
            {Array.isArray(msg.content) &&
              msg.content.some((c) => (c as { type: string }).type === 'image') && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {(msg.content as Array<{ type: string; data?: string; mimeType?: string }>)
                    .filter((c) => c.type === 'image' && c.data)
                    .map((c, j) => (
                      <img
                        key={j}
                        src={`data:${c.mimeType};base64,${c.data}`}
                        alt=""
                        style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, display: 'block' }}
                      />
                    ))}
                </div>
              )}
            {textOf(msg.content as never)}
          </div>
        ) : (
          <div className={cx(styles.msgBubble, styles.msgBubbleAssistant)}>
            {msg.content.map((block, i) => {
              if (block.type === 'text') {
                return block.text ? (
                  <Markdown key={i} variant="chat" fontSize={15} style={{ margin: 0 }} enableLatex={false} enableMermaid={false} enableImageGallery={false}>
                    {block.text}
                  </Markdown>
                ) : null
              }
              if (block.type === 'thinking') {
                return block.thinking ? (
                  <ThinkingBlock key={i} text={block.thinking} styles={styles} cx={cx} />
                ) : null
              }
              if (block.type === 'toolCall') {
                return <ToolCallCard key={block.id} call={block} execution={toolExecutions[block.id]} />
              }
              return null
            })}
            {msg.role === 'assistant' && msg.errorMessage && (
              <div className={styles.errorText}>{msg.errorMessage}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

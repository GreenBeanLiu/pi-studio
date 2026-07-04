import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createStyles } from 'antd-style'
import { Dropdown, Spin } from 'antd'
import { Markdown } from '@lobehub/ui'
import {
  SendHorizontal,
  ArrowDown,
  Square,
  FolderOpen,
  X,
  ChevronDown,
  Cpu,
  SlashSquare,
  Puzzle,
  FileText,
} from 'lucide-react'
import {
  api,
  type Workspace,
  type AgentEvent,
  type AgentMessage,
  type ImageContent,
  type ModelInfo,
  type SlashCommand,
} from '../lib/api'
import ToolCallCard, { type ToolExecutionState } from './ToolCallCard'

type Props = {
  workspace: Workspace | null
  /** Agent subprocess is still booting for this workspace */
  starting?: boolean
}

const useStyles = createStyles(({ token, css }) => ({
  pane: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
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
    max-width: 780px;
    margin: 0 auto;
    padding: 16px 0 88px;
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
    font-size: 14px;
    line-height: 1.6;
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

  thinkingBlock: css`
    font-size: 12px;
    font-style: italic;
    color: ${token.colorTextTertiary};
    padding: 4px 0;
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
    max-width: 780px;
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
    font-size: 11px;
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
    margin-bottom: 8px;
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

export default function ChatPane({ workspace, starting = false }: Props) {
  const { styles, cx, theme: token } = useStyles()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolExecutions, setToolExecutions] = useState<Record<string, ToolExecutionState>>({})
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<{ provider: string; id: string } | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [favoriteModels, setFavoriteModels] = useState<string[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
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

  useEffect(() => {
    // Switching workspaces kills the old agent subprocess, so its agent_end
    // never arrives — reset streaming state here or the input stays disabled.
    setSending(false)
    setError(null)
    streamingIndexRef.current = null
    if (!workspace || starting) {
      setMessages([])
      setToolExecutions({})
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
      .then((s) => setCurrentModel(s?.model ? { provider: s.model.provider, id: s.model.id } : null))
      .catch(() => {})
  }, [workspace?.path])

  // For the completion notification — the event subscription effect runs once,
  // so it reads the current workspace through a ref.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  useEffect(() => {
    const off = api.pi.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setSending(true)
          break
        case 'agent_end':
          setSending(false)
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
          setToolExecutions((prev) => ({
            ...prev,
            [event.toolCallId]: { toolName: event.toolName, args: event.args, status: 'running' },
          }))
          break
        case 'tool_execution_update':
          setToolExecutions((prev) => ({
            ...prev,
            [event.toolCallId]: {
              ...(prev[event.toolCallId] ?? { toolName: event.toolName, args: event.args, status: 'running' }),
              result: event.partialResult,
            },
          }))
          break
        case 'tool_execution_end':
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

  const runningTool = useMemo(() => {
    const running = Object.values(toolExecutions).filter((t) => t.status === 'running')
    return running.length > 0 ? running[running.length - 1].toolName : null
  }, [toolExecutions])

  // While the agent runs, Enter queues a follow-up and Ctrl+Enter steers
  // (interrupts); when idle both are a plain prompt.
  const sendMessage = useCallback(
    async (mode: 'queue' | 'steer' = 'queue') => {
      const text = input.trim()
      if ((!text && images.length === 0) || !workspace) return
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
    [input, images, sending, workspace],
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

  async function handleModelSelect({ key }: { key: string }) {
    const sep = key.indexOf('::')
    const provider = key.slice(0, sep)
    const id = key.slice(sep + 2)
    try {
      const result = await api.pi.setModel(provider, id)
      setCurrentModel(result)
    } catch (err) {
      setError((err as Error).message ?? '切换模型失败')
    }
  }

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

  return (
    <div className={styles.pane}>
      {error && (
        <div className={styles.errorBanner}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className={styles.errorDismiss} onClick={() => setError(null)}>✕</button>
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
          <div className={cx(styles.inputBox, inputFocused && styles.inputBoxFocused)}>
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
                    : sending
                      ? 'Agent 运行中，Enter 排队 · Ctrl+Enter 立即插话'
                      : '向 agent 描述任务，/ 唤起命令，可粘贴截图'
              }
              rows={1}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className={styles.inputTextarea}
              disabled={!workspace || starting}
            />
            <div className={styles.inputControls}>
              {workspace && (
                <Dropdown
                  trigger={['click']}
                  placement="topLeft"
                  menu={{
                    items: modelMenuItems,
                    onClick: handleModelSelect,
                    selectedKeys: currentModel
                      ? [`${currentModel.provider}::${currentModel.id}`]
                      : [],
                    style: { maxHeight: 320, overflowY: 'auto' },
                  }}
                  disabled={models.length === 0}
                >
                  <button className={styles.modelChip} title="切换模型">
                    <Cpu size={11} />
                    {currentModel ? currentModel.id : '默认模型'}
                    <ChevronDown size={11} />
                  </button>
                </Dropdown>
              )}
              <div style={{ flex: 1 }} />
              {sending && (
                <button
                  onClick={() => api.pi.abort()}
                  className={styles.sendBtn}
                  style={{ background: token.colorFill, color: token.colorTextSecondary }}
                  title="停止"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                onClick={() => sendMessage('queue')}
                disabled={(!input.trim() && images.length === 0) || !workspace}
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
                  <Markdown key={i} variant="chat" fontSize={14} style={{ margin: 0 }} enableLatex={false} enableMermaid={false} enableImageGallery={false}>
                    {block.text}
                  </Markdown>
                ) : null
              }
              if (block.type === 'thinking') {
                return block.thinking ? (
                  <div key={i} className={styles.thinkingBlock}>{block.thinking}</div>
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

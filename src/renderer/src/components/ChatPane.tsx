import { useEffect, useRef, useState, useCallback } from 'react'
import { createStyles } from 'antd-style'
import { Markdown } from '@lobehub/ui'
import { SendHorizontal, ArrowDown, Square, SquarePen, FolderOpen } from 'lucide-react'
import { api, type Workspace, type AgentEvent, type AgentMessage } from '../lib/api'
import ToolCallCard, { type ToolExecutionState } from './ToolCallCard'

type Props = {
  workspace: Workspace | null
}

const useStyles = createStyles(({ token, css }) => ({
  pane: css`
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: ${token.colorBgBase};
  `,

  toolbar: css`
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 16px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    gap: 8px;
  `,

  newSessionBtn: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorder};
    background: transparent;
    color: ${token.colorTextSecondary};
    cursor: pointer;
    outline: none;
    font-family: ${token.fontFamily};
    transition: all ${token.motionDurationFast};

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      color: ${token.colorText};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
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

  typingBubble: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
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
    align-items: flex-end;
    gap: 8px;
    border-radius: 16px;
    padding: 12px 14px;
    background: ${token.colorBgElevated};
    border: 1px solid ${token.colorBorder};
    box-shadow: ${token.boxShadowSecondary};
    transition: border-color ${token.motionDurationFast}, box-shadow ${token.motionDurationFast};
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
    max-height: 160px;
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

  inputHint: css`
    text-align: center;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-top: 8px;
    user-select: none;
    opacity: 0;
    transition: opacity ${token.motionDurationMid};
  `,

  kbdKey: css`
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorFillTertiary};
    font-size: 10px;
    height: 18px;
    font-family: ${token.fontFamily};
    color: ${token.colorTextTertiary};
    vertical-align: middle;
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

export default function ChatPane({ workspace }: Props) {
  const { styles, cx, theme: token } = useStyles()
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [toolExecutions, setToolExecutions] = useState<Record<string, ToolExecutionState>>({})
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!workspace) {
      setMessages([])
      setToolExecutions({})
      return
    }
    api.pi.getMessages().then(setMessages).catch(() => {})
  }, [workspace?.path])

  useEffect(() => {
    const off = api.pi.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setSending(true)
          break
        case 'agent_end':
          setSending(false)
          break
        case 'message_start':
          setMessages((prev) => [...prev, { ...event.message }])
          break
        case 'message_update':
        case 'message_end':
          setMessages((prev) => {
            if (prev.length === 0) return [{ ...event.message }]
            return [...prev.slice(0, -1), { ...event.message }]
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
    const el = messagesRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (isNearBottom || sending) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, sending])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || sending || !workspace) return
    setInput('')
    setError(null)
    setSending(true)
    try {
      await api.pi.prompt(text)
    } catch (err) {
      setError((err as Error).message ?? '发送失败')
      setSending(false)
    }
  }, [input, sending, workspace])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  async function handleNewSession() {
    if (!workspace || sending) return
    await api.pi.newSession()
    setMessages([])
    setToolExecutions({})
  }

  const isEmpty = messages.length === 0

  return (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        <button className={styles.newSessionBtn} onClick={handleNewSession} disabled={!workspace || sending}>
          <SquarePen size={12} />
          新建会话
        </button>
      </div>

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
          onScroll={(e) => {
            const el = e.currentTarget
            setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200)
          }}
        >
          <div className={styles.messagesInner}>
            {!workspace ? (
              <div className={styles.emptyState}>
                <FolderOpen size={36} color={token.colorTextTertiary} />
                <p className={styles.emptyTitle}>还没有打开工作区</p>
                <p className={styles.emptyHint}>从左上角选择一个项目目录，开始和 agent 对话。</p>
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

            {sending && !isEmpty && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className={styles.msgRow}>
                <div className={cx(styles.avatarBox, styles.agentAvatar)}>π</div>
                <div className={styles.typingBubble}>
                  {[0, 160, 320].map((delay) => (
                    <span
                      key={delay}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        display: 'inline-block',
                        backgroundColor: token.colorPrimary,
                        animation: 'typing-dot 1.4s ease-in-out infinite',
                        animationDelay: `${delay}ms`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, pointerEvents: 'none',
          background: `linear-gradient(to bottom, transparent, ${token.colorBgBase})`,
        }} />

        {showScrollBtn && (
          <button className={styles.scrollBottomBtn} onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}>
            <ArrowDown size={14} />
          </button>
        )}
      </div>

      <div className={styles.inputArea}>
        <div className={styles.inputAreaInner}>
          <div className={cx(styles.inputBox, inputFocused && styles.inputBoxFocused)}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={workspace ? '向 agent 描述任务…' : '请先打开一个工作区'}
              rows={1}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className={styles.inputTextarea}
              disabled={!workspace || sending}
            />
            {sending ? (
              <button
                onClick={() => api.pi.abort()}
                className={styles.sendBtn}
                style={{ background: token.colorFill, color: token.colorTextSecondary }}
                title="停止"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim() || !workspace}
                className={styles.sendBtn}
                style={{
                  background: input.trim() ? token.colorPrimary : token.colorFillSecondary,
                  color: input.trim() ? '#ffffff' : token.colorTextTertiary,
                }}
              >
                <SendHorizontal size={14} />
              </button>
            )}
          </div>
          <p className={styles.inputHint} style={{ opacity: inputFocused ? 1 : 0 }}>
            <span className={styles.kbdKey}>Enter</span> 发送
            <span style={{ margin: '0 6px', opacity: 0.4 }}>·</span>
            <span className={styles.kbdKey}>Shift+Enter</span> 换行
          </p>
        </div>
      </div>
    </div>
  )
}

type StylesType = ReturnType<typeof useStyles>['styles']
type CxType = ReturnType<typeof useStyles>['cx']

function MessageBubble({
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
}

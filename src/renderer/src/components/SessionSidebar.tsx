import { useCallback, useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { SquarePen, Trash2, Pencil, Check, X } from 'lucide-react'
import { api, type Workspace, type SessionInfo } from '../lib/api'

type Props = {
  workspace: Workspace
  /** Called after the active session changed (switch / new), so the chat pane can reload. */
  onSessionChanged: () => void
}

const useStyles = createStyles(({ token, css }) => ({
  sidebar: css`
    width: 232px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: ${token.colorBgLayout};
    border-right: 1px solid ${token.colorBorderSecondary};
    min-height: 0;
  `,

  header: css`
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,

  headerTitle: css`
    font-size: 12px;
    font-weight: 600;
    color: ${token.colorTextSecondary};
    user-select: none;
  `,

  iconBtn: css`
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    color: ${token.colorTextSecondary};
    cursor: pointer;
    outline: none;
    transition: all ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `,

  list: css`
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,

  item: css`
    position: relative;
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillTertiary};
    }

    &:hover .session-actions {
      opacity: 1;
    }
  `,

  itemActive: css`
    background: ${token.colorFillSecondary} !important;
    border-color: ${token.colorBorderSecondary};
  `,

  itemTitle: css`
    font-size: 13px;
    color: ${token.colorText};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.5;
  `,

  itemMeta: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
    margin-top: 2px;
    user-select: none;
  `,

  actions: css`
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity ${token.motionDurationFast};
    background: ${token.colorBgLayout};
    border-radius: ${token.borderRadiusSM}px;
  `,

  actionBtn: css`
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    outline: none;

    &:hover {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }
  `,

  renameInput: css`
    width: 100%;
    font-size: 13px;
    padding: 2px 6px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorPrimaryBorder};
    background: ${token.colorBgElevated};
    color: ${token.colorText};
    outline: none;
    font-family: ${token.fontFamily};
  `,

  empty: css`
    padding: 24px 12px;
    text-align: center;
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}))

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString()
}

export default function SessionSidebar({ workspace, onSessionChanged }: Props) {
  const { styles, cx } = useStyles()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, state] = await Promise.all([api.sessions.list(), api.pi.getState()])
      setSessions(list)
      setActivePath(state.sessionFile ?? null)
    } catch {
      // workspace not started yet
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, workspace.path])

  // Message counts / ordering change as the agent works; refresh when it goes idle.
  useEffect(() => {
    return api.pi.onEvent((event) => {
      if (event.type === 'agent_end') refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  async function handleNewSession() {
    if (busy) return
    setBusy(true)
    try {
      await api.pi.newSession()
      await refresh()
      onSessionChanged()
    } finally {
      setBusy(false)
    }
  }

  async function handleSwitch(session: SessionInfo) {
    if (busy || session.path === activePath) return
    setBusy(true)
    try {
      const result = await api.sessions.switch(session.path)
      if (!result.cancelled) {
        await refresh()
        onSessionChanged()
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(session: SessionInfo, e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    await api.sessions.delete(session.path)
    refresh()
  }

  function startRename(session: SessionInfo, e: React.MouseEvent) {
    e.stopPropagation()
    setRenameValue(session.name ?? '')
    setRenaming(true)
  }

  async function commitRename() {
    setRenaming(false)
    await api.sessions.rename(renameValue.trim())
    refresh()
  }

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>会话</span>
        <button className={styles.iconBtn} onClick={handleNewSession} disabled={busy} title="新建会话">
          <SquarePen size={14} />
        </button>
      </div>

      <div className={styles.list}>
        {sessions.length === 0 && <div className={styles.empty}>还没有历史会话</div>}
        {sessions.map((s) => {
          const isActive = s.path === activePath
          return (
            <div
              key={s.path}
              className={cx(styles.item, isActive && styles.itemActive)}
              onClick={() => handleSwitch(s)}
            >
              {isActive && renaming ? (
                <input
                  ref={renameInputRef}
                  className={styles.renameInput}
                  value={renameValue}
                  placeholder="会话名称"
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  onBlur={() => setRenaming(false)}
                />
              ) : (
                <div className={styles.itemTitle}>{s.name || s.firstMessage}</div>
              )}
              <div className={styles.itemMeta}>
                {relativeTime(s.modified)} · {s.messageCount} 条
              </div>

              <div className={cx(styles.actions, 'session-actions')}>
                {isActive ? (
                  renaming ? (
                    <>
                      <button
                        className={styles.actionBtn}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          commitRename()
                        }}
                        title="确认"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        className={styles.actionBtn}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setRenaming(false)
                        }}
                        title="取消"
                      >
                        <X size={12} />
                      </button>
                    </>
                  ) : (
                    <button className={styles.actionBtn} onClick={(e) => startRename(s, e)} title="重命名">
                      <Pencil size={12} />
                    </button>
                  )
                ) : (
                  <button className={styles.actionBtn} onClick={(e) => handleDelete(s, e)} title="删除">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import { Tooltip } from 'antd'
import { FolderOpen } from 'lucide-react'
import { api, type Workspace } from '../lib/api'

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

type Props = {
  workspace: Workspace | null
  update: UpdateState
  onInstall: () => void
  onDismissUpdate: () => void
  onSwitchWorkspace: () => void
}

const useStyles = createStyles(({ token, css }) => ({
  bar: css`
    height: 44px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgLayout};
    -webkit-app-region: drag;
    user-select: none;
  `,

  railOffset: css`
    width: 64px;
    flex-shrink: 0;
  `,

  workspaceCtx: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 4px;
    height: 100%;
    cursor: pointer;
    -webkit-app-region: no-drag;
    border-radius: ${token.borderRadiusSM}px;
    transition: background ${token.motionDurationFast};

    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,

  workspaceName: css`
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
  `,

  centerZone: css`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 16px;
    min-width: 0;
  `,

  appLabel: css`
    font-size: 13px;
    font-weight: 400;
    color: ${token.colorTextSecondary};
    letter-spacing: 0.01em;
  `,

  rightZone: css`
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    -webkit-app-region: no-drag;
  `,

  updateBadge: css`
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 6px;
    border-radius: ${token.borderRadiusSM}px;
    font-size: 11px;
    margin-right: 4px;
    cursor: pointer;
    transition: opacity ${token.motionDurationFast};
    -webkit-app-region: no-drag;

    &:hover {
      opacity: 0.82;
    }
  `,

  updateDot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  `,

  dismissBtn: css`
    background: none;
    border: none;
    color: inherit;
    opacity: 0.5;
    cursor: pointer;
    font-size: 13px;
    padding: 0;
    line-height: 1;
    margin-left: 2px;
    -webkit-app-region: no-drag;

    &:hover {
      opacity: 1;
    }
  `,

  winBtn: css`
    width: 28px;
    height: 28px;
    border-radius: ${token.borderRadiusSM}px;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${token.colorTextTertiary};
    transition: background ${token.motionDurationFast}, color ${token.motionDurationFast};
    outline: none;
    -webkit-app-region: no-drag;

    &:hover {
      background: ${token.colorFill};
      color: ${token.colorText};
    }
  `,

  winBtnClose: css`
    &:hover {
      background: rgba(232,17,35,0.9);
      color: #ffffff;
    }
  `,
}))

export default function TitleBar({ workspace, update, onInstall, onDismissUpdate, onSwitchWorkspace }: Props) {
  const { styles, cx, theme: token } = useStyles()
  const [version, setVersion] = useState('')

  useEffect(() => {
    api.app.version().then(setVersion).catch(() => {})
  }, [])

  const isDownloaded = update.status === 'downloaded'
  const isAvailable = update.status === 'available'
  const isError = update.status === 'error'

  return (
    <div className={styles.bar}>
      <div className={styles.railOffset} />

      {workspace && (
        <Tooltip title={workspace.path} placement="bottom">
          <div className={styles.workspaceCtx} onClick={onSwitchWorkspace}>
            <FolderOpen size={14} color={token.colorTextSecondary} />
            <span className={styles.workspaceName}>{workspace.name}</span>
          </div>
        </Tooltip>
      )}

      <div className={styles.centerZone}>
        <span className={styles.appLabel}>
          pi-studio
          {version && (
            <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 11 }}>v{version}</span>
          )}
        </span>
      </div>

      <div className={styles.rightZone}>
        {update.status !== 'idle' && (
          <div
            className={styles.updateBadge}
            style={{
              background: isDownloaded
                ? token.colorSuccessBg
                : isError
                  ? token.colorErrorBg
                  : token.colorFillTertiary,
              border: `1px solid ${isDownloaded ? token.colorSuccessBorder : isError ? token.colorErrorBorder : token.colorBorder}`,
              color: isDownloaded
                ? token.colorSuccess
                : isError
                  ? token.colorError
                  : token.colorTextSecondary,
            }}
            onClick={isDownloaded ? onInstall : undefined}
            title={isError ? (update as { status: 'error'; message: string }).message : undefined}
          >
            <span
              className={styles.updateDot}
              style={{
                background: isDownloaded
                  ? token.colorSuccess
                  : isError
                    ? token.colorError
                    : token.colorTextTertiary,
              }}
            />
            <span>
              {isAvailable
                ? `v${(update as { version: string }).version} 下载中`
                : isDownloaded
                  ? `v${(update as { version: string }).version} 就绪，点击重启`
                  : '更新检查失败'}
            </span>
            <button
              className={styles.dismissBtn}
              onClick={(e) => { e.stopPropagation(); onDismissUpdate() }}
            >
              ×
            </button>
          </div>
        )}

        <Tooltip title="最小化" placement="bottom">
          <button className={styles.winBtn} onClick={() => api.win.minimize()}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </Tooltip>

        <Tooltip title="最大化" placement="bottom">
          <button className={styles.winBtn} onClick={() => api.win.maximize()}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </Tooltip>

        <Tooltip title="关闭" placement="bottom">
          <button
            className={cx(styles.winBtn, styles.winBtnClose)}
            onClick={() => api.win.close()}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

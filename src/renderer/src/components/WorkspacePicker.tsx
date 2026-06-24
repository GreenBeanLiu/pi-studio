import { useState } from 'react'
import { createStyles } from 'antd-style'
import { Modal, Button, Alert, Input } from 'antd'
import { FolderOpen, Folder, X, Check } from 'lucide-react'
import type { Workspace } from '../lib/api'

const useStyles = createStyles(({ token, css }) => ({
  body: css`
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,

  pickBtn: css`
    width: 100%;
    height: 96px;
    border-radius: ${token.borderRadiusLG}px;
    border: 1px dashed ${token.colorBorder};
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    color: ${token.colorTextSecondary};
    transition: all ${token.motionDurationFast};
    outline: none;
    font-family: ${token.fontFamily};

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,

  pickLabel: css`
    font-size: 13px;
    font-weight: 500;
  `,

  sectionLabel: css`
    font-size: 11px;
    font-weight: 600;
    color: ${token.colorTextQuaternary};
    letter-spacing: 0.07em;
    text-transform: uppercase;
  `,

  list: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    overflow-y: auto;
  `,

  item: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background ${token.motionDurationFast};
    outline: none;
    background: transparent;
    width: 100%;
    text-align: left;
    font-family: ${token.fontFamily};

    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,

  itemActive: css`
    border-color: ${token.colorPrimaryBorder} !important;
    background: ${token.colorPrimaryBg} !important;
  `,

  itemInfo: css`
    flex: 1;
    min-width: 0;
  `,

  itemName: css`
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  itemPath: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  removeBtn: css`
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: ${token.colorTextTertiary};
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    outline: none;

    &:hover {
      background: ${token.colorErrorBg};
      color: ${token.colorError};
    }
  `,

  emptyHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    text-align: center;
    padding: 8px 0;
  `,
}))

type Props = {
  recentWorkspaces: Workspace[]
  currentPath: string | null
  opening: boolean
  error: string | null
  onPick: () => void
  onOpen: (path: string) => void
  onRemove: (path: string) => void
  onClose?: () => void
}

export default function WorkspacePicker({
  recentWorkspaces,
  currentPath,
  opening,
  error,
  onPick,
  onOpen,
  onRemove,
  onClose,
}: Props) {
  const { styles, cx } = useStyles()
  const [manualPath, setManualPath] = useState('')

  return (
    <Modal
      open
      onCancel={onClose}
      closable={!!onClose}
      maskClosable={!!onClose}
      title="打开工作区"
      footer={null}
      width={520}
      centered
    >
      <div className={styles.body}>
        {error && <Alert type="error" message={error} showIcon />}

        <button className={styles.pickBtn} onClick={onPick} disabled={opening}>
          <FolderOpen size={22} />
          <span className={styles.pickLabel}>{opening ? '打开中…' : '选择项目目录'}</span>
        </button>

        <Input.Search
          placeholder="或直接输入目录路径"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onSearch={(v) => v.trim() && onOpen(v.trim())}
          enterButton="打开"
          disabled={opening}
        />

        {recentWorkspaces.length > 0 && (
          <div>
            <div className={styles.sectionLabel} style={{ marginBottom: 8 }}>最近打开</div>
            <div className={styles.list}>
              {recentWorkspaces.map((ws) => (
                <button
                  key={ws.path}
                  className={cx(styles.item, currentPath === ws.path && styles.itemActive)}
                  onClick={() => onOpen(ws.path)}
                >
                  <Folder size={16} color="var(--ant-color-text-tertiary)" />
                  <div className={styles.itemInfo}>
                    <div className={styles.itemName}>{ws.name}</div>
                    <div className={styles.itemPath}>{ws.path}</div>
                  </div>
                  {currentPath === ws.path && <Check size={14} color="var(--ant-color-primary)" />}
                  <span
                    className={styles.removeBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(ws.path)
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {recentWorkspaces.length === 0 && (
          <p className={styles.emptyHint}>还没有打开过工作区，选择一个项目目录开始。</p>
        )}
      </div>

      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
          <Button onClick={onClose}>取消</Button>
        </div>
      )}
    </Modal>
  )
}

import { createStyles } from 'antd-style'
import { ActionIcon } from '@lobehub/ui'
import { Tooltip } from 'antd'
import { FileCheck2, FolderOpen, Settings, Sun, Moon } from 'lucide-react'
import type { Workspace } from '../lib/api'

const useStyles = createStyles(({ token, css }) => ({
  rail: css`
    width: 64px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: ${token.colorBgLayout};
    border-right: 1px solid ${token.colorBorderSecondary};
    padding: 6px 0 8px;
    gap: 0;
  `,

  iconBtn: css`
    flex-shrink: 0;
    margin-bottom: 4px;
    color: ${token.colorTextSecondary};
  `,

  spacer: css`
    flex: 1;
  `,

  wsBtnWrap: css`
    position: relative;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,

  wsGlow: css`
    position: absolute;
    inset: -6px;
    border-radius: 14px;
    pointer-events: none;
    background: radial-gradient(circle, ${token.colorPrimary}30 0%, transparent 72%);
  `,

  wsBtn: css`
    position: relative;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform ${token.motionDurationFast} ${token.motionEaseOut};
    flex-shrink: 0;
    outline: none;
    border: 1px solid ${token.colorPrimaryBorder};
    background: ${token.colorPrimaryBg};
    box-shadow: 0 0 0 4px ${token.colorPrimary}0a;
    color: ${token.colorPrimary};
    font-size: 16px;
    font-weight: 600;

    &:hover {
      transform: scale(1.05);
    }
  `,
}))

type Props = {
  workspace: Workspace | null
  appearance: 'dark' | 'light'
  onSwitchWorkspace: () => void
  onFeishuApproval: () => void
  onSettings: () => void
  onToggleTheme: () => void
}

export default function NavRail({
  workspace,
  appearance,
  onSwitchWorkspace,
  onFeishuApproval,
  onSettings,
  onToggleTheme,
}: Props) {
  const { styles } = useStyles()

  const initial = workspace?.name.slice(0, 1).toUpperCase() ?? ''

  return (
    <nav className={styles.rail}>
      <Tooltip title={workspace ? `切换工作区 · ${workspace.name}` : '打开工作区'} placement="right">
        <div className={styles.wsBtnWrap}>
          <div className={styles.wsGlow} />
          <button className={styles.wsBtn} onClick={onSwitchWorkspace}>
            {workspace ? initial : <FolderOpen size={18} />}
          </button>
        </div>
      </Tooltip>

      <ActionIcon
        className={styles.iconBtn}
        icon={<FileCheck2 size={15} />}
        title="飞书审批 Demo"
        onClick={onFeishuApproval}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <div className={styles.spacer} />

      <ActionIcon
        className={styles.iconBtn}
        icon={appearance === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        title={appearance === 'dark' ? '切换亮色' : '切换暗色'}
        onClick={onToggleTheme}
        size={{ blockSize: 36, borderRadius: 8 }}
      />

      <ActionIcon
        className={styles.iconBtn}
        icon={<Settings size={15} />}
        title="设置"
        onClick={onSettings}
        size={{ blockSize: 36, borderRadius: 8 }}
      />
    </nav>
  )
}

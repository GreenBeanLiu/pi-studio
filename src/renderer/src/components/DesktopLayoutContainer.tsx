import { createStyles } from 'antd-style'
import type { ReactNode } from 'react'

const useStyles = createStyles(({ token, css }) => ({
  /**
   * Outer shell: the window chrome layer.
   * Background is the window bg (#0d0c15), same as nav rail/panel.
   */
  outer: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: ${token.colorBgLayout};
  `,

  /**
   * Inner content card: visually lifted one layer above the chrome.
   * This creates the "container within container" feel — the content
   * area reads as a distinct workspace, not just an edge-to-edge page.
   */
  inner: css`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: ${token.colorBgBase};
    border-left: none;
    overflow: hidden;
  `,
}))

type Props = {
  children: ReactNode
}

export default function DesktopLayoutContainer({ children }: Props) {
  const { styles } = useStyles()

  return (
    <div className={styles.outer}>
      <div className={styles.inner}>{children}</div>
    </div>
  )
}

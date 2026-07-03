import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import TitleBar from './components/TitleBar'
import NavRail from './components/NavRail'
import ChatPane from './components/ChatPane'
import SessionSidebar from './components/SessionSidebar'
import DesktopLayoutContainer from './components/DesktopLayoutContainer'
import SettingsModal from './components/SettingsModal'
import WorkspacePicker from './components/WorkspacePicker'
import { api, type Workspace } from './lib/api'

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

const useStyles = createStyles(({ token, css }) => ({
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${token.colorBgLayout};
    font-family: ${token.fontFamily};
  `,

  contentRow: css`
    display: flex;
    flex: 1;
    min-height: 0;
  `,
}))

type AppProps = {
  appearance: 'dark' | 'light'
  onToggleTheme: () => void
}

export default function App({ appearance, onToggleTheme }: AppProps) {
  const { styles } = useStyles()

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<Workspace[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(true)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  // Bumped when the active session changes; remounts ChatPane so it reloads messages.
  const [sessionEpoch, setSessionEpoch] = useState(0)

  useEffect(() => {
    api.workspace.list().then(setRecentWorkspaces)

    const offAvail = api.update.onAvailable(({ version }) =>
      setUpdate({ status: 'available', version }),
    )
    const offDone = api.update.onDownloaded(({ version }) =>
      setUpdate({ status: 'downloaded', version }),
    )
    const offErr = api.update.onError(({ message }) =>
      setUpdate({ status: 'error', message }),
    )

    return () => {
      offAvail()
      offDone()
      offErr()
    }
  }, [])

  async function openWorkspace(path: string) {
    setOpening(true)
    setWorkspaceError(null)
    const result = await api.workspace.open(path)
    setOpening(false)
    if ('error' in result) {
      setWorkspaceError(result.error)
      return
    }
    setRecentWorkspaces(result.recentWorkspaces)
    setWorkspace(result.recentWorkspaces.find((w) => w.path === path) ?? { path, name: path, lastOpenedAt: new Date().toISOString() })
    setShowWorkspacePicker(false)
  }

  async function removeWorkspace(path: string) {
    const next = await api.workspace.remove(path)
    setRecentWorkspaces(next)
  }

  return (
    <div className={styles.shell}>
      <TitleBar
        workspace={workspace}
        update={update}
        onInstall={() => api.update.install()}
        onDismissUpdate={() => setUpdate({ status: 'idle' })}
        onSwitchWorkspace={() => setShowWorkspacePicker(true)}
      />

      <div className={styles.contentRow}>
        <NavRail
          workspace={workspace}
          appearance={appearance}
          onSwitchWorkspace={() => setShowWorkspacePicker(true)}
          onSettings={() => setShowSettings(true)}
          onToggleTheme={onToggleTheme}
        />
        {workspace && (
          <SessionSidebar
            workspace={workspace}
            onSessionChanged={() => setSessionEpoch((n) => n + 1)}
          />
        )}
        <DesktopLayoutContainer>
          <ChatPane key={`${workspace?.path ?? ''}#${sessionEpoch}`} workspace={workspace} />
        </DesktopLayoutContainer>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showWorkspacePicker && (
        <WorkspacePicker
          recentWorkspaces={recentWorkspaces}
          currentPath={workspace?.path ?? null}
          opening={opening}
          error={workspaceError}
          onPick={async () => {
            const path = await api.workspace.pickDirectory()
            if (path) openWorkspace(path)
          }}
          onOpen={openWorkspace}
          onRemove={removeWorkspace}
          onClose={() => setShowWorkspacePicker(false)}
        />
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import TitleBar from './components/TitleBar'
import NavRail from './components/NavRail'
import ChatPane from './components/ChatPane'
import RoutinesPage from './components/RoutinesPage'
import ImageGenPage from './components/ImageGenPage'
import Model3DPage from './components/Model3DPage'
import SessionSidebar from './components/SessionSidebar'
import DesktopLayoutContainer from './components/DesktopLayoutContainer'
import SettingsModal from './components/SettingsModal'
import WorkspacePicker from './components/WorkspacePicker'
import { api, type AgentStatusEvent, type Workspace } from './lib/api'

type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

type AgentIssue = Exclude<AgentStatusEvent, { status: 'started' }>
type ActiveView = 'chat' | 'routines' | 'imagegen' | 'model3d'

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
  const [restartingAgent, setRestartingAgent] = useState(false)
  const [agentIssue, setAgentIssue] = useState<AgentIssue | null>(null)
  const [diagnosticsExporter, setDiagnosticsExporter] = useState<(() => void) | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('chat')
  // 当前工作区 agent 的沙箱运行模式(null=直跑主机);来自 agent:status started 事件
  const [sandboxMode, setSandboxMode] = useState<'wsl' | 'docker' | null>(null)
  // Bumped when the active session changes; remounts ChatPane so it reloads messages.
  const [sessionEpoch, setSessionEpoch] = useState(0)

  useEffect(() => {
    Promise.all([api.workspace.list(), api.settings.load()])
      .then(([workspaces, settings]) => {
        setRecentWorkspaces(workspaces)
        if (!settings.apiKey) {
          setShowWorkspacePicker(false)
          setWorkspaceError('请先配置模型服务 API Key，然后再打开工作区。')
          setShowSettings(true)
        }
      })
      .catch(() => {})

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

  useEffect(() => {
    const off = api.pi.onStatus((event) => {
      if (!workspace || event.cwd !== workspace.path) return
      if (event.status === 'started') {
        setAgentIssue(null)
        setRestartingAgent(false)
        setSandboxMode(event.sandbox ?? null)
        return
      }
      if (event.status === 'exited' && event.expected) return
      setAgentIssue(event)
      setRestartingAgent(false)
      api.win.flash()
    })
    return off
  }, [workspace?.path])

  // Optimistic open: close the picker immediately and show a "starting"
  // chat pane — the agent subprocess takes 1–3s to boot, and blocking the
  // modal on it reads as a UI freeze.
  async function openWorkspace(path: string) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    setWorkspaceError(null)
    setAgentIssue(null)
    setShowWorkspacePicker(false)
    setOpening(true)
    setWorkspace({ path, name, lastOpenedAt: new Date().toISOString() })
    const result = await api.workspace.open(path)
    setOpening(false)
    if ('error' in result) {
      // startWorkspace stops the old subprocess before failing, so no
      // workspace is actually open now — reflect that honestly.
      setWorkspace(null)
      setSandboxMode(null)
      setWorkspaceError(result.error)
      if (result.error.includes('API Key')) {
        setShowWorkspacePicker(false)
        setShowSettings(true)
      } else {
        setShowWorkspacePicker(true)
      }
      return
    }
    setRecentWorkspaces(result.recentWorkspaces)
    setSessionEpoch((n) => n + 1)
  }

  async function restartAgent() {
    if (!workspace || opening || restartingAgent) return
    setRestartingAgent(true)
    const result = await api.workspace.open(workspace.path)
    setRestartingAgent(false)
    if ('error' in result) {
      setAgentIssue({ status: 'error', cwd: workspace.path, message: result.error })
      return
    }
    setAgentIssue(null)
    setRecentWorkspaces(result.recentWorkspaces)
    setSessionEpoch((n) => n + 1)
  }

  async function removeWorkspace(path: string) {
    const next = await api.workspace.remove(path)
    setRecentWorkspaces(next)
  }

  function closeSettings() {
    setShowSettings(false)
    if (!workspace && !opening) setShowWorkspacePicker(true)
  }

  return (
    <div className={styles.shell}>
      <TitleBar
        workspace={workspace}
        sandboxMode={sandboxMode}
        update={update}
        onInstall={() => api.update.install()}
        onDismissUpdate={() => setUpdate({ status: 'idle' })}
        onSwitchWorkspace={() => setShowWorkspacePicker(true)}
      />

      <div className={styles.contentRow}>
        <NavRail
          workspace={workspace}
          activeView={activeView}
          appearance={appearance}
          onSwitchWorkspace={() => setShowWorkspacePicker(true)}
          onChat={() => setActiveView('chat')}
          onRoutines={() => setActiveView('routines')}
          onImageGen={() => setActiveView('imagegen')}
          onModel3D={() => setActiveView('model3d')}
          onSettings={() => setShowSettings(true)}
          onToggleTheme={onToggleTheme}
        />
        {activeView === 'chat' && workspace && !opening && (
          <SessionSidebar
            workspace={workspace}
            onSessionChanged={() => setSessionEpoch((n) => n + 1)}
          />
        )}
        <DesktopLayoutContainer>
          {/* ChatPane 常驻不卸载(display 切换):agent 长任务运行中切去别的视图再回来,
              运行状态/停止按钮/排队上下文都不能丢 */}
          <div
            style={{
              display: activeView === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <ChatPane
              key={`${workspace?.path ?? ''}#${sessionEpoch}`}
              workspace={workspace}
              starting={opening || restartingAgent}
              agentIssue={agentIssue}
              restarting={restartingAgent}
              onRestartAgent={restartAgent}
              onDiagnosticsExporterChange={(exporter) => setDiagnosticsExporter(() => exporter)}
            />
          </div>
          {activeView === 'routines' && <RoutinesPage workspace={workspace} />}
          {activeView === 'imagegen' && <ImageGenPage />}
          {activeView === 'model3d' && <Model3DPage />}
        </DesktopLayoutContainer>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={closeSettings}
          onExportDiagnostics={diagnosticsExporter ?? undefined}
          diagnosticsDisabled={!workspace}
          onSandboxToggled={() => void restartAgent()}
        />
      )}
      {showWorkspacePicker && !showSettings && (
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

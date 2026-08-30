import { useCallback, useMemo, useState } from 'react'
import type { DesktopApi, GitChangedFile, GitDiffSnapshot, Workspace } from '../../../shared/ipc/contract'

/**
 * 这个 hook 刻意不 import antd 和 lib/api —— 环境全靠注入。
 * 这样它在 Node/happy-dom 下能被 renderHook 直接测,不用把整个 antd 拉进测试进程。
 */
export type GitDiffDeps = {
  git: DesktopApi['git']
  notifyError: (message: string) => void
  notifySuccess: (message: string) => void
  /** 撤销是不可逆的,要先弹确认;确认后调 onOk。 */
  confirmDiscard: (onOk: () => Promise<void>) => void
}

export type GitDiffState = {
  open: boolean
  loading: boolean
  snapshot: GitDiffSnapshot | null
  hasChanges: boolean
  changedFiles: GitChangedFile[]
  stagedCount: number
  unstagedCount: number
  openDiff: () => Promise<void>
  close: () => void
  /** agent 跑完检测到变更时,直接把快照亮出来。 */
  showSnapshot: (snapshot: GitDiffSnapshot) => void
  accept: () => Promise<void>
  discard: () => void
  openChangedFile: (file: GitChangedFile) => Promise<void>
}

function messageOf(err: unknown, fallback: string): string {
  return (err as Error)?.message ?? fallback
}

export function useGitDiff(workspace: Workspace | null, deps: GitDiffDeps): GitDiffState {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [snapshot, setSnapshot] = useState<GitDiffSnapshot | null>(null)

  const { git, notifyError, notifySuccess, confirmDiscard } = deps

  const openDiff = useCallback(async () => {
    if (!workspace) return
    setOpen(true)
    setLoading(true)
    try {
      const result = await git.diff()
      if ('error' in result) {
        notifyError(result.error)
        setSnapshot(null)
      } else {
        setSnapshot(result.snapshot)
      }
    } catch (err) {
      notifyError(messageOf(err, '读取 Git 变更失败'))
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [workspace, git, notifyError])

  const accept = useCallback(async () => {
    try {
      const result = await git.acceptChanges()
      // 失败时**不关**弹窗:用户还得看着变更决定下一步。
      if ('error' in result) {
        notifyError(result.error)
        return
      }
      setOpen(false)
      setSnapshot(null)
      notifySuccess('已接受本次 Agent 运行变更')
    } catch (err) {
      notifyError(messageOf(err, '接受 Agent 运行变更失败'))
    }
  }, [git, notifyError, notifySuccess])

  const discard = useCallback(() => {
    confirmDiscard(async () => {
      setLoading(true)
      try {
        const result = await git.discardChanges()
        if ('error' in result) {
          notifyError(result.error)
          return
        }
        // 回滚后留在弹窗里显示回滚后的快照,而不是关掉 —— 让用户确认真的回滚干净了。
        setSnapshot(result.snapshot)
        notifySuccess('工作区变更已回滚')
      } catch (err) {
        notifyError(messageOf(err, '回滚工作区变更失败'))
      } finally {
        setLoading(false)
      }
    })
  }, [confirmDiscard, git, notifyError, notifySuccess])

  const openChangedFile = useCallback(
    async (file: GitChangedFile) => {
      try {
        const result = await git.showFile(file.path)
        if ('error' in result) notifyError(result.error)
      } catch (err) {
        notifyError(messageOf(err, '打开文件失败'))
      }
    },
    [git, notifyError],
  )

  const showSnapshot = useCallback((next: GitDiffSnapshot) => {
    setSnapshot(next)
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const derived = useMemo(() => {
    const changedFiles = snapshot?.files ?? []
    return {
      hasChanges: !!snapshot?.status.trim(),
      changedFiles,
      stagedCount: changedFiles.filter((file) => file.staged).length,
      unstagedCount: changedFiles.filter((file) => file.unstaged).length,
    }
  }, [snapshot])

  return {
    open,
    loading,
    snapshot,
    ...derived,
    openDiff,
    close,
    showSnapshot,
    accept,
    discard,
    openChangedFile,
  }
}

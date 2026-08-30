// @vitest-environment happy-dom
//
// 套件里绝大多数测试跑在 Node 下(有真起子进程的),所以 DOM 环境按文件开,
// 不全局切。渲染层的测试统一用这行 docblock。
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GitChangedFile, GitDiffSnapshot, Workspace } from '../../../shared/ipc/contract'
import { useGitDiff, type GitDiffDeps } from './use-git-diff'

const workspace: Workspace = { path: '/w', name: 'demo', lastOpenedAt: '2026-08-30T00:00:00Z' }

function snapshot(over: Partial<GitDiffSnapshot> = {}): GitDiffSnapshot {
  return {
    status: ' M a.ts',
    files: [{ path: 'a.ts', statusCode: ' M', staged: false, unstaged: true } as GitChangedFile],
    unstagedStat: '',
    unstagedDiff: '',
    stagedStat: '',
    stagedDiff: '',
    truncated: false,
    ...over,
  }
}

function deps(over: Partial<GitDiffDeps> = {}): GitDiffDeps {
  return {
    git: {
      diff: vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot() }),
      acceptChanges: vi.fn().mockResolvedValue({ ok: true }),
      discardChanges: vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot({ status: '' }) }),
      showFile: vi.fn().mockResolvedValue({ ok: true }),
    },
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
    // 默认「用户点了确认」
    confirmDiscard: (onOk) => void onOk(),
    ...over,
  }
}

describe('openDiff', () => {
  it('没有工作区时什么都不做', async () => {
    const d = deps()
    const { result } = renderHook(() => useGitDiff(null, d))
    await act(() => result.current.openDiff())
    expect(d.git.diff).not.toHaveBeenCalled()
    expect(result.current.open).toBe(false)
  })

  it('先开弹窗再取数 —— 用户点了要立刻看到反应', async () => {
    let resolveDiff: (v: unknown) => void = () => {}
    const d = deps({
      git: { ...deps().git, diff: vi.fn(() => new Promise((r) => (resolveDiff = r))) } as GitDiffDeps['git'],
    })
    const { result } = renderHook(() => useGitDiff(workspace, d))
    act(() => void result.current.openDiff())
    // 还没拿到数据,弹窗已经开着并且在转圈
    expect(result.current.open).toBe(true)
    expect(result.current.loading).toBe(true)
    await act(async () => {
      resolveDiff({ ok: true, snapshot: snapshot() })
    })
    expect(result.current.loading).toBe(false)
  })

  it('拿到快照后算出派生数据', async () => {
    const { result } = renderHook(() => useGitDiff(workspace, deps()))
    await act(() => result.current.openDiff())
    expect(result.current.hasChanges).toBe(true)
    expect(result.current.changedFiles).toHaveLength(1)
    expect(result.current.unstagedCount).toBe(1)
    expect(result.current.stagedCount).toBe(0)
  })

  it('后端报错时清掉旧快照,不留着过期内容', async () => {
    const d = deps()
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    expect(result.current.snapshot).not.toBeNull()

    vi.mocked(d.git.diff).mockResolvedValue({ error: '不是 git 仓库' })
    await act(() => result.current.openDiff())
    expect(result.current.snapshot).toBeNull()
    expect(d.notifyError).toHaveBeenCalledWith('不是 git 仓库')
  })

  it('抛异常时也要把 loading 关掉,否则弹窗永远转圈', async () => {
    const d = deps()
    vi.mocked(d.git.diff).mockRejectedValue(new Error('IPC 断了'))
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    expect(result.current.loading).toBe(false)
    expect(d.notifyError).toHaveBeenCalledWith('IPC 断了')
  })
})

describe('accept', () => {
  it('成功后关弹窗并清快照', async () => {
    const d = deps()
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    await act(() => result.current.accept())
    expect(result.current.open).toBe(false)
    expect(result.current.snapshot).toBeNull()
    expect(d.notifySuccess).toHaveBeenCalled()
  })

  it('失败时**不关**弹窗 —— 用户还得看着变更决定下一步', async () => {
    const d = deps()
    vi.mocked(d.git.acceptChanges).mockResolvedValue({ error: '有冲突' })
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    await act(() => result.current.accept())
    expect(result.current.open).toBe(true)
    expect(result.current.snapshot).not.toBeNull()
    expect(d.notifyError).toHaveBeenCalledWith('有冲突')
  })
})

describe('discard', () => {
  it('用户取消确认时什么都不做', async () => {
    const d = deps({ confirmDiscard: vi.fn() })
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    act(() => result.current.discard())
    expect(d.git.discardChanges).not.toHaveBeenCalled()
  })

  it('确认后回滚,并留在弹窗里显示回滚后的快照', async () => {
    const d = deps()
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    await act(async () => result.current.discard())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.open).toBe(true)
    expect(result.current.hasChanges).toBe(false)
    expect(d.notifySuccess).toHaveBeenCalledWith('工作区变更已回滚')
  })

  it('回滚失败时不覆盖当前快照', async () => {
    const d = deps()
    vi.mocked(d.git.discardChanges).mockResolvedValue({ error: '工作区被占用' })
    const { result } = renderHook(() => useGitDiff(workspace, d))
    await act(() => result.current.openDiff())
    await act(async () => result.current.discard())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasChanges).toBe(true)
    expect(d.notifyError).toHaveBeenCalledWith('工作区被占用')
  })
})

describe('showSnapshot', () => {
  it('agent 跑完检测到变更时直接把快照亮出来', () => {
    const { result } = renderHook(() => useGitDiff(workspace, deps()))
    act(() => result.current.showSnapshot(snapshot()))
    expect(result.current.open).toBe(true)
    expect(result.current.hasChanges).toBe(true)
  })

  it('close 只收弹窗,不丢快照', () => {
    const { result } = renderHook(() => useGitDiff(workspace, deps()))
    act(() => result.current.showSnapshot(snapshot()))
    act(() => result.current.close())
    expect(result.current.open).toBe(false)
    expect(result.current.snapshot).not.toBeNull()
  })
})

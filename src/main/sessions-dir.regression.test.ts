import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ipc = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
const piClient = readFileSync(new URL('./pi-client.ts', import.meta.url), 'utf8')
const sidebar = readFileSync(
  new URL('../renderer/src/components/SessionSidebar.tsx', import.meta.url),
  'utf8',
)

// 2026-08-25:接入 ACP 之后,当前会话可能由外部 agent 驱动 —— 那种会话没有
// sessionFile(会话存在 agent 那边,宿主读不到 jsonl)。
//
// 会话目录原来是每次从「当前会话的 sessionFile」现推的:
//   const state = await piClientManager.getState()
//   if (!state.sessionFile) return []
//   return listSessions(dirname(state.sessionFile), cwd)
//
// 于是只要切到一个 ACP 会话,整个会话列表就空了 —— 不是少一条,是全没,
// 而且切换和删除也一起失效。目录是工作区级的,应该从 pi 那儿学到一次就记住。
describe('the session directory must not depend on the active session', () => {
  it('caches the directory on the workspace instead of re-deriving it', () => {
    expect(piClient).toContain('getSessionDir()')
    expect(piClient).toContain('private rememberSessionDir(')
    // 工作区关掉要清掉,否则换工作区会列到上一个的会话
    const stop = piClient.slice(piClient.indexOf('async stop('), piClient.indexOf('getWorkspacePath('))
    expect(stop).toContain('this.sessionDir = null')
  })

  it('never derives the directory from the active session file again', () => {
    expect(ipc).not.toContain('dirname(state.sessionFile)')
  })

  it('lists, switches and deletes through the cached directory', () => {
    for (const handler of ['sessions:list', 'sessions:switch', 'sessions:delete']) {
      const start = ipc.indexOf(`ipcMain.handle('${handler}'`)
      expect(start).toBeGreaterThan(-1)
      expect(ipc.slice(start, start + 700)).toContain('piClientManager.getSessionDir()')
    }
  })

  // 「不能删除当前会话」这条保护原来比对的是 state.sessionFile。ACP 会话下它是
  // undefined,保护会静默失效 —— 改成取前台会话的身份。
  it('guards the active session by its identity, not by getState', () => {
    const start = ipc.indexOf("ipcMain.handle('sessions:delete'")
    const body = ipc.slice(start, start + 1400)
    expect(body).toContain('piClientManager.getActiveSessionIdentity()?.sessionFile')
    expect(body).toContain('不能删除当前会话')
  })
})

// 外部 agent 的会话键不是文件路径,parseSessionPath 会把它当成越界路径打回。
// 分流必须在路径校验之前。
describe('ACP session keys route before the path validator', () => {
  it('checks for an acp key first in switch and delete', () => {
    for (const handler of ['sessions:switch', 'sessions:delete']) {
      const start = ipc.indexOf(`ipcMain.handle('${handler}'`)
      const body = ipc.slice(start, start + 900)
      const acpAt = body.indexOf('isAcpSessionKey(sessionPath)')
      const parseAt = body.indexOf('parseSessionPath(')
      expect(acpAt).toBeGreaterThan(-1)
      // delete 那条里 parseSessionPath 在后面;switch 同理
      if (parseAt > -1) expect(acpAt).toBeLessThan(parseAt)
    }
  })

  it('merges live ACP sessions into the list', () => {
    const start = ipc.indexOf("ipcMain.handle('sessions:list'")
    const body = ipc.slice(start, start + 700)
    expect(body).toContain('piClientManager.listAcpSessions()')
    // 没有 pi 会话目录时也要把 ACP 那批列出来,不能直接 return []
    expect(body).toContain('if (!sessionDir) return acp')
  })

  // 外部 agent 的会话没有 jsonl 可改名。留着按钮会抛到没人接的地方 ——
  // 侧栏的 commitRename 是裸 await,一抛 refresh() 就不执行了。
  it('hides rename for ACP rows in the sidebar', () => {
    expect(sidebar).toContain('const isAcp = isAcpSessionKey(s.path)')
    const rename = sidebar.slice(sidebar.indexOf('title="重命名"') - 300, sidebar.indexOf('title="重命名"'))
    expect(rename).toContain('!isAcp &&')
  })
})

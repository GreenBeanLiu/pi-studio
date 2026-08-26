import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function windowsTaskkill(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    })
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    const detail = failure.stderr?.trim() || failure.message
    throw new Error(`Could not terminate process tree ${pid}: ${detail}`, { cause: error })
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function unixDescendants(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], {
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const children = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parent = Number(parentText)
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue
    const siblings = children.get(parent) ?? []
    siblings.push(pid)
    children.set(parent, siblings)
  }
  const result: number[] = []
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      visit(child)
      result.push(child)
    }
  }
  visit(rootPid)
  return result
}

async function unixProcessesStillRunning(pids: readonly number[], processGroup?: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,pgid=,stat='], {
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const targets = new Set(pids)
    return stdout.split('\n').some((line) => {
      const [pidText, groupText, state = ''] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const group = Number(groupText)
      return !state.startsWith('Z') && (targets.has(pid) || (processGroup !== undefined && group === processGroup))
    })
  } catch {
    return true
  }
}

async function confirmUnixTermination(pids: readonly number[], processGroup?: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (await unixProcessesStillRunning(pids, processGroup)) {
    if (Date.now() >= deadline) throw new Error(`Process tree ${processGroup ?? pids[0]} did not terminate`)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

/** Terminates an owned process and every descendant before ownership is released. */
export async function terminateProcessTree(
  pid: number,
  options: { detachedGroup?: boolean } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid owned process id: ${pid}`)
  if (process.platform === 'win32') {
    await windowsTaskkill(pid)
    return
  }
  if (options.detachedGroup) {
    // 杀的是进程组,不是「整棵树」—— POSIX 上有两条消不掉的限制,调用方要知道:
    //
    // 1. 子孙自己调过 setsid()(Node 里就是 spawn 的 detached: true)就成了新的
    //    会话和组长,这个信号到不了它。
    // 2. 就算它留在组里,只要主进程已经退出,组就可能已经解散。2026-08-26 在
    //    macOS 26.5 上实测:child 的 exit 事件 +391ms 时 kill(-pgid) 已经 ESRCH,
    //    而残留的子孙还活着 —— 能动手的最早时机已经晚了。
    //
    // 所以这条路的实际保证是「主进程还活着时能把它那一组收干净」(超时、
    // 用户中止都属于这种),而不是「正常退出后还能追杀脱离的子孙」。
    // 后者要操作系统级的容器:Windows 走 Job Object(KILL_ON_JOB_CLOSE),
    // Linux 的对等物是 cgroup —— 普通用户进程用不了。
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await confirmUnixTermination([], pid)
    return
  }
  const descendants = await unixDescendants(pid)
  for (const child of descendants) killPid(child)
  killPid(pid)
  await confirmUnixTermination([pid, ...descendants])
}

import { app } from 'electron'
import { existsSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendAppLog } from './app-log'
import { agentConfigDir } from './settings'

/**
 * macOS 原生沙箱(Seatbelt / sandbox-exec)。
 *
 * mac 上没有 WSL,而 Docker 那条 2026-07-15 已封存(容器出网不通,见
 * docs/sandbox-mode-plan.md),且 Docker Desktop 对桌面应用来说太重。
 * sandbox-exec 是系统自带的内核级沙箱,无 daemon、无虚机、无镜像,
 * 进程级启动,和 Linux 的 bwrap 对位。
 *
 * 当前只做**文件隔离**:整盘可读、仅工作区 / agent 目录 / 临时目录可写。
 * 网络不收敛 —— 白名单代理(sandbox-proxy.ts)留着,将来要收紧时把
 * `(deny network*)` + 只放行 localhost:<代理端口> 加回来即可(已实测可行)。
 */

const SEATBELT_BIN = '/usr/bin/sandbox-exec'

/** 沙箱按解析后的真实路径匹配:mac 上 /tmp → /private/tmp、/var → /private/var。 */
function resolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** SBPL 是 S-表达式,路径要按字符串字面量转义。 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function detectSeatbelt(): boolean {
  return process.platform === 'darwin' && existsSync(SEATBELT_BIN)
}

/**
 * 写限制式 profile:`(allow default)` 打底再收窄 file-write*。
 *
 * 不用 `(deny default)` 全量白名单:那要把 mach 服务、sysctl、IPC 一条条列全,
 * 漏一条就是难查的运行时故障,而我们要的只是"别写工作区外面"。
 * SBPL 后写的规则覆盖先写的,所以顺序是 allow default → deny 写 → 放行几处可写。
 */
export function buildSeatbeltProfile(opts: {
  workspace: string
  agentDir: string
  tmpDir: string
}): string {
  const writable = [opts.workspace, opts.agentDir, opts.tmpDir].map(resolved)
  return [
    '(version 1)',
    '',
    ';; pi-studio macOS 沙箱:只收窄写权限,读与网络保持放行',
    '(allow default)',
    '',
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map((path) => `  (subpath ${sbplString(path)})`),
    // stdio 和终端设备:RPC 就是靠这对管道说话,拦了直接起不来
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/random")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty")',
    '  (regex #"^/dev/fd/")',
    ')',
    '',
  ].join('\n')
}

/** shim:RpcClient 以为在跑 node,实际把 stdio 原样透传进 sandbox-exec。 */
function seatbeltShimSource(): string {
  return `// pi-studio macOS 沙箱中继:字节管道透传进 sandbox-exec,不解析 JSON。
const { spawn } = require('child_process')
const pre = JSON.parse(process.env.PISTUDIO_SEATBELT_ARGS || '[]')
const cli = process.env.PISTUDIO_SEATBELT_CLI
if (!cli) {
  console.error('pi-studio sandbox: PISTUDIO_SEATBELT_CLI missing')
  process.exit(1)
}
// process.execPath 是内嵌 node(ELECTRON_RUN_AS_NODE 已在 env 里),沙箱内继续用它
const child = spawn(
  '${SEATBELT_BIN}',
  [...pre, process.execPath, cli, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
)
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
child.on('close', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('pi-studio sandbox: failed to spawn sandbox-exec:', err.message)
  process.exit(1)
})
`
}

export async function prepareSeatbeltSandboxLaunch(
  cwd: string,
  env: Record<string, string>,
  realCliPath: string,
): Promise<{ cliPath: string; env: Record<string, string> }> {
  if (!detectSeatbelt()) {
    throw new Error(`macOS 沙箱不可用:找不到 ${SEATBELT_BIN}`)
  }
  const agentDir = agentConfigDir()
  const profile = buildSeatbeltProfile({ workspace: cwd, agentDir, tmpDir: tmpdir() })
  const profilePath = join(app.getPath('userData'), 'sandbox-seatbelt.sb')
  writeFileSync(profilePath, profile, 'utf-8')

  const shimPath = join(app.getPath('userData'), 'sandbox-seatbelt-shim.cjs')
  writeFileSync(shimPath, seatbeltShimSource(), 'utf-8')

  appendAppLog('info', 'sandbox.seatbelt', 'Launching pi inside the macOS Seatbelt sandbox', {
    cwd,
    profilePath,
  })
  // 路径不变(同一个文件系统),所以 sandboxAgentPath 对 seatbelt 是恒等的
  return {
    cliPath: shimPath,
    env: {
      ...env,
      PISTUDIO_SEATBELT_ARGS: JSON.stringify(['-f', profilePath]),
      PISTUDIO_SEATBELT_CLI: realCliPath,
    },
  }
}

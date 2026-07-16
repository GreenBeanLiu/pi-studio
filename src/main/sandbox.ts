import { ipcMain, app, BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname, relative, resolve, sep } from 'path'
import { resolvePiCliPath } from './pi-client'
import { agentConfigDir } from './settings'
import { appendAppLog, normalizeError } from './app-log'
import { detectWslSandboxDistro, prepareWslSandboxLaunch } from './sandbox-wsl'

/**
 * 沙箱模式:在 Docker 容器里隔离运行 pi(见 docs/sandbox-mode-plan.md)。
 *
 * 关键手法「中继 shim」:pi 的 RpcClient.start() 写死 spawn("node", [cliPath])——
 * 沙箱模式下把 cliPath 指向 sandbox-rpc-shim.cjs,那个 node 进程再把 stdio 透明
 * 转发进 `docker run … IMAGE pi <RpcClient 追加的参数>`。RPC 是纯 JSONL over stdio,
 * shim 只当字节管道,RpcClient 的所有方法零改动即可隔着容器工作。
 */

export type SandboxDetect = {
  docker: { cliFound: boolean; daemonRunning: boolean; version: string }
  /** 首选执行路径:pi-studio-sandbox WSL 发行版是否就绪(存在即自动启用) */
  wslSandboxReady: boolean
  wsl: { available: boolean; distros: string[] }
}

export type SandboxImageStatus = {
  tag: string
  exists: boolean
  daemonRunning: boolean
}

const SANDBOX_AGENT_DIR = '/agent'

/** Convert the Linux path returned by pi in Docker into the host path used by the UI. */
export function sandboxSessionPathToHost(sessionPath: string, hostAgentDir = agentConfigDir()): string {
  if (sessionPath !== SANDBOX_AGENT_DIR && !sessionPath.startsWith(`${SANDBOX_AGENT_DIR}/`)) {
    return sessionPath
  }
  const relativePath = sessionPath.slice(`${SANDBOX_AGENT_DIR}/`.length)
  return join(hostAgentDir, ...relativePath.split('/'))
}

/** Convert a host session path selected by the UI into the path visible in Docker. */
export function sandboxSessionPathToContainer(
  sessionPath: string,
  hostAgentDir = agentConfigDir(),
): string {
  const hostRoot = resolve(hostAgentDir)
  const target = resolve(sessionPath)
  const rootKey = hostRoot.toLowerCase()
  const targetKey = target.toLowerCase()
  if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${sep}`)) return sessionPath
  const relativePath = relative(hostRoot, target).split(sep).join('/')
  return relativePath ? `${SANDBOX_AGENT_DIR}/${relativePath}` : SANDBOX_AGENT_DIR
}

/** 跑一个命令,拿 stdout(不抛异常);超时/不存在都算失败。 */
function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; encoding?: BufferEncoding } = {},
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 6000, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        const text = Buffer.isBuffer(stdout)
          ? stdout.toString(opts.encoding ?? 'utf8')
          : String(stdout ?? '')
        resolve({ ok: !err, stdout: text })
      },
    )
  })
}

async function detectDocker(): Promise<SandboxDetect['docker']> {
  const client = await run('docker', ['--version'])
  if (!client.ok) return { cliFound: false, daemonRunning: false, version: '' }
  const server = await run('docker', ['version', '--format', '{{.Server.Version}}'])
  const serverVersion = server.stdout.trim()
  return {
    cliFound: true,
    daemonRunning: server.ok && !!serverVersion,
    version: serverVersion || client.stdout.trim(),
  }
}

async function detectWsl(): Promise<SandboxDetect['wsl']> {
  // wsl -l -q 在 Windows 上输出 UTF-16LE
  const res = await run('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' })
  if (!res.ok) return { available: false, distros: [] }
  const distros = res.stdout
    .replace(/ /g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  return { available: distros.length > 0, distros }
}

// ── 镜像 ─────────────────────────────────────────────────────────

function piEngineVersion(): string {
  try {
    const pkg = join(dirname(dirname(resolvePiCliPath())), 'package.json')
    return (JSON.parse(readFileSync(pkg, 'utf8')).version as string) || 'latest'
  } catch {
    return 'latest'
  }
}

/** 镜像 tag 绑定 pi 版本,升级 pi 时自动指向新镜像。 */
export function sandboxImageTag(): string {
  return `pi-studio-sandbox:${piEngineVersion()}`
}

async function imageExists(tag: string): Promise<boolean> {
  const r = await run('docker', ['image', 'inspect', tag], { timeoutMs: 8000 })
  return r.ok
}

const DOCKERFILE = `FROM node:24-bookworm-slim
ARG PI_VERSION=latest
RUN apt-get update \\
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@\${PI_VERSION}
WORKDIR /workspace
`

let imageBuildPromise: Promise<{ ok: true } | { error: string }> | null = null

/** 首次构建沙箱镜像;stdout/stderr 逐行广播给渲染进程做进度。 */
function buildImage(): Promise<{ ok: true } | { error: string }> {
  // The settings modal can be opened in more than one window, and a double
  // click should not start two Docker builds competing for the same tag.
  if (imageBuildPromise) return imageBuildPromise

  const version = piEngineVersion()
  const tag = sandboxImageTag()
  const ctx = join(app.getPath('userData'), 'sandbox')
  mkdirSync(ctx, { recursive: true })
  writeFileSync(join(ctx, 'Dockerfile'), DOCKERFILE, 'utf8')

  const emit = (line: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('sandbox:buildProgress', line)
    }
  }

  imageBuildPromise = new Promise((resolve) => {
    const child = spawn(
      'docker',
      ['build', '-t', tag, '--build-arg', `PI_VERSION=${version}`, ctx],
      { windowsHide: true },
    )
    let tail = ''
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-2000)
      text.split(/\r?\n/).forEach((l) => l.trim() && emit(l.trim()))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => resolve({ error: err.message }))
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ error: `docker build 失败(退出码 ${code})\n${tail.slice(-500)}` })
    })
  })
  imageBuildPromise.finally(() => {
    imageBuildPromise = null
  })
  return imageBuildPromise
}

// ── 中继 shim ────────────────────────────────────────────────────

export function sandboxRpcShimSource(): string {
  return `// pi-studio 沙箱中继:RpcClient 以为在跑 node,实际把 stdio 转发进容器。
const { spawn } = require('child_process')
const pre = JSON.parse(process.env.PISTUDIO_DOCKER_ARGS || '[]')
const child = spawn('docker', [...pre, 'pi', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
})
const forward = (signal) => {
  if (!child.killed) {
    try { child.kill(signal) } catch {}
  }
}
process.once('SIGTERM', () => forward('SIGTERM'))
process.once('SIGINT', () => forward('SIGINT'))
process.once('exit', () => forward('SIGTERM'))
child.on('exit', (code) => process.exit(code == null ? 1 : code))
child.on('error', (err) => {
  process.stderr.write(String((err && err.message) || err) + '\\n')
  process.exit(1)
})
`
}

function ensureShim(): string {
  const p = join(app.getPath('userData'), 'sandbox-rpc-shim.cjs')
  writeFileSync(p, sandboxRpcShimSource(), 'utf8') // 每次覆盖,保证内容跟版本一致
  return p
}

// ── docker run 参数组装(纯函数,可单测) ──────────────────────────

/**
 * 组装 `docker run` 到 IMAGE 为止的参数(不含 pi 命令本身,shim 会追加 `pi <argv>`)。
 * 工作区挂 /workspace、agent 配置目录挂 /agent(models 覆盖/扩展/session 都在这),
 * PI_CODING_AGENT_DIR 强制指向 /agent,其余 env(API key 等)按名字透传。
 */
export function buildSandboxDockerArgs(opts: {
  image: string
  hostWorkspace: string
  hostAgentDir: string
  envNames: string[]
}): string[] {
  const forwardedEnvNames = [
    ...new Set(
      opts.envNames.filter((n) => n !== 'PI_CODING_AGENT_DIR' && n !== 'PISTUDIO_DOCKER_ARGS'),
    ),
  ]
  return [
    'run',
    '-i',
    '--rm',
    '-v',
    `${opts.hostWorkspace}:/workspace`,
    '-w',
    '/workspace',
    '-v',
    `${opts.hostAgentDir}:/agent`,
    '-e',
    'PI_CODING_AGENT_DIR=/agent',
    ...forwardedEnvNames.flatMap((n) => ['-e', n]),
    opts.image,
  ]
}

/**
 * 沙箱模式下给 RpcClient 用的 cliPath + env。daemon 没起或镜像缺失时抛错,
 * 让 workspace:open 把错误透出去(而不是卡住)。
 */
export async function prepareSandboxLaunch(
  cwd: string,
  env: Record<string, string>,
): Promise<{ cliPath: string; env: Record<string, string>; mode: 'wsl' | 'docker' }> {
  // 首选 WSL2 + bubblewrap(docs/sandbox-mode-plan.md「2026-07-15 复盘与决策」):
  // 文件隔离靠 mount namespace,出站经主机侧白名单代理——根治 Docker 容器出网不通。
  if (await detectWslSandboxDistro()) {
    return { ...(await prepareWslSandboxLaunch(cwd, env)), mode: 'wsl' }
  }

  const docker = await detectDocker()
  if (!docker.daemonRunning) {
    throw new Error(
      '沙箱模式已开启,但未找到 pi-studio-sandbox WSL 发行版,Docker 也未运行 —— ' +
        '推荐按 docs/sandbox-mode-plan.md 准备 WSL 沙箱发行版(约 1 分钟)',
    )
  }
  const tag = sandboxImageTag()
  if (!(await imageExists(tag))) {
    throw new Error(`沙箱镜像不存在(${tag}) —— 请在 设置 → 安全策略 里点「构建镜像」`)
  }
  const dockerArgs = buildSandboxDockerArgs({
    image: tag,
    hostWorkspace: cwd,
    hostAgentDir: agentConfigDir(),
    envNames: [
      ...Object.keys(env),
      // Preserve proxy settings used by the host for OpenAI-compatible gateways.
      // Only names with a value are forwarded; secrets still travel by name
      // from the explicit env object above and never appear in this argv.
      ...[
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
      ].filter((name) => !!process.env[name]),
    ],
  })
  appendAppLog('info', 'sandbox.launch', 'Launching pi inside Docker sandbox', { cwd, tag })
  return {
    cliPath: ensureShim(),
    env: { ...env, PISTUDIO_DOCKER_ARGS: JSON.stringify(dockerArgs) },
    mode: 'docker',
  }
}

// ── 注册 ─────────────────────────────────────────────────────────

export function registerSandbox(): void {
  ipcMain.handle('sandbox:detect', async (): Promise<SandboxDetect> => {
    const [docker, wsl, wslSandboxReady] = await Promise.all([
      detectDocker(),
      detectWsl(),
      detectWslSandboxDistro(),
    ])
    return { docker, wslSandboxReady, wsl }
  })

  ipcMain.handle('sandbox:imageStatus', async (): Promise<SandboxImageStatus> => {
    const docker = await detectDocker()
    const tag = sandboxImageTag()
    return { tag, daemonRunning: docker.daemonRunning, exists: docker.daemonRunning && (await imageExists(tag)) }
  })

  ipcMain.handle('sandbox:buildImage', async () => {
    try {
      return await buildImage()
    } catch (err) {
      appendAppLog('error', 'sandbox.build', 'Sandbox image build failed', normalizeError(err))
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}

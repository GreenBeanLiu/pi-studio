#!/usr/bin/env node
/**
 * 打包产物的启动冒烟。
 *
 * 存在的理由:typecheck、lint、测试、electron-vite build 全绿,也挡不住
 * 「装好之后一点就崩」。2026-08-25 真踩过一次 —— @agentclientprotocol/sdk 把 zod
 * 声明成 peerDependency,pnpm 不把 peer 提到顶层,electron-builder 只拷贝顶层看得见
 * 的包,于是打出来的 app 一启动就 ERR_MODULE_NOT_FOUND。四个 gate 一个都没响。
 *
 * 判据不能只是「进程还活着」:主进程未捕获异常时 Electron 会弹一个错误对话框,
 * 进程照样跑着,stderr 也可能什么都没有(实测把 zod 从包里抽走就是这样)。
 * 所以看的是一个真实的就绪信号 —— app 起来会往自己的日志写一条 App ready,
 * 崩在模块加载阶段就永远写不到。
 *
 * 用最小环境启动(只给 HOME/USER),是因为从 Finder / Dock 双击的 app 拿到的就是
 * 这样一个环境 —— 没有 shell 的 PATH,也没有代理变量。在带完整环境的终端里启动
 * 测不出这一类问题。
 *
 * 还有一条更隐蔽的:**必须把产物拷到仓库外再启动**。dist/ 就在项目目录里,
 * Node 解析模块会逐层向上找,一路能摸到 pi-studio/node_modules —— 少打进包的依赖
 * 在原地测时照样解析得到,装到 /Applications 就炸。zod 那次正是这样:本地怎么试
 * 都好好的,用户装完一点就崩。所以脚本自己先拷到临时目录。
 *
 * 用法:
 *   node scripts/smoke-launch.mjs dist/mac-arm64/pi-studio.app
 *   node scripts/smoke-launch.mjs dist/win-unpacked --seconds 20
 */
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const target = args.find((arg) => !arg.startsWith('--'))
const secondsFlag = args.indexOf('--seconds')
const seconds = secondsFlag >= 0 ? Number(args[secondsFlag + 1]) : 15

if (!target) {
  console.error('用法: node scripts/smoke-launch.mjs <打包产物路径> [--seconds N]')
  process.exit(2)
}
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`--seconds 无效: ${args[secondsFlag + 1]}`)
  process.exit(2)
}

/** 从 .app 包或 win-unpacked 目录里找到真正的可执行文件。 */
function resolveExecutable(path) {
  const full = resolve(path)
  if (!existsSync(full)) throw new Error(`产物不存在: ${full}`)
  if (full.endsWith('.app')) {
    const macos = join(full, 'Contents', 'MacOS')
    const entries = readdirSync(macos)
    if (entries.length === 0) throw new Error(`${macos} 里没有可执行文件`)
    return join(macos, entries[0])
  }
  if (statSync(full).isDirectory()) {
    const exe = readdirSync(full).find((name) => name.endsWith('.exe'))
    if (!exe) throw new Error(`${full} 里没有 .exe`)
    return join(full, exe)
  }
  return full
}

/** 主进程未捕获异常在 Electron 里会走这些字样。 */
const FATAL_PATTERNS = [
  /Uncaught Exception/i,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find (module|package)/,
  /A JavaScript error occurred/i,
]

/** app 自己的日志。userData 的位置由 Electron 定,这里按平台复现。 */
function appLogFile() {
  const home = process.env.HOME ?? ''
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'pi-studio', 'logs', 'pi-studio.log')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'pi-studio', 'logs', 'pi-studio.log')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'pi-studio', 'logs', 'pi-studio.log')
}

/**
 * 这次启动有没有写出 App ready。
 *
 * 日志是累积的,所以要比时间戳 —— 不能看见历史上有过就算数。
 */
function becameReady(logPath, since) {
  if (!existsSync(logPath)) return false
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return false
  }
  for (const line of text.split('\n').slice(-400)) {
    if (!line.includes('"App ready"')) continue
    try {
      const entry = JSON.parse(line)
      if (Date.parse(entry.ts) >= since) return true
    } catch {
      // 半行日志不算数
    }
  }
  return false
}

// 拷到仓库外。原地启动的话,少打进包的依赖会从项目的 node_modules 里被解析到,
// 测出来是绿的,装到别处才炸(zod 那次就是这么漏过去的)。
const stage = mkdtempSync(join(tmpdir(), 'pi-studio-smoke-'))
const source = resolve(target)
const staged = join(stage, basename(source))
cpSync(source, staged, { recursive: true, verbatimSymlinks: true })
if (process.platform === 'darwin' && staged.endsWith('.app')) {
  // 拷过之后签名会失效,arm64 上不签就起不来。ad-hoc 足够本地/CI 用。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', staged], {
    stdio: 'ignore',
  })
}
const cleanupStage = () => rmSync(stage, { recursive: true, force: true })

const executable = resolveExecutable(staged)
console.log(`启动 ${executable}`)
console.log(`(已拷到仓库外:少打进包的依赖在原地测会被项目的 node_modules 兜住)`)
console.log(`最小环境(模拟 Finder 双击):只给 HOME / USER,不给 PATH 和代理`)

// 只给最低限度的变量。Windows 上 SystemRoot 是加载系统 DLL 必需的,不给起不来。
const env = { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '' }
if (process.platform === 'win32') {
  env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  env.TEMP = process.env.TEMP ?? ''
  env.APPDATA = process.env.APPDATA ?? ''
  env.LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
}

const logPath = appLogFile()
// 日志是累积的,记下启动时刻,只认这之后的 App ready。留 1 秒余量防时钟抖动。
const startedAt = Date.now() - 1_000

const child = spawn(executable, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
const collect = (chunk) => {
  output += chunk.toString('utf8')
  if (output.length > 200_000) output = output.slice(-200_000)
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

let spawnError = null
child.on('error', (error) => {
  spawnError = error
})

let exited = null
child.on('exit', (code, signal) => {
  exited = { code, signal }
})

const report = (ok, reason) => {
  if (output.trim()) {
    console.log('--- 进程输出 ---')
    console.log(output.trim().split('\n').slice(-40).join('\n'))
    console.log('----------------')
  }
  cleanupStage()
  console.log(ok ? `✓ ${reason}` : `✗ ${reason}`)
  process.exit(ok ? 0 : 1)
}

// 到点就停,不用干等满 N 秒。
let ready = false
for (let waited = 0; waited < seconds * 1000; waited += 500) {
  await new Promise((r) => setTimeout(r, 500))
  if (spawnError || exited) break
  if (becameReady(logPath, startedAt)) {
    ready = true
    break
  }
}

if (spawnError) report(false, `起不来: ${spawnError.message}`)
if (exited) {
  report(false, `${seconds} 秒内就退出了(code=${exited.code} signal=${exited.signal})`)
}

const fatal = FATAL_PATTERNS.find((pattern) => pattern.test(output))
child.kill('SIGTERM')
// 给它一点时间体面地退,不然 CI 上会留下孤儿进程。
await new Promise((r) => setTimeout(r, 1_500))
if (!exited) child.kill('SIGKILL')

if (fatal) report(false, `进程还活着,但输出里有致命错误(${fatal})`)
if (!ready) {
  report(
    false,
    `进程还活着,但 ${seconds} 秒内没写出 App ready —— 主进程八成崩在启动阶段` +
      `(Electron 会弹错误框,进程不退)。日志:${logPath}`,
  )
}
report(true, `启动成功:写出了 App ready,输出里没有致命错误`)

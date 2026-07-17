import { app, net } from 'electron'
import { spawn, execFile } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { appendAppLog, normalizeError } from './app-log'
import {
  BLENDER_MCP_ADDON_URL,
  BLENDER_MCP_COMMIT,
  blenderAddonPath,
  buildBlenderBootstrapScript,
  parseBlenderVersion,
  verifyPinnedAddon,
} from './blender-setup-core'

export type BlenderInstallStatus = {
  blenderFound: boolean
  addonInstalled: boolean
  blenderPath?: string
  version?: string
}
const BLENDER_EXE = 'blender.exe'

function standardBlenderRoots(): string[] {
  const roots = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value) roots.add(join(value, 'Blender Foundation'))
  }
  add(process.env.ProgramFiles)
  add(process.env['ProgramFiles(x86)'])
  if (process.env.LOCALAPPDATA) roots.add(join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation'))

  // Blender 常被装到非系统盘；只检查每个盘符下的标准目录，不做全盘扫描。
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    roots.add(`${String.fromCharCode(code)}:\\Program Files\\Blender Foundation`)
  }
  return [...roots]
}

function executablesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Blender(?:\s|$)/i.test(entry.name))
      .map((entry) => join(root, entry.name, BLENDER_EXE))
      .filter(existsSync)
  } catch {
    return []
  }
}

function compareBlenderPaths(a: string, b: string): number {
  const av = parseBlenderVersion(a)?.split('.').map(Number) ?? [0, 0]
  const bv = parseBlenderVersion(b)?.split('.').map(Number) ?? [0, 0]
  return bv[0] - av[0] || bv[1] - av[1] || b.localeCompare(a)
}

function execFileText(file: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function pathBlenderExecutables(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  try {
    const output = await execFileText('where.exe', [BLENDER_EXE], 5000)
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && existsSync(line))
  } catch {
    return []
  }
}

export async function findBlenderExecutable(): Promise<string | null> {
  const candidates = new Set<string>()
  for (const root of standardBlenderRoots()) {
    for (const executable of executablesUnder(root)) candidates.add(executable)
  }
  for (const executable of await pathBlenderExecutables()) candidates.add(executable)
  return [...candidates].sort(compareBlenderPaths)[0] ?? null
}

async function detectBlenderVersion(executable: string): Promise<string> {
  try {
    const output = await execFileText(executable, ['--version'])
    const version = parseBlenderVersion(output)
    if (version) return version
  } catch (error) {
    appendAppLog('warn', 'blenderSetup.version', '读取 Blender 版本失败，改用安装目录判断', normalizeError(error))
  }
  const version = parseBlenderVersion(executable)
  if (!version) throw new Error('找到了 Blender，但无法识别版本')
  return version
}

function hasValidAddon(file: string): boolean {
  try {
    return verifyPinnedAddon(readFileSync(file))
  } catch {
    return false
  }
}

export async function inspectBlenderInstall(): Promise<BlenderInstallStatus> {
  const executable = await findBlenderExecutable()
  if (!executable) return { blenderFound: false, addonInstalled: false }
  const version = await detectBlenderVersion(executable)
  const addonPath = blenderAddonPath(app.getPath('appData'), version)
  return {
    blenderFound: true,
    addonInstalled: hasValidAddon(addonPath),
    blenderPath: executable,
    version,
  }
}

async function pinnedAddonBytes(): Promise<Buffer> {
  const cacheDir = join(app.getPath('userData'), 'blender-mcp')
  const cachePath = join(cacheDir, `${BLENDER_MCP_COMMIT}.py`)
  if (hasValidAddon(cachePath)) return readFileSync(cachePath)

  const response = await net.fetch(BLENDER_MCP_ADDON_URL)
  if (!response.ok) throw new Error(`下载 blender-mcp addon 失败: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!verifyPinnedAddon(bytes)) throw new Error('blender-mcp addon 校验失败，已拒绝安装')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cachePath, bytes)
  return bytes
}

async function launchBlender(executable: string, bootstrapPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--python', bootstrapPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

export async function installAddonAndLaunchBlender(): Promise<BlenderInstallStatus> {
  const executable = await findBlenderExecutable()
  if (!executable) throw new Error('没有找到 Blender，请先安装 Blender 3.0 或更高版本')
  const version = await detectBlenderVersion(executable)
  const addonPath = blenderAddonPath(app.getPath('appData'), version)
  const bytes = await pinnedAddonBytes()
  mkdirSync(dirname(addonPath), { recursive: true })
  if (!hasValidAddon(addonPath)) writeFileSync(addonPath, bytes)

  const bootstrapPath = join(app.getPath('userData'), 'blender-mcp', 'pi-studio-start.py')
  mkdirSync(dirname(bootstrapPath), { recursive: true })
  writeFileSync(bootstrapPath, buildBlenderBootstrapScript(), 'utf-8')

  appendAppLog('info', 'blenderSetup.launch', '启动 Blender 并启用 blender-mcp', {
    executable,
    version,
    addonPath,
  })
  await launchBlender(executable, bootstrapPath)
  return { blenderFound: true, addonInstalled: true, blenderPath: executable, version }
}

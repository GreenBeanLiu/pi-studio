/** 本地文本工具绑定调用时指定的工作区，避免桌面切换目录后把云端调用落到错误位置。 */
import { randomUUID } from 'crypto'
import { closeSync, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

export const LOCAL_FILE_MAX_BYTES = 64 * 1024

export class LocalFileToolError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

function fail(message: string, code = 'INVALID_TOOL_ARGUMENTS'): never {
  throw new LocalFileToolError(message, code)
}

function fileTarget(workspace: string | null, args: Record<string, unknown>): string {
  if (!workspace) fail('No workspace is open', 'NO_WORKSPACE')
  if (typeof args.workspace !== 'string' || !isAbsolute(args.workspace)) {
    fail('arguments.workspace must be an absolute workspace path')
  }
  const root = realpathSync(workspace)
  if (relative(root, realpathSync(args.workspace)) !== '') {
    fail('The requested workspace is not the active workspace', 'WORKSPACE_MISMATCH')
  }
  if (typeof args.path !== 'string' || !args.path || isAbsolute(args.path)) {
    fail('arguments.path must be a nonempty relative file path')
  }
  const segments = args.path.split(/[\\/]/)
  // 同一份路径在 Windows / Mac 上含义一致；不接受设备名、ADS 或目录穿越。
  if (segments.some((part) => !part || part === '.' || part === '..' ||
    /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('arguments.path contains an unsupported path component', 'INVALID_PATH')
  }
  const target = resolve(root, ...segments)
  if (relative(root, target).startsWith(`..${sep}`) || isAbsolute(relative(root, target))) {
    fail('File path must stay within the workspace', 'INVALID_PATH')
  }
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index === segments.length - 1) break
      throw error
    }
    if (info.isSymbolicLink()) fail('Symbolic links are not supported by local file tools', 'INVALID_PATH')
    if (index < segments.length - 1 && !info.isDirectory()) fail('Parent path is not a directory', 'INVALID_PATH')
    if (index === segments.length - 1 && !info.isFile()) fail('Path is not a regular file', 'INVALID_PATH')
  }
  return target
}

export function readLocalFile(workspace: string | null, args: Record<string, unknown>): unknown {
  const target = fileTarget(workspace, args)
  const fd = openSync(target, 'r')
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) fail('Path is not a regular file', 'INVALID_PATH')
    if (info.size > LOCAL_FILE_MAX_BYTES) fail('File exceeds the 64 KiB text limit', 'FILE_TOO_LARGE')
    const buffer = Buffer.alloc(LOCAL_FILE_MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
    }
    if (bytes > LOCAL_FILE_MAX_BYTES) fail('File exceeds the 64 KiB text limit', 'FILE_TOO_LARGE')
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes))
    } catch {
      fail('File is not valid UTF-8 text', 'INVALID_TEXT')
    }
    if (content.includes('\0')) fail('Binary files are not supported', 'INVALID_TEXT')
    return { path: args.path, content, bytes, encoding: 'utf-8' }
  } finally {
    closeSync(fd)
  }
}

export function writeLocalFile(workspace: string | null, args: Record<string, unknown>): unknown {
  if (typeof args.content !== 'string' || args.content.includes('\0')) fail('arguments.content must be UTF-8 text')
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') fail('arguments.overwrite must be boolean')
  const content = Buffer.from(args.content, 'utf8')
  if (content.toString('utf8') !== args.content) fail('arguments.content contains invalid Unicode', 'INVALID_TEXT')
  if (content.length > LOCAL_FILE_MAX_BYTES) fail('Content exceeds the 64 KiB text limit', 'FILE_TOO_LARGE')
  const target = fileTarget(workspace, args)
  // 先完成新文件再发布；默认以硬链接独占创建，覆盖时替换目录项，均不截断旧文件。
  const temporary = join(dirname(target), `.tool-write-${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx')
  try {
    try {
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
    if (args.overwrite === true) renameSync(temporary, target)
    else linkSync(temporary, target)
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { path: args.path, bytes: content.length, encoding: 'utf-8' }
}

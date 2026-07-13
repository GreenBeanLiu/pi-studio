import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, relative, resolve } from 'path'
import { inferRoutineImageRole, type RoutineImageAsset } from './routine-assets'

export type RoutineMaterialFolder = {
  text: string
  images: RoutineImageAsset[]
  warnings: string[]
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.html', '.htm', '.csv', '.json', '.yaml', '.yml'])
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const MAX_TEXT_FILE_BYTES = 512 * 1024
const MAX_TOTAL_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILES = 200

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

function readTextPrefix(path: string, bytes: number): string {
  const buffer = Buffer.alloc(bytes)
  const descriptor = openSync(path, 'r')
  try {
    const read = readSync(descriptor, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export function readRoutineMaterialFolder(
  workspacePath: string,
  requestedPath: string,
): RoutineMaterialFolder {
  const workspace = realpathSync(resolve(workspacePath))
  const target = realpathSync(resolve(workspace, requestedPath))
  if (!inside(workspace, target)) throw new Error('Material folder must be inside the workflow workspace')
  if (!statSync(target).isDirectory()) throw new Error('Material folder path is not a directory')

  const files: string[] = []
  const warnings: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) {
        if (!warnings.includes(`Stopped after ${MAX_FILES} files`)) warnings.push(`Stopped after ${MAX_FILES} files`)
        return
      }
      const path = resolve(directory, entry.name)
      const real = realpathSync(path)
      if (!inside(workspace, real)) {
        warnings.push(`Skipped path outside workspace: ${slash(relative(target, path))}`)
        continue
      }
      if (entry.isDirectory()) visit(real)
      else if (entry.isFile()) files.push(real)
    }
  }
  visit(target)
  files.sort((a, b) => slash(relative(target, a)).localeCompare(slash(relative(target, b))))

  const textSections: string[] = []
  const images: RoutineImageAsset[] = []
  let remainingTextBytes = MAX_TOTAL_TEXT_BYTES
  for (const file of files) {
    const name = slash(relative(target, file))
    const extension = extname(file).toLowerCase()
    const size = statSync(file).size
    if (TEXT_EXTENSIONS.has(extension)) {
      if (remainingTextBytes <= 0) {
        warnings.push(`Skipped text after 2MB total limit: ${name}`)
        continue
      }
      const bytes = Math.min(size, MAX_TEXT_FILE_BYTES, remainingTextBytes)
      const content = readTextPrefix(file, bytes)
      remainingTextBytes -= bytes
      textSections.push(`## ${name}\n${content}`)
      if (bytes < size) warnings.push(`Truncated large text file: ${name}`)
      continue
    }
    const mimeType = IMAGE_MIME_TYPES[extension]
    if (mimeType) {
      if (size > MAX_IMAGE_BYTES) {
        warnings.push(`Skipped image over 10MB: ${name}`)
        continue
      }
      images.push({
        id: `folder:${name}`,
        kind: 'image',
        source: 'folder',
        name,
        role: inferRoutineImageRole(name),
        uri: file,
      })
      continue
    }
    warnings.push(`Skipped unsupported file: ${name}`)
  }

  if (images.length > 0) {
    textSections.push(`## Available images\n${images.map((image) => `- ${image.name} (${image.role})`).join('\n')}`)
  }
  return { text: textSections.join('\n\n'), images, warnings }
}

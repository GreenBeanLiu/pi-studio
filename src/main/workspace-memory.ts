import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { agentConfigDir } from './settings'

export type WorkspaceMemory = {
  path: string
  exists: boolean
  content: string
}

const MEMORY_DIR = '.pi-studio'
const MEMORY_FILE = 'memory.md'

export const DEFAULT_WORKSPACE_MEMORY = `# Workspace Memory

## Project Facts
-

## User Preferences
-

## Commands
-

## Decisions
-

## Pitfalls
-
`

const EXTENSION_SOURCE = `import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const MAX_MEMORY_CHARS = 12000

function memoryPath(cwd: string): string {
  return path.join(cwd, '.pi-studio', 'memory.md')
}

function readWorkspaceMemory(cwd: string): string {
  const file = memoryPath(cwd)
  if (!fs.existsSync(file)) return ''
  const content = fs.readFileSync(file, 'utf-8').trim()
  if (!content) return ''
  if (content.length <= MAX_MEMORY_CHARS) return content
  return content.slice(0, MAX_MEMORY_CHARS) + '\\n\\n[Workspace memory truncated by pi-studio]'
}

export default function piStudioWorkspaceMemory(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event, ctx) => {
    const memory = readWorkspaceMemory(ctx.cwd)
    if (!memory) return undefined

    return {
      systemPrompt:
        event.systemPrompt +
        \`

## Pi Studio Workspace Memory

The following project memory was saved by the user for this workspace. Treat it as persistent guidance and context. If it conflicts with the current user request or the repository contents, prefer the current request and verified repository state.

<workspace-memory>
\${memory}
</workspace-memory>
\`,
    }
  })
}
`

function normalizePath(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
}

function assertInsideWorkspace(workspacePath: string, targetPath: string): void {
  const workspace = normalizePath(workspacePath)
  const target = normalizePath(targetPath)
  if (target !== workspace && !target.startsWith(`${workspace}${sep}`)) {
    throw new Error('Memory path is outside the current workspace')
  }
}

export function workspaceMemoryPath(workspacePath: string): string {
  const file = join(workspacePath, MEMORY_DIR, MEMORY_FILE)
  assertInsideWorkspace(workspacePath, file)
  return file
}

export function loadWorkspaceMemory(workspacePath: string): WorkspaceMemory {
  const file = workspaceMemoryPath(workspacePath)
  if (!existsSync(file)) {
    return { path: file, exists: false, content: DEFAULT_WORKSPACE_MEMORY }
  }

  return {
    path: file,
    exists: true,
    content: readFileSync(file, 'utf-8'),
  }
}

export function saveWorkspaceMemory(workspacePath: string, content: string): WorkspaceMemory {
  const file = workspaceMemoryPath(workspacePath)
  mkdirSync(join(workspacePath, MEMORY_DIR), { recursive: true })
  writeFileSync(file, content, 'utf-8')
  return { path: file, exists: true, content }
}

export function syncWorkspaceMemoryExtension(): void {
  const dir = join(agentConfigDir(), 'extensions')
  const file = join(dir, 'pi-studio-workspace-memory.ts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, EXTENSION_SOURCE, 'utf-8')
}

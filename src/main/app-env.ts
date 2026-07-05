import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

let loaded = false

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const idx = trimmed.indexOf('=')
  if (idx <= 0) return null

  const key = trimmed.slice(0, idx).trim()
  let value = trimmed.slice(idx + 1).trim()

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }

  return key ? [key, value] : null
}

function applyEnvFile(path: string): void {
  if (!existsSync(path)) return

  const text = readFileSync(path, 'utf-8')
  for (const line of text.split(/\r?\n/)) {
    const entry = parseEnvLine(line)
    if (!entry) continue

    const [key, value] = entry
    if (!process.env[key]) process.env[key] = value
  }
}

export function backendEnvPath(): string {
  return join(app.getPath('userData'), '.env')
}

export function loadBackendEnv(): void {
  if (loaded) return
  loaded = true

  applyEnvFile(backendEnvPath())
  applyEnvFile(join(process.cwd(), '.env.local'))
  applyEnvFile(join(process.cwd(), '.env'))
}

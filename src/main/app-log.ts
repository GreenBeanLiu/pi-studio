import { app, BrowserWindow } from 'electron'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

type AppLogLevel = 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const TRIM_TO_BYTES = 1024 * 1024
const DEFAULT_READ_BYTES = 128 * 1024
const MAX_STRING_LENGTH = 4000
const REDACTED = '[redacted]'
let processLoggersInstalled = false

function appLogFile(): string {
  return join(app.getPath('userData'), 'logs', 'pi-studio.log')
}

function ensureLogDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

function isSecretKey(key: string): boolean {
  return /api[-_]?key|token|secret|authorization|password|credential/i.test(key)
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`
    : value
}

function normalizeDetails(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value instanceof Error) return normalizeError(value)
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth > 4) return '[max-depth]'

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => normalizeDetails(item, seen, depth + 1))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = isSecretKey(key) ? REDACTED : normalizeDetails(item, seen, depth + 1)
    }
    return output
  }

  return String(value)
}

export function normalizeError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return normalizeDetails(err)
}

function trimLogIfNeeded(file: string): void {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size <= MAX_LOG_BYTES) return

  const bytesToRead = Math.min(TRIM_TO_BYTES, size)
  const buffer = Buffer.alloc(bytesToRead)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead)
  } finally {
    closeSync(fd)
  }
  writeFileSync(file, buffer.toString('utf-8'), 'utf-8')
}

export function appendAppLog(
  level: AppLogLevel,
  source: string,
  message: string,
  details?: unknown,
): void {
  try {
    const file = appLogFile()
    ensureLogDir(file)
    trimLogIfNeeded(file)
    const entry = {
      ts: new Date().toISOString(),
      level,
      source,
      message: truncateString(message),
      ...(details === undefined ? {} : { details: normalizeDetails(details) }),
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch {
    // Logging must never break the app path that is being logged.
  }
}

export function readRecentAppLog(maxBytes = DEFAULT_READ_BYTES): string {
  try {
    const file = appLogFile()
    const size = statSync(file).size
    const bytesToRead = Math.min(maxBytes, size)
    const buffer = Buffer.alloc(bytesToRead)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, bytesToRead, size - bytesToRead)
    } finally {
      closeSync(fd)
    }
    return buffer.toString('utf-8')
  } catch {
    return ''
  }
}

export function installProcessLoggers(): void {
  if (processLoggersInstalled) return
  processLoggersInstalled = true

  process.on('uncaughtException', (err) => {
    appendAppLog('error', 'process.uncaughtException', 'Uncaught exception', normalizeError(err))
  })

  process.on('unhandledRejection', (reason) => {
    appendAppLog('error', 'process.unhandledRejection', 'Unhandled rejection', normalizeError(reason))
  })
}

export function attachWindowLoggers(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    appendAppLog('error', 'renderer.gone', 'Renderer process gone', details)
  })

  win.webContents.on('unresponsive', () => {
    appendAppLog('warn', 'renderer.unresponsive', 'Renderer became unresponsive')
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendAppLog('error', 'renderer.load', 'Renderer failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
    })
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    appendAppLog(level >= 3 ? 'error' : 'warn', 'renderer.console', message, {
      level,
      line,
      sourceId,
    })
  })
}

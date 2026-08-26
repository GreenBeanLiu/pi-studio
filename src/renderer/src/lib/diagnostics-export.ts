import type { DesktopApi } from './api'

/**
 * 诊断导出必须在 agent 和工作区都不可用时仍能工作，否则最需要证据的启动故障反而无法排查。
 * 这里只读取现有只读 IPC，并在 renderer 侧做字段级脱敏；不新增主进程能力，也不扩大跨进程权限。
 */
type GlobalDiagnosticsApi = {
  platform: DesktopApi['platform']
  app: Pick<DesktopApi['app'], 'version' | 'piVersion'>
  settings: Pick<DesktopApi['settings'], 'load'>
  diagnostics: Pick<DesktopApi['diagnostics'], 'getLogs' | 'save'>
  pi: Pick<DesktopApi['pi'], 'getRuntimeSnapshot'>
}

export function sanitizeForDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max depth]'
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > 4000 ? `${value.slice(0, 4000)}\n...[truncated ${value.length - 4000} chars]` : value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeForDiagnostics(item, depth + 1))

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase()
    if (
      normalized === 'data' ||
      normalized.includes('apikey') ||
      normalized.includes('api_key') ||
      normalized.includes('authorization') ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('token')
    ) {
      output[key] = '[redacted]'
      continue
    }
    output[key] = sanitizeForDiagnostics(item, depth + 1)
  }
  return output
}

export function diagnosticFileName(scope = 'startup', now = new Date()): string {
  const safeScope = scope.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 48) || 'startup'
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `pi-studio-diagnostics-${safeScope}-${stamp}.json`
}

export async function exportGlobalDiagnostics(api: GlobalDiagnosticsApi, now = new Date()) {
  const [runtimeSnapshot, appVersion, piVersion, settings, logs] = await Promise.all([
    api.pi.getRuntimeSnapshot().catch(() => null),
    api.app.version().catch(() => 'unknown'),
    api.app.piVersion().catch(() => 'unknown'),
    api.settings.load().catch(() => null),
    api.diagnostics.getLogs().catch((error) => ({
      error: error instanceof Error ? error.message : 'Failed to read app logs',
    })),
  ])
  const diagnostic = {
    exportedAt: now.toISOString(),
    app: { version: appVersion, piVersion, platform: api.platform },
    workspace: null,
    settings: settings
      ? {
          selectedModelRoute: settings.selectedModelRoute,
          modelAccessConfigured: settings.modelAccessConfigured,
          tavilyConfigured: !!settings.tavilyApiKey,
          subagentsEnabled: settings.subagentsEnabled,
        }
      : null,
    runtime: sanitizeForDiagnostics(runtimeSnapshot),
    logs: sanitizeForDiagnostics(logs),
  }
  return api.diagnostics.save({
    defaultPath: diagnosticFileName('startup', now),
    content: `${JSON.stringify(diagnostic, null, 2)}\n`,
  })
}

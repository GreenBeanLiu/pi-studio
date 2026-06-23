import { useState } from 'react'
import { createStyles } from 'antd-style'
import { ChevronRight, Terminal, FileEdit, FileText, Search, Loader2, Check, X } from 'lucide-react'
import type { ToolCall } from '../lib/api'

export type ToolExecutionState = {
  toolName: string
  args: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
}

const useStyles = createStyles(({ token, css }) => ({
  card: css`
    margin: 4px 0;
    border-radius: ${token.borderRadiusLG}px;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorFillTertiary};
    overflow: hidden;
    font-family: ${token.fontFamilyCode};
    max-width: 560px;
  `,

  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    font-family: ${token.fontFamily};

    &:hover {
      background: ${token.colorFillSecondary};
    }
  `,

  chevron: css`
    flex-shrink: 0;
    transition: transform ${token.motionDurationFast};
    color: ${token.colorTextTertiary};
  `,

  chevronOpen: css`
    transform: rotate(90deg);
  `,

  toolName: css`
    font-size: 12px;
    font-weight: 600;
    color: ${token.colorText};
    flex-shrink: 0;
  `,

  argSummary: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    font-family: ${token.fontFamilyCode};
  `,

  statusIcon: css`
    flex-shrink: 0;
    display: flex;
    align-items: center;
  `,

  body: css`
    padding: 0 12px 10px 34px;
    font-size: 12px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  `,
}))

const TOOL_ICONS: Record<string, typeof Terminal> = {
  bash: Terminal,
  edit: FileEdit,
  write: FileEdit,
  read: FileText,
  grep: Search,
  find: Search,
  ls: FileText,
}

function summarizeArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object') {
    const obj = args as Record<string, unknown>
    const candidate = obj.command ?? obj.path ?? obj.file_path ?? obj.pattern ?? obj.query
    if (typeof candidate === 'string') return candidate
  }
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function stringifyResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export default function ToolCallCard({ call, execution }: { call: ToolCall; execution?: ToolExecutionState }) {
  const { styles, cx, theme: token } = useStyles()
  const [open, setOpen] = useState(false)

  const Icon = TOOL_ICONS[call.name] ?? Terminal
  const status = execution?.status ?? 'running'

  return (
    <div className={styles.card}>
      <div className={styles.header} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={cx(styles.chevron, open && styles.chevronOpen)} />
        <Icon size={13} color={token.colorTextSecondary} />
        <span className={styles.toolName}>{call.name}</span>
        <span className={styles.argSummary}>{summarizeArgs(call.arguments)}</span>
        <span className={styles.statusIcon}>
          {status === 'running' ? (
            <Loader2 size={12} color={token.colorTextTertiary} className="spin" />
          ) : status === 'error' ? (
            <X size={12} color={token.colorError} />
          ) : (
            <Check size={12} color={token.colorSuccess} />
          )}
        </span>
      </div>
      {open && (
        <div className={styles.body}>
          {execution?.result !== undefined
            ? stringifyResult(execution.result)
            : status === 'running'
              ? '执行中…'
              : '（无结果）'}
        </div>
      )}
    </div>
  )
}

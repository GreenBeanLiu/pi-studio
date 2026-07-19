import { useState } from 'react'
import { createStyles } from 'antd-style'
import {
  ChevronRight,
  Terminal,
  FileEdit,
  FileText,
  Search,
  Loader2,
  Check,
  X,
  Users,
  Bot,
  ClipboardList,
  Hammer,
  ShieldCheck,
} from 'lucide-react'
import type { ToolCall } from '../lib/api'

export type ToolExecutionState = {
  toolName: string
  args: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  /** 工具结果的结构化 details(pi AgentToolResult.details);subagent 用它承载子代理运行信息 */
  details?: unknown
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

  // ── 子代理卡 ──────────────────────────────────────────────
  subCard: css`
    margin: 4px 0;
    border-radius: ${token.borderRadiusLG}px;
    border: 1px solid ${token.colorPrimaryBorder};
    background: ${token.colorPrimaryBg};
    overflow: hidden;
    max-width: 560px;
  `,
  subHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-family: ${token.fontFamily};
    font-size: 12px;
    color: ${token.colorText};
  `,
  subTitle: css`
    font-weight: 600;
  `,
  modeTag: css`
    padding: 0 7px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 18px;
    background: ${token.colorPrimary};
    color: #fff;
    flex-shrink: 0;
  `,
  subProgress: css`
    margin-left: auto;
    font-size: 11px;
    color: ${token.colorTextTertiary};
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  `,
  agentList: css`
    display: flex;
    flex-direction: column;
    padding: 0 8px 8px;
    gap: 3px;
  `,
  agentRow: css`
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    background: ${token.colorBgContainer};
    &:hover {
      background: ${token.colorFillSecondary};
    }
  `,
  agentName: css`
    font-family: ${token.fontFamily};
    font-size: 12px;
    font-weight: 600;
    color: ${token.colorText};
    flex-shrink: 0;
  `,
  agentTask: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  `,
  agentMeta: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  `,
  agentBody: css`
    padding: 4px 8px 8px 30px;
    font-size: 12px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
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
  // pi's toolResult.content is (TextContent | ImageContent)[] — pull the text.
  if (Array.isArray(result)) {
    const texts = result
      .filter((b) => b && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
    if (texts.length > 0) return texts.join('\n')
  }
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

// ── 子代理(subagent)可视化 ──────────────────────────────────────
type SubMessage = { role: string; content?: Array<{ type: string; text?: string }> }
type SubResult = {
  agent: string
  task?: string
  exitCode?: number
  model?: string
  usage?: { totalTokens?: number }
  errorMessage?: string
  messages?: SubMessage[]
}
type SubDetails = { mode?: string; results?: SubResult[] }

const AGENT_ICONS: Record<string, typeof Terminal> = {
  scout: Search,
  planner: ClipboardList,
  worker: Hammer,
  reviewer: ShieldCheck,
}
const MODE_LABEL: Record<string, string> = { single: '单个', parallel: '并行', chain: '顺序' }

/** 子 agent 的最终文本输出:取最后一条有文本的 assistant 消息。 */
function subFinalText(messages?: SubMessage[]): string {
  if (!messages) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      const t = (m.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (t.trim()) return t
    }
  }
  return ''
}
function subToolCount(messages?: SubMessage[]): number {
  if (!messages) return 0
  let n = 0
  for (const m of messages) for (const b of m.content ?? []) if (b.type === 'toolCall') n++
  return n
}
function fmtTok(n?: number): string {
  if (!n) return ''
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function SubagentRow({
  result,
  parentRunning,
  styles,
  cx,
  token,
}: {
  result: SubResult
  parentRunning: boolean
  styles: ReturnType<typeof useStyles>['styles']
  cx: ReturnType<typeof useStyles>['cx']
  token: ReturnType<typeof useStyles>['theme']
}) {
  const [open, setOpen] = useState(false)
  const Icon = AGENT_ICONS[result.agent] ?? Bot
  const failed = (result.exitCode != null && result.exitCode !== 0) || !!result.errorMessage
  const finalText = subFinalText(result.messages)
  // 有最终文本或明确失败 → 该子 agent 已定;否则跟随父级运行态
  const settled = !!finalText || failed || (result.exitCode != null && !parentRunning)
  const status = settled ? (failed ? 'error' : 'done') : 'running'
  const toolCount = subToolCount(result.messages)
  const meta = [toolCount > 0 ? `${toolCount} 步` : '', fmtTok(result.usage?.totalTokens) && `${fmtTok(result.usage?.totalTokens)} tok`]
    .filter(Boolean)
    .join(' · ')
  return (
    <div>
      <div className={styles.agentRow} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={11} className={cx(styles.chevron, open && styles.chevronOpen)} />
        <Icon size={13} color={token.colorTextSecondary} />
        <span className={styles.agentName}>{result.agent}</span>
        <span className={styles.agentTask}>{result.task}</span>
        {meta && <span className={styles.agentMeta}>{meta}</span>}
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
        <div className={styles.agentBody}>
          {result.errorMessage || finalText || (status === 'running' ? '运行中…' : '（无输出）')}
        </div>
      )}
    </div>
  )
}

function SubagentCard({ call, execution }: { call: ToolCall; execution?: ToolExecutionState }) {
  const { styles, cx, theme: token } = useStyles()
  const details = execution?.details as SubDetails | undefined
  const running = !execution || execution.status === 'running'
  // details 未到时(刚发起),从 call.arguments 兜底出占位行
  const args = (call.arguments ?? {}) as {
    mode?: string
    agent?: string
    task?: string
    tasks?: Array<{ agent: string; task?: string }>
    chain?: Array<{ agent: string; task?: string }>
  }
  const mode = details?.mode ?? (args.tasks ? 'parallel' : args.chain ? 'chain' : 'single')
  const results: SubResult[] =
    details?.results && details.results.length > 0
      ? details.results
      : args.tasks ?? args.chain ?? (args.agent ? [{ agent: args.agent, task: args.task }] : [])
  const doneCount = results.filter((r) => r.exitCode === 0 || subFinalText(r.messages)).length
  const errCount = results.filter((r) => (r.exitCode != null && r.exitCode !== 0) || r.errorMessage).length
  const progress = running
    ? `${doneCount + errCount}/${results.length}`
    : `${results.length} 个`
  return (
    <div className={styles.subCard}>
      <div className={styles.subHead}>
        <Users size={14} color={token.colorPrimary} />
        <span className={styles.subTitle}>子代理</span>
        <span className={styles.modeTag}>{MODE_LABEL[mode] ?? mode}</span>
        {running && <Loader2 size={12} color={token.colorTextTertiary} className="spin" />}
        <span className={styles.subProgress}>
          {progress}
          {errCount > 0 ? ` · ${errCount} 失败` : ''}
        </span>
      </div>
      <div className={styles.agentList}>
        {results.map((r, i) => (
          <SubagentRow
            key={`${r.agent}-${i}`}
            result={r}
            parentRunning={running}
            styles={styles}
            cx={cx}
            token={token}
          />
        ))}
      </div>
    </div>
  )
}

export default function ToolCallCard({ call, execution }: { call: ToolCall; execution?: ToolExecutionState }) {
  const { styles, cx, theme: token } = useStyles()
  const [open, setOpen] = useState(false)
  // 子代理调用走专属卡片(区别于普通工具)
  if (call.name === 'subagent') return <SubagentCard call={call} execution={execution} />

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

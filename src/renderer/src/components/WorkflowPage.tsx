import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Tag } from 'antd'
import { createStyles } from 'antd-style'
import { Bot, CheckCircle2, Code2, FileSearch, GitBranch, Play, ShieldCheck } from 'lucide-react'
import { api, type AgentStatusEvent, type PiRuntimeEvent, type Workspace } from '../lib/api'

type AgentIssue = Exclude<AgentStatusEvent, { status: 'started' }>

type WorkflowNode = {
  id: string
  title: string
  role: string
  icon: 'search' | 'branch' | 'code' | 'shield' | 'bot'
}

type WorkflowTemplate = {
  id: string
  name: string
  goal: string
  nodes: WorkflowNode[]
  prompt: (objective: string) => string
}

type RunEvent = {
  id: string
  time: string
  label: string
  detail?: string
  status: 'running' | 'done' | 'error'
}

const templates: WorkflowTemplate[] = [
  {
    id: 'scout-plan',
    name: '项目侦察计划',
    goal: '扫描项目结构，产出下一步开发计划。',
    nodes: [
      { id: 'scope', title: '输入目标', role: '收集约束', icon: 'bot' },
      { id: 'scout', title: '代码侦察', role: '读取结构', icon: 'search' },
      { id: 'plan', title: '方案设计', role: '拆分步骤', icon: 'branch' },
      { id: 'review', title: '计划复核', role: '风险检查', icon: 'shield' },
    ],
    prompt: (objective) =>
      [
        '运行工作流：项目侦察计划。',
        `目标：${objective}`,
        '',
        '按节点执行：',
        '1. 代码侦察：查看项目结构、关键文件和当前状态。',
        '2. 方案设计：给出下一步开发计划，拆成可执行步骤。',
        '3. 计划复核：指出风险、需要验证的检查项和建议优先级。',
        '',
        '不要修改文件，只输出结构化计划。',
      ].join('\n'),
  },
  {
    id: 'implement-review',
    name: '实现并复查',
    goal: '根据目标实现代码，并给出自检结果。',
    nodes: [
      { id: 'scope', title: '需求确认', role: '限定范围', icon: 'bot' },
      { id: 'worker', title: '代码实现', role: '修改文件', icon: 'code' },
      { id: 'checks', title: '本地检查', role: '运行验证', icon: 'shield' },
      { id: 'summary', title: '结果总结', role: '交付说明', icon: 'branch' },
    ],
    prompt: (objective) =>
      [
        '运行工作流：实现并复查。',
        `目标：${objective}`,
        '',
        '按节点执行：',
        '1. 需求确认：先读取相关文件，明确改动边界。',
        '2. 代码实现：按项目现有风格修改代码。',
        '3. 本地检查：运行最小必要验证。',
        '4. 结果总结：说明改动、验证结果和剩余风险。',
      ].join('\n'),
  },
  {
    id: 'release-check',
    name: '发布检查',
    goal: '检查发版资产、更新配置和安装验证。',
    nodes: [
      { id: 'status', title: '仓库状态', role: '确认干净', icon: 'search' },
      { id: 'build', title: '构建打包', role: '生成资产', icon: 'code' },
      { id: 'release', title: '发布校验', role: '核对 release', icon: 'branch' },
      { id: 'install', title: '安装验证', role: '确认版本', icon: 'shield' },
    ],
    prompt: (objective) =>
      [
        '运行工作流：发布检查。',
        `目标：${objective}`,
        '',
        '按节点执行：',
        '1. 仓库状态：确认当前分支、提交、tag 和未提交变更。',
        '2. 构建打包：检查 package 版本、dist 资产和 latest.yml。',
        '3. 发布校验：确认 release 资产完整并匹配版本。',
        '4. 安装验证：说明本机静默安装和版本验证步骤。',
        '',
        '涉及真实发布、推送或安装前必须明确列出将执行的命令。',
      ].join('\n'),
  },
]

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: 260px minmax(380px, 1fr) 320px;
    background: ${token.colorBgContainer};
  `,

  sidebar: css`
    border-right: 1px solid ${token.colorBorderSecondary};
    padding: 16px 12px;
    overflow: auto;
    background: ${token.colorBgLayout};
  `,

  main: css`
    min-width: 0;
    padding: 18px;
    overflow: auto;
  `,

  inspector: css`
    border-left: 1px solid ${token.colorBorderSecondary};
    padding: 16px;
    overflow: auto;
    background: ${token.colorBgLayout};
  `,

  sectionTitle: css`
    font-size: 12px;
    font-weight: 600;
    color: ${token.colorTextSecondary};
    margin: 0 0 10px;
  `,

  templateButton: css`
    width: 100%;
    text-align: left;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 8px;
    background: ${token.colorBgContainer};
    padding: 10px;
    margin-bottom: 8px;
    cursor: pointer;
    color: ${token.colorText};
    transition:
      border-color ${token.motionDurationFast},
      background ${token.motionDurationFast};

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      background: ${token.colorFillTertiary};
    }
  `,

  templateButtonActive: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
  `,

  templateName: css`
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
  `,

  templateGoal: css`
    display: block;
    font-size: 12px;
    color: ${token.colorTextSecondary};
    line-height: 1.45;
  `,

  header: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  `,

  title: css`
    margin: 0;
    font-size: 18px;
    line-height: 1.25;
    color: ${token.colorText};
  `,

  subtitle: css`
    margin-top: 6px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

  canvas: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(130px, 1fr));
    gap: 12px;
    align-items: stretch;
  `,

  node: css`
    min-height: 116px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 8px;
    background: ${token.colorBgLayout};
    padding: 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  `,

  nodeTop: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  `,

  nodeIcon: css`
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
    flex-shrink: 0;
  `,

  nodeIndex: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  nodeTitle: css`
    margin-top: 14px;
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  nodeRole: css`
    margin-top: 4px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

  formBlock: css`
    margin-top: 18px;
  `,

  runLog: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
  `,

  logItem: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 8px;
    background: ${token.colorBgContainer};
    padding: 9px 10px;
  `,

  logLine: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    color: ${token.colorText};
  `,

  logDetail: css`
    margin-top: 4px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}))

function iconOf(icon: WorkflowNode['icon']) {
  if (icon === 'search') return <FileSearch size={16} />
  if (icon === 'branch') return <GitBranch size={16} />
  if (icon === 'code') return <Code2 size={16} />
  if (icon === 'shield') return <ShieldCheck size={16} />
  return <Bot size={16} />
}

function eventLabel(event: PiRuntimeEvent): string {
  if (event.type === 'agent_start') return 'Agent 开始'
  if (event.type === 'agent_end') return 'Agent 结束'
  if (event.type === 'message_start') return '开始输出'
  if (event.type === 'message_update') return '输出更新'
  if (event.type === 'tool_execution_start') return `工具开始：${event.toolName}`
  if (event.type === 'tool_execution_update') return '工具更新'
  if (event.type === 'tool_execution_end') return '工具结束'
  if (event.type === 'extension_ui_request') return '需要确认'
  return event.type
}

function eventDetail(event: PiRuntimeEvent): string | undefined {
  if (event.type === 'tool_execution_start') return JSON.stringify(event.args ?? {})
  if (event.type === 'tool_execution_end') return event.error ?? event.result
  if (event.type === 'extension_ui_request') return event.title ?? event.message
  return undefined
}

export default function WorkflowPage({
  workspace,
  starting,
  agentIssue,
  onOpenWorkspace,
}: {
  workspace: Workspace | null
  starting?: boolean
  agentIssue?: AgentIssue | null
  onOpenWorkspace: () => void
}) {
  const { styles, cx } = useStyles()
  const [selectedId, setSelectedId] = useState(templates[0].id)
  const [objective, setObjective] = useState('查看当前项目，给出下一步最值得开发的功能和验证步骤。')
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<RunEvent[]>([])
  const runningRef = useRef(false)

  const selected = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? templates[0],
    [selectedId],
  )

  useEffect(() => {
    const offEvent = api.pi.onEvent((event) => {
      if (!runningRef.current) return
      const status = event.type === 'agent_end' ? 'done' : 'running'
      setEvents((prev) =>
        [
          {
            id: `${Date.now()}:${event.type}:${prev.length}`,
            time: new Date().toLocaleTimeString(),
            label: eventLabel(event),
            detail: eventDetail(event),
            status,
          },
          ...prev,
        ].slice(0, 40),
      )
      if (event.type === 'agent_end') {
        runningRef.current = false
        setRunning(false)
      }
    })
    const offStatus = api.pi.onStatus((event) => {
      if (!runningRef.current) return
      if (event.status === 'error' || (event.status === 'exited' && !event.expected)) {
        runningRef.current = false
        setRunning(false)
        setEvents((prev) => [
          {
            id: `${Date.now()}:agent-status`,
            time: new Date().toLocaleTimeString(),
            label: '运行异常',
            detail: event.status === 'error' ? event.message : event.message,
            status: 'error',
          },
          ...prev,
        ])
      }
    })
    return () => {
      offEvent()
      offStatus()
    }
  }, [])

  async function runWorkflow() {
    if (!workspace || starting || agentIssue || running) return
    runningRef.current = true
    setRunning(true)
    setEvents([
      {
        id: `${Date.now()}:queued`,
        time: new Date().toLocaleTimeString(),
        label: '工作流已启动',
        detail: selected.name,
        status: 'running',
      },
    ])
    try {
      await api.pi.prompt(selected.prompt(objective.trim() || selected.goal))
    } catch (err) {
      runningRef.current = false
      setRunning(false)
      setEvents((prev) => [
        {
          id: `${Date.now()}:error`,
          time: new Date().toLocaleTimeString(),
          label: '启动失败',
          detail: err instanceof Error ? err.message : String(err),
          status: 'error',
        },
        ...prev,
      ])
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.sectionTitle}>工作流</div>
        {templates.map((template) => (
          <button
            key={template.id}
            className={cx(
              styles.templateButton,
              template.id === selected.id && styles.templateButtonActive,
            )}
            onClick={() => setSelectedId(template.id)}
          >
            <span className={styles.templateName}>{template.name}</span>
            <span className={styles.templateGoal}>{template.goal}</span>
          </button>
        ))}
      </aside>

      <main className={styles.main}>
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>{selected.name}</h2>
            <div className={styles.subtitle}>{workspace?.path ?? '未打开工作区'}</div>
          </div>
          <Tag color={running ? 'processing' : 'default'}>{running ? '运行中' : '就绪'}</Tag>
        </div>

        <div className={styles.canvas}>
          {selected.nodes.map((node, index) => (
            <div className={styles.node} key={node.id}>
              <div>
                <div className={styles.nodeTop}>
                  <span className={styles.nodeIcon}>{iconOf(node.icon)}</span>
                  <span className={styles.nodeIndex}>0{index + 1}</span>
                </div>
                <div className={styles.nodeTitle}>{node.title}</div>
                <div className={styles.nodeRole}>{node.role}</div>
              </div>
              {index < selected.nodes.length - 1 && <span className={styles.nodeRole}>next</span>}
            </div>
          ))}
        </div>

        <div className={styles.formBlock}>
          <div className={styles.sectionTitle}>目标</div>
          <Input.TextArea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            autoSize={{ minRows: 4, maxRows: 8 }}
          />
        </div>
      </main>

      <aside className={styles.inspector}>
        <div className={styles.sectionTitle}>运行</div>
        {!workspace && (
          <Alert
            type="warning"
            showIcon
            message="需要先打开工作区"
            action={
              <Button size="small" onClick={onOpenWorkspace}>
                打开
              </Button>
            }
          />
        )}
        {agentIssue && <Alert type="error" showIcon message="Agent 不可用" description={agentIssue.message} />}
        <div className={styles.formBlock}>
          <Button
            type="primary"
            icon={running ? <CheckCircle2 size={14} /> : <Play size={14} />}
            block
            loading={running}
            disabled={!workspace || starting || !!agentIssue}
            onClick={runWorkflow}
          >
            运行工作流
          </Button>
        </div>

        <div className={styles.formBlock}>
          <div className={styles.sectionTitle}>事件</div>
          <div className={styles.runLog}>
            {events.length === 0 ? (
              <div className={styles.logItem}>
                <div className={styles.logLine}>
                  <span>等待运行</span>
                </div>
              </div>
            ) : (
              events.map((event) => (
                <div className={styles.logItem} key={event.id}>
                  <div className={styles.logLine}>
                    <span>{event.label}</span>
                    <Tag color={event.status === 'error' ? 'error' : event.status === 'done' ? 'success' : 'processing'}>
                      {event.time}
                    </Tag>
                  </div>
                  {event.detail && <div className={styles.logDetail}>{event.detail}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

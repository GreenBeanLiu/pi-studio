import { useEffect, useState } from 'react'
import { createStyles, cx } from 'antd-style'
import {
  Button,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Select,
  Switch,
  Tag,
  TimePicker,
  App as AntApp,
} from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'

dayjs.extend(customParseFormat)
import {
  CalendarClock,
  Play,
  Pencil,
  Trash2,
  Plus,
  CheckCircle2,
  XCircle,
  Clock3,
  ArrowDown,
  ArrowUp,
  GitBranch,
  Bell,
  Bot,
  Image as ImageIcon,
  Circle,
  MinusCircle,
  Loader2,
} from 'lucide-react'
import {
  api,
  type Channel,
  type Routine,
  type RoutineNotify,
  type RoutineRun,
  type RoutineStep,
  type RoutineStepType,
  type RoutineStepProgress,
  type RoutineSchedule,
  type Workspace,
} from '../lib/api'

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function scheduleLabel(s: RoutineSchedule): string {
  switch (s.type) {
    case 'interval':
      return `每 ${s.minutes} 分钟`
    case 'hourly':
      return `每小时 ${s.minute} 分`
    case 'daily':
      return `每天 ${s.time}`
    case 'weekly':
      return `${DAYS[s.day] ?? '?'} ${s.time}`
  }
}

const NOTIFY_LABEL: Record<RoutineNotify, string> = {
  error: '仅失败时通知',
  always: '每次都通知',
  never: '从不通知',
}

const STEP_TYPE_META: Record<RoutineStepType, { label: string; icon: typeof Bot }> = {
  agent: { label: '智能体', icon: Bot },
  imagegen: { label: '生图', icon: ImageIcon },
  notify: { label: '通知', icon: Bell },
}

type FormState = {
  id?: string
  name: string
  steps: RoutineStep[]
  workspacePath: string
  scheduleType: RoutineSchedule['type']
  minutes: number
  minute: number
  time: string
  day: number
  notify: RoutineNotify
  notifyChannelId?: string
}

const createStep = (type: RoutineStepType = 'agent'): RoutineStep => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: '',
  type,
  ...(type === 'imagegen' ? { engine: 'openai' as const } : {}),
})
const emptyForm = (workspacePath: string): FormState => ({
  name: '',
  steps: [createStep()],
  workspacePath,
  scheduleType: 'daily',
  minutes: 60,
  minute: 0,
  time: '09:00',
  day: 1,
  notify: 'error',
})

/** 步骤在流程图里的显示状态:实时进度 > 最近一次运行结果 > 待机 */
type StepDisplayStatus = 'idle' | 'running' | 'ok' | 'error' | 'timeout' | 'skipped'

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
  `,
  col: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: 16px;
    overflow-y: auto;
  `,
  left: css`
    width: 460px;
    flex-shrink: 0;
  `,
  right: css`
    flex: 1;
    min-width: 0;
  `,
  colTitle: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
    color: ${token.colorText};
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.6;
  `,
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  cardClickable: css`
    cursor: pointer;
    transition: border-color 0.2s;

    &:hover {
      border-color: ${token.colorPrimaryBorderHover};
    }
  `,
  cardSelected: css`
    border-color: ${token.colorPrimary};
  `,
  cardHead: css`
    display: flex;
    align-items: center;
    gap: 8px;

    .name {
      flex: 1;
      font-weight: 600;
      color: ${token.colorText};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  cardMeta: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    flex-wrap: wrap;
  `,
  formRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,

  /* ── 流程图 ── */
  flow: css`
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  `,
  node: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  nodeRunning: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 3px ${token.colorPrimaryBg};
  `,
  nodeOk: css`
    border-color: ${token.colorSuccessBorder};
  `,
  nodeError: css`
    border-color: ${token.colorErrorBorder};
  `,
  nodeTimeout: css`
    border-color: ${token.colorWarningBorder};
  `,
  nodeSkipped: css`
    border-style: dashed;
    opacity: 0.65;
  `,
  nodeHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: ${token.colorText};
    font-size: 13px;

    .sname {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dur {
      font-weight: 400;
      font-size: 12px;
      color: ${token.colorTextTertiary};
    }
  `,
  nodeSub: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  nodePrompt: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,
  nodeSummary: css`
    font-size: 12.5px;
    line-height: 1.7;
    color: ${token.colorTextSecondary};
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 8px 10px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 150px;
    overflow-y: auto;
  `,
  nodeImage: css`
    max-width: 260px;
    max-height: 200px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    object-fit: cover;
  `,
  nodeErrText: css`
    font-size: 12.5px;
    color: ${token.colorError};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  connector: css`
    align-self: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    color: ${token.colorTextQuaternary};
    padding: 2px 0;

    .line {
      width: 2px;
      height: 12px;
      background: ${token.colorBorder};
    }
    svg {
      margin-top: -3px;
    }
  `,
  spin: css`
    animation: routine-spin 1s linear infinite;

    @keyframes routine-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `,
  lastRun: css`
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: ${token.colorTextTertiary};
    flex-wrap: wrap;
  `,
}))

export default function RoutinesPage({ workspace }: { workspace: Workspace | null }) {
  return (
    <AntApp component={false}>
      <RoutinesInner workspace={workspace} />
    </AntApp>
  )
}

function RoutinesInner({ workspace }: { workspace: Workspace | null }) {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [routineState, setRoutineState] = useState<{
    runningIds: string[]
    queuedIds: string[]
  }>({ runningIds: [], queuedIds: [] })
  const [channels, setChannels] = useState<Channel[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stepProgress, setStepProgress] = useState<
    Record<string, Record<string, RoutineStepProgress['status']>>
  >({})

  async function refresh() {
    const data = await api.routines.list()
    setRoutines(data.routines)
    setRuns(data.runs)
    setRoutineState(await api.routines.state())
  }

  useEffect(() => {
    refresh()
    api.channels.list().then(setChannels).catch(() => {})
    const offRun = api.routines.onRunFinished((run) => {
      setRuns((prev) => [run, ...prev].slice(0, 100))
      setRoutineState((prev) => ({
        runningIds: prev.runningIds.filter((id) => id !== run.routineId),
        queuedIds: prev.queuedIds.filter((id) => id !== run.routineId),
      }))
      // 跑完后用 run 里的每步结果显示,清掉实时进度
      setStepProgress((prev) => {
        const next = { ...prev }
        delete next[run.routineId]
        return next
      })
    })
    const offStep = api.routines.onStepProgress((p) => {
      setRoutineState((prev) => ({
        runningIds: prev.runningIds.includes(p.routineId)
          ? prev.runningIds
          : [...prev.runningIds, p.routineId],
        queuedIds: prev.queuedIds.filter((id) => id !== p.routineId),
      }))
      setStepProgress((prev) => ({
        ...prev,
        [p.routineId]: { ...prev[p.routineId], [p.stepId]: p.status },
      }))
    })
    return () => {
      offRun()
      offStep()
    }
  }, [])

  function buildSchedule(f: FormState): RoutineSchedule {
    switch (f.scheduleType) {
      case 'interval':
        return { type: 'interval', minutes: Math.max(5, f.minutes) }
      case 'hourly':
        return { type: 'hourly', minute: Math.min(59, Math.max(0, f.minute)) }
      case 'daily':
        return { type: 'daily', time: f.time }
      case 'weekly':
        return { type: 'weekly', day: f.day, time: f.time }
    }
  }

  const stepComplete = (s: RoutineStep): boolean =>
    !!s.name.trim() && (s.type === 'notify' ? !!s.channelId : !!s.prompt?.trim())

  async function saveForm() {
    if (!form) return
    const steps = form.steps.filter(stepComplete)
    if (!form.name.trim() || !form.workspacePath.trim() || steps.length === 0) {
      message.warning('需要名称、工作区,以及至少一个完整的步骤(通知步骤要选渠道,其余要填提示词)')
      return
    }
    const next = await api.routines.save({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      steps,
      workspacePath: form.workspacePath.trim(),
      schedule: buildSchedule(form),
      notify: form.notify,
      ...(form.notifyChannelId ? { notifyChannelId: form.notifyChannelId } : {}),
    })
    setRoutines(next)
    setForm(null)
    message.success('Saved')
  }

  function updateStep(id: string, patch: Partial<RoutineStep>) {
    if (!form) return
    setForm({
      ...form,
      steps: form.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    })
  }

  function changeStepType(id: string, type: RoutineStepType) {
    if (!form) return
    setForm({
      ...form,
      steps: form.steps.map((step) => {
        if (step.id !== id) return step
        return {
          id: step.id,
          name: step.name,
          type,
          ...(type !== 'notify' ? { prompt: step.prompt ?? '' } : {}),
          ...(type === 'imagegen' ? { engine: step.engine ?? ('openai' as const) } : {}),
          ...(type === 'notify' ? { channelId: step.channelId ?? channels[0]?.id, message: step.message ?? '' } : {}),
        }
      }),
    })
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!form) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= form.steps.length) return
    const steps = [...form.steps]
    ;[steps[index], steps[nextIndex]] = [steps[nextIndex], steps[index]]
    setForm({ ...form, steps })
  }

  function deleteStep(id: string) {
    if (!form) return
    setForm({ ...form, steps: form.steps.filter((step) => step.id !== id) })
  }

  function editRoutine(r: Routine) {
    setForm({
      id: r.id,
      name: r.name,
      steps: r.steps?.length ? r.steps.map((s) => ({ ...s })) : [createStep()],
      workspacePath: r.workspacePath,
      scheduleType: r.schedule.type,
      minutes: r.schedule.type === 'interval' ? r.schedule.minutes : 60,
      minute: r.schedule.type === 'hourly' ? r.schedule.minute : 0,
      time: 'time' in r.schedule ? r.schedule.time : '09:00',
      day: r.schedule.type === 'weekly' ? r.schedule.day : 1,
      notify: r.notify,
      notifyChannelId: r.notifyChannelId,
    })
  }

  async function runNow(r: Routine) {
    const res = await api.routines.runNow(r.id)
    if ('error' in res) {
      message.error(res.error)
      return
    }
    setSelectedId(r.id)
    setRoutineState((prev) => ({
      ...prev,
      runningIds: prev.runningIds.includes(r.id) ? prev.runningIds : [...prev.runningIds, r.id],
    }))
    message.info(`「${r.name}」开始执行,右侧流程图会实时显示进度`)
  }

  const statusIcon = (s: RoutineRun['status']) =>
    s === 'ok' ? (
      <CheckCircle2 size={14} color="#4ade80" />
    ) : s === 'timeout' ? (
      <Clock3 size={14} color="#fbbf24" />
    ) : (
      <XCircle size={14} color="#f87171" />
    )

  const selected = routines.find((r) => r.id === selectedId) ?? routines[0] ?? null
  const latestRun = selected ? runs.find((run) => run.routineId === selected.id) : undefined
  const liveProgress = selected ? stepProgress[selected.id] : undefined
  const activeIds = [...routineState.runningIds, ...routineState.queuedIds]
  const selectedRunning = selected ? routineState.runningIds.includes(selected.id) : false
  const selectedQueued = selected ? routineState.queuedIds.includes(selected.id) : false
  const selectedActive = selectedRunning || selectedQueued

  function stepDisplay(step: RoutineStep): {
    status: StepDisplayStatus
    summary?: string
    imageUrl?: string
    durationMs?: number
  } {
    const live = liveProgress?.[step.id]
    if (live) return { status: live }
    // 正在执行但还没轮到的步骤不显示上一次的旧结果
    if (selectedActive) return { status: 'idle' }
    const past = latestRun?.steps?.find((s) => s.id === step.id)
    if (past) {
      return { status: past.status, summary: past.summary, imageUrl: past.imageUrl, durationMs: past.durationMs }
    }
    return { status: 'idle' }
  }

  const stepIcon = (status: StepDisplayStatus) => {
    switch (status) {
      case 'running':
        return <Loader2 size={14} className={styles.spin} color="#60a5fa" />
      case 'ok':
        return <CheckCircle2 size={14} color="#4ade80" />
      case 'error':
        return <XCircle size={14} color="#f87171" />
      case 'timeout':
        return <Clock3 size={14} color="#fbbf24" />
      case 'skipped':
        return <MinusCircle size={14} color="#9ca3af" />
      default:
        return <Circle size={14} color="#9ca3af" />
    }
  }

  const nodeClass = (status: StepDisplayStatus) =>
    cx(
      styles.node,
      status === 'running' && styles.nodeRunning,
      status === 'ok' && styles.nodeOk,
      status === 'error' && styles.nodeError,
      status === 'timeout' && styles.nodeTimeout,
      status === 'skipped' && styles.nodeSkipped,
    )

  const connector = (key: string) => (
    <div key={key} className={styles.connector}>
      <div className="line" />
      <ArrowDown size={12} />
    </div>
  )

  const channelName = (id?: string): string => channels.find((c) => c.id === id)?.name ?? '(渠道已删除)'

  const stepTypeOptions = (Object.keys(STEP_TYPE_META) as RoutineStepType[]).map((t) => ({
    value: t,
    label: STEP_TYPE_META[t].label,
  }))

  return (
    <div className={styles.page}>
      <section className={`${styles.col} ${styles.left}`}>
        <div className={styles.colTitle}>
          <CalendarClock size={16} />
          Workflows ({routines.length})
          <div style={{ flex: 1 }} />
          <Button
            size="small"
            type="primary"
            icon={<Plus size={13} />}
            onClick={() => setForm(emptyForm(workspace?.path ?? ''))}
          >
            新建
          </Button>
        </div>

        {form && (
          <Drawer
            title={form.id ? '编辑工作流' : '新建工作流'}
            open
            placement="right"
            width={560}
            destroyOnClose
            onClose={() => setForm(null)}
          >
          <div className={styles.card}>
            <span className={styles.label}>Name</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Workflow name"
            />
            <span className={styles.label}>{`步骤 (${form.steps.length})`}</span>
            <span className={styles.hint}>
              {'节点间传值:{{prev.output}} 上一步输出、{{steps.步骤名.output}} 任意步骤输出、{{steps.步骤名.imageUrl}} 生图链接。智能体节点不写变量时自动接收上一步输出。'}
            </span>
            {form.steps.map((step, index) => (
              <div key={step.id} className={styles.card} style={{ padding: 10 }}>
                <div className={styles.formRow}>
                  <Select
                    value={step.type}
                    onChange={(v) => changeStepType(step.id, v)}
                    style={{ width: 96, flexShrink: 0 }}
                    options={stepTypeOptions}
                  />
                  <Input
                    value={step.name}
                    onChange={(e) => updateStep(step.id, { name: e.target.value })}
                    placeholder="Step name"
                  />
                  <Button size="small" type="text" icon={<ArrowUp size={13} />} disabled={index === 0} onClick={() => moveStep(index, -1)} />
                  <Button size="small" type="text" icon={<ArrowDown size={13} />} disabled={index === form.steps.length - 1} onClick={() => moveStep(index, 1)} />
                  <Button size="small" type="text" danger icon={<Trash2 size={13} />} disabled={form.steps.length === 1} onClick={() => deleteStep(step.id)} />
                </div>
                {step.type !== 'notify' && (
                  <Input.TextArea
                    value={step.prompt ?? ''}
                    onChange={(e) => updateStep(step.id, { prompt: e.target.value })}
                    placeholder={step.type === 'imagegen' ? '画什么(支持 {{prev.output}} 等变量)' : 'Instruction for this node'}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                  />
                )}
                {step.type === 'imagegen' && (
                  <div className={styles.formRow}>
                    <span className={styles.hint}>引擎</span>
                    <Select
                      value={step.engine ?? 'openai'}
                      onChange={(v) => updateStep(step.id, { engine: v })}
                      style={{ width: 200 }}
                      options={[
                        { value: 'openai', label: '云端 gpt-image-2' },
                        { value: 'comfy', label: '本地 ComfyUI' },
                      ]}
                    />
                  </div>
                )}
                {step.type === 'notify' && (
                  <>
                    <div className={styles.formRow}>
                      <span className={styles.hint}>渠道</span>
                      <Select
                        value={step.channelId}
                        onChange={(v) => updateStep(step.id, { channelId: v })}
                        style={{ flex: 1 }}
                        placeholder={channels.length ? '选择通知渠道' : '先去 设置→通知渠道 添加'}
                        options={channels.map((c) => ({ value: c.id, label: c.name }))}
                      />
                    </div>
                    <Input.TextArea
                      value={step.message ?? ''}
                      onChange={(e) => updateStep(step.id, { message: e.target.value })}
                      placeholder={'发什么(支持 {{prev.output}} 等变量,留空 = 上一步输出)'}
                      autoSize={{ minRows: 2, maxRows: 6 }}
                    />
                  </>
                )}
              </div>
            ))}
            <Button size="small" type="dashed" icon={<Plus size={13} />} onClick={() => setForm({ ...form, steps: [...form.steps, createStep()] })}>
              Add step
            </Button>
            <span className={styles.label}>工作区(agent 的运行目录)</span>
            <div className={styles.formRow}>
              <Input
                value={form.workspacePath}
                onChange={(e) => setForm({ ...form, workspacePath: e.target.value })}
                placeholder="D:\\Works"
              />
              {workspace && (
                <Button size="small" onClick={() => setForm({ ...form, workspacePath: workspace.path })}>
                  用当前
                </Button>
              )}
            </div>
            <span className={styles.label}>频率</span>
            <div className={styles.formRow}>
              <Select
                value={form.scheduleType}
                onChange={(v) => setForm({ ...form, scheduleType: v })}
                style={{ width: 110 }}
                options={[
                  { value: 'daily', label: '每天' },
                  { value: 'weekly', label: '每周' },
                  { value: 'hourly', label: '每小时' },
                  { value: 'interval', label: '按间隔' },
                ]}
              />
              {form.scheduleType === 'weekly' && (
                <Select
                  value={form.day}
                  onChange={(v) => setForm({ ...form, day: v })}
                  style={{ width: 90 }}
                  options={DAYS.map((d, i) => ({ value: i, label: d }))}
                />
              )}
              {(form.scheduleType === 'daily' || form.scheduleType === 'weekly') && (
                <TimePicker
                  value={dayjs(form.time, 'HH:mm')}
                  format="HH:mm"
                  onChange={(v) => v && setForm({ ...form, time: v.format('HH:mm') })}
                  allowClear={false}
                />
              )}
              {form.scheduleType === 'hourly' && (
                <Input
                  type="number"
                  style={{ width: 90 }}
                  value={form.minute}
                  onChange={(e) => setForm({ ...form, minute: Number(e.target.value) || 0 })}
                  suffix="分"
                />
              )}
              {form.scheduleType === 'interval' && (
                <Input
                  type="number"
                  style={{ width: 110 }}
                  value={form.minutes}
                  onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) || 60 })}
                  suffix="分钟"
                />
              )}
            </div>
            <span className={styles.label}>兜底通知(跑完汇总一张卡片,与流程里的通知节点独立)</span>
            <div className={styles.formRow}>
              <Select
                value={form.notify}
                onChange={(v) => setForm({ ...form, notify: v })}
                style={{ width: 140 }}
                options={[
                  { value: 'error', label: '仅失败时通知' },
                  { value: 'always', label: '每次都通知' },
                  { value: 'never', label: '从不通知' },
                ]}
              />
              {form.notify !== 'never' && (
                <Select
                  value={form.notifyChannelId}
                  onChange={(v) => setForm({ ...form, notifyChannelId: v })}
                  style={{ flex: 1 }}
                  allowClear
                  placeholder="默认第一个渠道"
                  options={channels.map((c) => ({ value: c.id, label: c.name }))}
                />
              )}
            </div>
            <div className={styles.formRow} style={{ justifyContent: 'flex-end' }}>
              <Button size="small" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button size="small" type="primary" onClick={saveForm}>
                保存
              </Button>
            </div>
          </div>
          </Drawer>
        )}

        {routines.length === 0 && !form && (
          <Empty description="No workflows yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        {routines.map((r) => (
          <div
            key={r.id}
            className={cx(styles.card, styles.cardClickable, selected?.id === r.id && styles.cardSelected)}
            onClick={() => setSelectedId(r.id)}
          >
            <div className={styles.cardHead}>
              <span className="name" title={r.steps.map((step) => step.name).join(', ')}>
                {r.name}
              </span>
              {routineState.runningIds.includes(r.id) && <Tag color="processing">执行中</Tag>}
              {routineState.queuedIds.includes(r.id) && <Tag color="warning">排队中</Tag>}
              <Switch
                size="small"
                checked={r.enabled}
                onChange={async (v) => {
                  setRoutines(await api.routines.toggle(r.id, v))
                  if (!v) {
                    setRoutineState((prev) => ({
                      ...prev,
                      queuedIds: prev.queuedIds.filter((id) => id !== r.id),
                    }))
                  }
                }}
              />
            </div>
            <div className={styles.cardMeta}>
              <Tag>{scheduleLabel(r.schedule)}</Tag>
              <span>{r.workspacePath}</span>
              {r.lastRunAt && <span>上次: {new Date(r.lastRunAt).toLocaleString()}</span>}
              <div style={{ flex: 1 }} />
              <Button
                size="small"
                type="text"
                icon={<Play size={13} />}
                title="立即执行"
                disabled={activeIds.includes(r.id)}
                onClick={() => runNow(r)}
              />
              <Button
                size="small"
                type="text"
                icon={<Pencil size={13} />}
                title="编辑"
                onClick={() => editRoutine(r)}
              />
              <Popconfirm title="删除这个例行任务?" onConfirm={async () => setRoutines(await api.routines.delete(r.id))}>
                <Button size="small" type="text" danger icon={<Trash2 size={13} />} title="删除" />
              </Popconfirm>
            </div>
          </div>
        ))}
      </section>

      <section className={`${styles.col} ${styles.right}`}>
        <div className={styles.colTitle}>
          <GitBranch size={16} />
          流程图{selected ? ` · ${selected.name}` : ''}
          {selectedRunning && <Tag color="processing">执行中</Tag>}
          {selectedQueued && <Tag color="warning">排队中</Tag>}
        </div>

        {!selected && (
          <Empty description="左侧创建一个例行任务,流程会显示在这里" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        {selected && (
          <div className={styles.flow}>
            <div className={styles.node}>
              <div className={styles.nodeHead}>
                <CalendarClock size={14} />
                <span className="sname">触发</span>
                <Tag>{scheduleLabel(selected.schedule)}</Tag>
              </div>
              <div className={styles.nodeSub}>{selected.workspacePath}</div>
            </div>
            {connector('c-start')}

            {selected.steps.map((step, index) => {
              const display = stepDisplay(step)
              const TypeIcon = STEP_TYPE_META[step.type]?.icon ?? Bot
              return (
                <div key={step.id} style={{ display: 'contents' }}>
                  <div className={nodeClass(display.status)}>
                    <div className={styles.nodeHead}>
                      {stepIcon(display.status)}
                      <TypeIcon size={13} />
                      <span className="sname">
                        {index + 1}. {step.name}
                      </span>
                      <Tag>{STEP_TYPE_META[step.type]?.label ?? step.type}</Tag>
                      {display.durationMs ? (
                        <span className="dur">{Math.max(1, Math.round(display.durationMs / 1000))}s</span>
                      ) : null}
                    </div>
                    {step.type === 'notify' ? (
                      <div className={styles.nodeSub}>
                        → {channelName(step.channelId)}
                        {step.message?.trim() ? ` · ${step.message.slice(0, 60)}` : ' · (上一步输出)'}
                      </div>
                    ) : (
                      <div className={styles.nodePrompt} title={step.prompt}>
                        {step.prompt}
                      </div>
                    )}
                    {display.imageUrl && display.status === 'ok' && (
                      <img className={styles.nodeImage} src={display.imageUrl} alt={step.name} />
                    )}
                    {display.summary && display.status === 'ok' && !display.imageUrl && (
                      <div className={styles.nodeSummary}>{display.summary}</div>
                    )}
                    {display.summary && (display.status === 'error' || display.status === 'timeout') && (
                      <div className={styles.nodeErrText}>{display.summary}</div>
                    )}
                  </div>
                  {connector(`c-${step.id}`)}
                </div>
              )
            })}

            <div className={styles.node}>
              <div className={styles.nodeHead}>
                <Bell size={14} />
                <span className="sname">兜底通知</span>
                <Tag>{NOTIFY_LABEL[selected.notify]}</Tag>
                {selected.notify !== 'never' && (
                  <Tag color={channels.length ? 'green' : 'default'}>
                    {channels.length
                      ? (channels.find((c) => c.id === selected.notifyChannelId) ?? channels.find((c) => c.type !== 'local'))?.name ?? '系统通知'
                      : '无渠道'}
                  </Tag>
                )}
              </div>
              {selected.notify !== 'never' && channels.length === 0 && (
                <div className={styles.nodeSub}>在 设置 → 通知渠道 里添加飞书/Webhook 渠道</div>
              )}
            </div>

            {latestRun && (
              <div className={styles.lastRun}>
                {statusIcon(latestRun.status)}
                <span>最近一次: {new Date(latestRun.startedAt).toLocaleString()}</span>
                <span>耗时 {Math.max(1, Math.round((latestRun.endedAt - latestRun.startedAt) / 1000))}s</span>
                {latestRun.error && <Tag color="error">{latestRun.error.slice(0, 80)}</Tag>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

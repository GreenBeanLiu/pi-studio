import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import {
  Button,
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
import { CalendarClock, Play, Pencil, Trash2, Plus, CheckCircle2, XCircle, Clock3, ArrowDown, ArrowUp } from 'lucide-react'
import {
  api,
  type Routine,
  type RoutineNotify,
  type RoutineRun,
  type RoutineStep,
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
}

const createStep = (name = '', prompt = ''): RoutineStep => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name,
  prompt,
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
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  runItem: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  runHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: ${token.colorTextSecondary};

    .rname {
      font-weight: 600;
      color: ${token.colorText};
    }
    .spacer {
      flex: 1;
    }
  `,
  runSummary: css`
    font-size: 13px;
    line-height: 1.7;
    color: ${token.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  `,
  formRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
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
  const [runningIds, setRunningIds] = useState<string[]>([])
  const [form, setForm] = useState<FormState | null>(null)

  async function refresh() {
    const data = await api.routines.list()
    setRoutines(data.routines)
    setRuns(data.runs)
    setRunningIds(await api.routines.running())
  }

  useEffect(() => {
    refresh()
    const off = api.routines.onRunFinished((run) => {
      setRuns((prev) => [run, ...prev].slice(0, 100))
      setRunningIds((prev) => prev.filter((id) => id !== run.routineId))
    })
    return off
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

  async function saveForm() {
    if (!form) return
    const steps = form.steps.filter((step) => step.name.trim() && step.prompt.trim())
    if (!form.name.trim() || !form.workspacePath.trim() || steps.length === 0) {
      message.warning('Please provide a name, workspace, and at least one complete step')
      return
    }
    const next = await api.routines.save({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      steps,
      workspacePath: form.workspacePath.trim(),
      schedule: buildSchedule(form),
      notify: form.notify,
    })
    setRoutines(next)
    setForm(null)
    message.success('Saved')
  }

  function updateStep(id: string, patch: Partial<Pick<RoutineStep, 'name' | 'prompt'>>) {
    if (!form) return
    setForm({ ...form, steps: form.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) })
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
      steps: r.steps?.length ? r.steps : [createStep('Step 1', r.prompt ?? '')],
      workspacePath: r.workspacePath,
      scheduleType: r.schedule.type,
      minutes: r.schedule.type === 'interval' ? r.schedule.minutes : 60,
      minute: r.schedule.type === 'hourly' ? r.schedule.minute : 0,
      time: 'time' in r.schedule ? r.schedule.time : '09:00',
      day: r.schedule.type === 'weekly' ? r.schedule.day : 1,
      notify: r.notify,
    })
  }

  async function runNow(r: Routine) {
    const res = await api.routines.runNow(r.id)
    if ('error' in res) {
      message.error(res.error)
      return
    }
    setRunningIds((prev) => [...prev, r.id])
    message.info(`「${r.name}」开始执行,结果会出现在右侧收件箱`)
  }

  const statusIcon = (s: RoutineRun['status']) =>
    s === 'ok' ? (
      <CheckCircle2 size={14} color="#4ade80" />
    ) : s === 'timeout' ? (
      <Clock3 size={14} color="#fbbf24" />
    ) : (
      <XCircle size={14} color="#f87171" />
    )

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
          <div className={styles.card}>
            <span className={styles.label}>Name</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Workflow name"
            />
            <span className={styles.label}>{`\u6b65\u9aa4 (${form.steps.length})`}</span>
            {form.steps.map((step, index) => (
              <div key={step.id} className={styles.card} style={{ padding: 10 }}>
                <div className={styles.formRow}>
                  <Input
                    value={step.name}
                    onChange={(e) => updateStep(step.id, { name: e.target.value })}
                    placeholder="Step name"
                  />
                  <Button size="small" type="text" icon={<ArrowUp size={13} />} disabled={index === 0} onClick={() => moveStep(index, -1)} />
                  <Button size="small" type="text" icon={<ArrowDown size={13} />} disabled={index === form.steps.length - 1} onClick={() => moveStep(index, 1)} />
                  <Button size="small" type="text" danger icon={<Trash2 size={13} />} disabled={form.steps.length === 1} onClick={() => deleteStep(step.id)} />
                </div>
                <Input.TextArea
                  value={step.prompt}
                  onChange={(e) => updateStep(step.id, { prompt: e.target.value })}
                  placeholder="Instruction for this node"
                  autoSize={{ minRows: 3, maxRows: 8 }}
                />
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
            <span className={styles.label}>通知</span>
            <Select
              value={form.notify}
              onChange={(v) => setForm({ ...form, notify: v })}
              style={{ width: 160 }}
              options={[
                { value: 'error', label: '仅失败时通知' },
                { value: 'always', label: '每次都通知' },
                { value: 'never', label: '从不通知' },
              ]}
            />
            <div className={styles.formRow} style={{ justifyContent: 'flex-end' }}>
              <Button size="small" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button size="small" type="primary" onClick={saveForm}>
                保存
              </Button>
            </div>
          </div>
        )}

        {routines.length === 0 && !form && (
          <Empty description="No workflows yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}

        {routines.map((r) => (
          <div key={r.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className="name" title={r.steps.map((step) => step.name).join(', ')}>
                {r.name}
              </span>
              {runningIds.includes(r.id) && <Tag color="processing">执行中</Tag>}
              <Switch
                size="small"
                checked={r.enabled}
                onChange={async (v) => setRoutines(await api.routines.toggle(r.id, v))}
              />
            </div>
            <div className={styles.cardMeta}>
              <Tag>{scheduleLabel(r.schedule)}</Tag>`n              <Tag color="blue">{r.steps.length} steps</Tag>
              <span>{r.workspacePath}</span>
              {r.lastRunAt && <span>上次: {new Date(r.lastRunAt).toLocaleString()}</span>}
              <div style={{ flex: 1 }} />
              <Button
                size="small"
                type="text"
                icon={<Play size={13} />}
                title="立即执行"
                disabled={runningIds.includes(r.id)}
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
        <div className={styles.colTitle}>收件箱({runs.length})</div>
        {runs.length === 0 && (
          <Empty description="任务执行结果会出现在这里" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {runs.map((run) => (
          <div key={run.id} className={styles.runItem}>
            <div className={styles.runHead}>
              {statusIcon(run.status)}
              <span className="rname">{run.routineName}</span>
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>耗时 {Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s</span>
              <div className="spacer" />
              {run.status !== 'ok' && <Tag color="error">{run.error?.slice(0, 60) ?? run.status}</Tag>}
            </div>
            <div className={styles.runSummary}>{run.summary || run.error || ''}</div>
          </div>
        ))}
      </section>
    </div>
  )
}

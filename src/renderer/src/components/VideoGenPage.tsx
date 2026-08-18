import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Alert, App as AntApp, Button, Empty, Input, Popconfirm, Select, Spin, Tooltip } from 'antd'
import { Clapperboard, ImagePlus, Sparkles, Trash2, X } from 'lucide-react'
import { api, type DressupHistoryItem } from '../lib/api'

type Frame = { dataUrl: string } | null
type HistoryItem = DressupHistoryItem & { provider: 'kling' }

const MAX_BYTES = 18 * 1024 * 1024
const STAGE_LABEL: Record<string, string> = {
  uploading: '上传参考图中',
  submitting: '提交生成任务',
  queued: '排队中',
  pending: '排队中',
  running: '生成视频中',
  downloading: '下载视频中',
  done: '完成',
  error: '失败',
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export default function VideoGenPage(): React.JSX.Element {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()
  const [prompt, setPrompt] = useState('')
  const [first, setFirst] = useState<Frame>(null)
  const [tail, setTail] = useState<Frame>(null)
  const [duration, setDuration] = useState<5 | 10>(5)
  const [klingMode, setKlingMode] = useState<'std' | 'pro'>('std')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [current, setCurrent] = useState<HistoryItem | null>(null)
  const [ready, setReady] = useState<boolean>()

  useEffect(() => {
    void Promise.all([api.dressup.history(), api.dressup.health()]).then(([items, health]) => {
      setHistory(items.map((item) => ({ ...item, provider: 'kling' as const })))
      setReady(health.klingReady)
    })
    const offKling = api.dressup.onProgress((event) => setStage(event.status))
    return offKling
  }, [])

  async function pick(setter: (frame: Frame) => void, file?: File): Promise<void> {
    if (!file) return
    if (!file.type.startsWith('image/')) return void message.error('请选择图片文件')
    if (file.size > MAX_BYTES) return void message.error('图片需小于 18MB')
    try {
      setter({ dataUrl: await readFileAsDataUrl(file) })
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取图片失败')
    }
  }

  async function generate(): Promise<void> {
    if (!first || !tail) return void message.warning('Kling 需要首帧和尾帧')
    setBusy(true)
    setStage(first ? 'uploading' : 'submitting')
    setCurrent(null)
    try {
      const result = await api.dressup.generate({
        firstFrameDataUrl: first.dataUrl,
        tailFrameDataUrl: tail.dataUrl,
        prompt: prompt.trim() || undefined,
        mode: klingMode,
        duration: duration === 10 ? '10' : '5',
      })
      if ('error' in result) return void message.error(result.error)
      const item = { ...result, provider: 'kling' as const }
      setCurrent(item)
      setHistory((items) => [item, ...items])
      message.success('视频已生成')
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  async function remove(item: HistoryItem): Promise<void> {
    await api.dressup.historyDelete(item.id)
    setHistory((items) => items.filter((candidate) => candidate.id !== item.id))
    if (current?.id === item.id) setCurrent(null)
  }

  const preview = current ?? history[0] ?? null
  return (
    <div className={styles.root}>
      <section className={styles.controls}>
        <div className={styles.title}><Clapperboard size={18} /> 视频生成</div>
        {ready === false && (
          <Alert
            type="warning"
            showIcon
            message="服务端尚未配置 Kling"
          />
        )}

        <div className={styles.hint}>上传首帧和尾帧，Kling 会生成两帧之间的动态过渡。</div>
        <div className={styles.frames}>
          <FrameSlot label="首帧" frame={first} onPick={(file) => pick(setFirst, file)} onClear={() => setFirst(null)} styles={styles} />
          <FrameSlot label="尾帧" frame={tail} onPick={(file) => pick(setTail, file)} onClear={() => setTail(null)} styles={styles} />
        </div>
        <div className={styles.formRow}>
          <Select value={klingMode} onChange={setKlingMode} options={[{ value: 'std', label: '标准模式' }, { value: 'pro', label: '专业模式' }]} />
          <Select value={duration} onChange={setDuration} options={[{ value: 5, label: '5 秒' }, { value: 10, label: '10 秒' }]} />
        </div>

        <Input.TextArea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="可选：描述首尾帧之间的动作和转场"
          autoSize={{ minRows: 3, maxRows: 7 }}
        />
        <Button type="primary" size="large" block loading={busy} icon={<Sparkles size={16} />} onClick={generate}>
          {busy ? STAGE_LABEL[stage] ?? '生成视频中' : '使用 Kling 生成'}
        </Button>
      </section>

      <section className={styles.preview}>
        {busy ? (
          <div className={styles.center}><Spin /><strong>{STAGE_LABEL[stage] ?? '生成视频中'}…</strong><span>视频生成可能需要数分钟</span></div>
        ) : preview ? (
          <video key={`${preview.provider}:${preview.id}`} className={styles.video} src={preview.videoUrl} controls autoPlay loop />
        ) : (
          <div className={styles.center}><Empty description="还没有生成视频" /></div>
        )}
        {history.length > 0 && (
          <div className={styles.history}>
            {history.map((item) => (
              <button key={`${item.provider}:${item.id}`} className={styles.historyItem} onClick={() => setCurrent(item)}>
                <video src={item.videoUrl} muted preload="metadata" />
                <span>Kling</span>
                <Popconfirm title="删除这条记录？" onConfirm={() => remove(item)} okText="删除" cancelText="取消">
                  <Tooltip title="删除">
                    <span className={styles.delete} onClick={(event) => event.stopPropagation()}><Trash2 size={12} /></span>
                  </Tooltip>
                </Popconfirm>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function FrameSlot({ label, frame, onPick, onClear, styles }: {
  label: string
  frame: Frame
  onPick: (file?: File) => void
  onClear: () => void
  styles: ReturnType<typeof useStyles>['styles']
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className={styles.slot}>
      <span>{label}</span>
      <div className={styles.dropzone} onClick={() => input.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onPick(event.dataTransfer.files?.[0]) }}>
        {frame ? <><img src={frame.dataUrl} alt={label} /><button onClick={(event) => { event.stopPropagation(); onClear() }}><X size={14} /></button></> : <div><ImagePlus size={22} /><span>点击或拖入</span></div>}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(event) => { onPick(event.target.files?.[0]); event.target.value = '' }} />
    </div>
  )
}

const useStyles = createStyles(({ token, css }) => ({
  root: css`display: flex; height: 100%; min-width: 0; overflow: hidden;`,
  controls: css`width: 390px; flex-shrink: 0; padding: 20px; overflow-y: auto; border-right: 1px solid ${token.colorBorderSecondary}; display: flex; flex-direction: column; gap: 14px;`,
  title: css`display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600;`,
  hint: css`font-size: 12px; color: ${token.colorTextTertiary};`,
  frames: css`display: flex; gap: 12px;`,
  singleFrame: css`width: 48%;`,
  slot: css`flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: ${token.colorTextSecondary};`,
  dropzone: css`position: relative; aspect-ratio: 3 / 4; overflow: hidden; cursor: pointer; border: 1px dashed ${token.colorBorder}; border-radius: ${token.borderRadiusLG}px; background: ${token.colorFillQuaternary}; &:hover { border-color: ${token.colorPrimary}; } img { width: 100%; height: 100%; object-fit: cover; } > div { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: ${token.colorTextTertiary}; } > button { position: absolute; top: 5px; right: 5px; width: 24px; height: 24px; border: none; border-radius: 50%; display: grid; place-items: center; color: white; background: rgba(0,0,0,.55); cursor: pointer; }`,
  formRow: css`display: flex; gap: 8px; > * { flex: 1; min-width: 0; }`,
  preview: css`flex: 1; min-width: 0; padding: 20px; display: flex; flex-direction: column; gap: 14px;`,
  center: css`flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: ${token.colorTextTertiary};`,
  video: css`flex: 1; min-height: 0; width: 100%; object-fit: contain; background: #000; border-radius: ${token.borderRadiusLG}px;`,
  history: css`display: flex; gap: 10px; flex-shrink: 0; overflow-x: auto; padding-bottom: 4px;`,
  historyItem: css`position: relative; width: 94px; aspect-ratio: 9 / 16; padding: 0; flex-shrink: 0; overflow: hidden; cursor: pointer; border: 1px solid ${token.colorBorderSecondary}; border-radius: ${token.borderRadius}px; background: #000; video { width: 100%; height: 100%; object-fit: cover; } > span:not(:last-child) { position: absolute; left: 5px; bottom: 5px; padding: 2px 5px; border-radius: 4px; font-size: 10px; color: white; background: rgba(0,0,0,.58); }`,
  delete: css`position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; color: white; background: rgba(0,0,0,.58);`,
}))

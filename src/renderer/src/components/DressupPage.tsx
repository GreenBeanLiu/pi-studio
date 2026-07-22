import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { App as AntApp, Button, Empty, Input, Popconfirm, Segmented, Spin, Tooltip } from 'antd'
import { Shirt, Sparkles, Trash2, ImagePlus, X } from 'lucide-react'
import { api, type DressupHistoryItem } from '../lib/api'

const STAGE_LABEL: Record<string, string> = {
  uploading: '上传照片中',
  submitting: '提交生成任务',
  queued: '排队中',
  running: '生成中',
  downloading: '下载视频中',
  done: '完成',
  error: '失败',
}

const MAX_BYTES = 18 * 1024 * 1024 // 服务端 /reference 上限 20MB,留点余量

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

type Frame = { dataUrl: string } | null

export default function DressupPage(): React.JSX.Element {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [first, setFirst] = useState<Frame>(null)
  const [tail, setTail] = useState<Frame>(null)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'std' | 'pro'>('std')

  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string>('')
  const [history, setHistory] = useState<DressupHistoryItem[]>([])
  const [current, setCurrent] = useState<DressupHistoryItem | null>(null)

  useEffect(() => {
    void api.dressup.history().then(setHistory)
    const off = api.dressup.onProgress((data) => setStage(data.status))
    return off
  }, [])

  async function pickFrame(setter: (f: Frame) => void, file?: File): Promise<void> {
    if (!file) return
    if (!file.type.startsWith('image/')) return void message.error('请选择图片文件')
    if (file.size > MAX_BYTES) return void message.error('图片太大(需小于 18MB)')
    try {
      setter({ dataUrl: await readFileAsDataUrl(file) })
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取失败')
    }
  }

  async function generate(): Promise<void> {
    if (!first || !tail) return void message.warning('请上传两套造型的照片')
    setBusy(true)
    setStage('uploading')
    setCurrent(null)
    try {
      const result = await api.dressup.generate({
        firstFrameDataUrl: first.dataUrl,
        tailFrameDataUrl: tail.dataUrl,
        prompt: prompt.trim() || undefined,
        mode,
      })
      if ('error' in result) {
        message.error(result.error)
      } else {
        setCurrent(result)
        setHistory((h) => [result, ...h])
        message.success('换装视频已生成')
      }
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  async function remove(id: string): Promise<void> {
    await api.dressup.historyDelete(id)
    setHistory((h) => h.filter((it) => it.id !== id))
    if (current?.id === id) setCurrent(null)
  }

  const preview = current ?? history[0] ?? null

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <div className={styles.title}>
          <Shirt size={18} /> 换装视频
        </div>
        <div className={styles.hint}>上传同一个人的两套造型,AI 生成从第一套到第二套的换装转场视频。</div>

        <div className={styles.frames}>
          <FrameSlot label="第一套造型(首帧)" frame={first} onPick={(f) => pickFrame(setFirst, f)} onClear={() => setFirst(null)} styles={styles} />
          <FrameSlot label="第二套造型(尾帧)" frame={tail} onPick={(f) => pickFrame(setTail, f)} onClear={() => setTail(null)} styles={styles} />
        </div>

        <Input.TextArea
          className={styles.prompt}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="可选:补充换装的动作/镜头描述(留空用默认换装提示词)"
          autoSize={{ minRows: 2, maxRows: 4 }}
        />

        <div className={styles.row}>
          <span className={styles.rowLabel}>模式</span>
          <Segmented value={mode} onChange={(v) => setMode(v as 'std' | 'pro')}
            options={[{ label: '标准', value: 'std' }, { label: '高质(pro)', value: 'pro' }]} />
          <span className={styles.subtle}>换装固定 5 秒</span>
        </div>

        <Button type="primary" size="large" block loading={busy} icon={<Sparkles size={16} />} onClick={generate}>
          {busy ? STAGE_LABEL[stage] ?? '生成中' : '生成换装视频'}
        </Button>
      </div>

      <div className={styles.right}>
        {busy ? (
          <div className={styles.center}>
            <Spin />
            <div className={styles.stage}>{STAGE_LABEL[stage] ?? '处理中'}…</div>
            <div className={styles.subtle}>可灵图生视频通常需要 1–3 分钟</div>
          </div>
        ) : preview ? (
          <video key={preview.id} className={styles.video} src={preview.videoUrl} controls autoPlay loop />
        ) : (
          <div className={styles.center}><Empty description="还没有换装视频" /></div>
        )}

        {history.length > 0 && (
          <div className={styles.historyStrip}>
            {history.map((it) => (
              <div key={it.id} className={styles.histItem} onClick={() => setCurrent(it)}>
                <video className={styles.histThumb} src={it.videoUrl} muted preload="metadata" />
                <Popconfirm title="删除这条记录?" onConfirm={() => remove(it.id)} okText="删除" cancelText="取消">
                  <button className={styles.histDel} onClick={(e) => e.stopPropagation()}><Trash2 size={12} /></button>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FrameSlot({
  label, frame, onPick, onClear, styles,
}: {
  label: string
  frame: Frame
  onPick: (f?: File) => void
  onClear: () => void
  styles: ReturnType<typeof useStyles>['styles']
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={styles.slot}>
      <div className={styles.slotLabel}>{label}</div>
      <div
        className={styles.dropzone}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onPick(e.dataTransfer.files?.[0]) }}
      >
        {frame ? (
          <>
            <img className={styles.slotImg} src={frame.dataUrl} alt={label} />
            <Tooltip title="移除">
              <button className={styles.slotClear} onClick={(e) => { e.stopPropagation(); onClear() }}><X size={14} /></button>
            </Tooltip>
          </>
        ) : (
          <div className={styles.slotEmpty}><ImagePlus size={22} /><span>点击或拖入照片</span></div>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

const useStyles = createStyles(({ token, css }) => ({
  root: css`display: flex; height: 100%; overflow: hidden;`,
  left: css`width: 380px; flex-shrink: 0; padding: 20px; overflow-y: auto; border-right: 1px solid ${token.colorBorderSecondary}; display: flex; flex-direction: column; gap: 14px;`,
  title: css`display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600;`,
  hint: css`color: ${token.colorTextTertiary}; font-size: 12px; margin-top: -6px;`,
  frames: css`display: flex; gap: 12px;`,
  slot: css`flex: 1; display: flex; flex-direction: column; gap: 6px;`,
  slotLabel: css`font-size: 12px; color: ${token.colorTextSecondary};`,
  dropzone: css`position: relative; aspect-ratio: 3/4; border: 1px dashed ${token.colorBorder}; border-radius: ${token.borderRadiusLG}px; overflow: hidden; cursor: pointer; background: ${token.colorFillQuaternary}; &:hover { border-color: ${token.colorPrimary}; }`,
  slotImg: css`width: 100%; height: 100%; object-fit: cover;`,
  slotEmpty: css`position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: ${token.colorTextTertiary}; font-size: 12px;`,
  slotClear: css`position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: none; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; display: grid; place-items: center; cursor: pointer;`,
  prompt: css`resize: none;`,
  row: css`display: flex; align-items: center; gap: 12px;`,
  rowLabel: css`width: 40px; font-size: 13px; color: ${token.colorTextSecondary};`,
  right: css`flex: 1; min-width: 0; padding: 20px; display: flex; flex-direction: column; gap: 14px;`,
  center: css`flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;`,
  stage: css`font-weight: 600;`,
  subtle: css`color: ${token.colorTextTertiary}; font-size: 12px;`,
  video: css`flex: 1; min-height: 0; width: 100%; object-fit: contain; background: #000; border-radius: ${token.borderRadiusLG}px;`,
  historyStrip: css`display: flex; gap: 10px; overflow-x: auto; flex-shrink: 0; padding-bottom: 4px;`,
  histItem: css`position: relative; width: 90px; aspect-ratio: 9/16; flex-shrink: 0; border-radius: ${token.borderRadius}px; overflow: hidden; cursor: pointer; border: 1px solid ${token.colorBorderSecondary};`,
  histThumb: css`width: 100%; height: 100%; object-fit: cover;`,
  histDel: css`position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; border: none; border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff; display: grid; place-items: center; cursor: pointer;`,
}))

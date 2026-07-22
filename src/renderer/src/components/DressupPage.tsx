import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { App as AntApp, Button, Empty, Input, Popconfirm, Segmented, Spin, Tooltip } from 'antd'
import { Shirt, User, Sparkles, Trash2, ImagePlus, X } from 'lucide-react'
import { api, type DressupHistoryItem } from '../lib/api'

const STAGE_LABEL: Record<string, string> = {
  uploading: '上传照片中',
  submitting: '提交生成任务',
  queued: '排队中',
  running: '生成换装视频中',
  video: '生成换装视频中',
  downloading: '下载视频中',
  done: '完成',
  error: '失败',
}
function stageLabel(s: string): string {
  if (s.startsWith('tryon')) return 'AI 试衣中'
  return STAGE_LABEL[s] ?? '生成换装视频中'
}

const MAX_BYTES = 18 * 1024 * 1024

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('图片加载失败'))
    i.src = src
  })
}

/** 等比缩到最长边 max,并重编码为 jpeg,控制体积(Kling ≤10MB、参考图 ≤20MB)。 */
async function downscale(dataUrl: string, max = 1280): Promise<string> {
  const img = await loadImg(dataUrl)
  const w0 = img.naturalWidth
  const h0 = img.naturalHeight
  const scale = Math.max(w0, h0) > max ? max / Math.max(w0, h0) : 1
  const w = Math.round(w0 * scale)
  const h = Math.round(h0 * scale)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(img, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.92)
}

/** 首帧 = 人物原图 + 左上角贴上衣服缩略图(带白色卡片底)。 */
async function composeFirstFrame(personUrl: string, garmentUrl: string): Promise<string> {
  const person = await loadImg(personUrl)
  const garment = await loadImg(garmentUrl)
  const c = document.createElement('canvas')
  c.width = person.naturalWidth
  c.height = person.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.drawImage(person, 0, 0)
  const tw = Math.round(c.width * 0.3)
  const th = Math.round((tw * garment.naturalHeight) / garment.naturalWidth)
  const m = Math.round(c.width * 0.03)
  const pad = Math.max(4, Math.round(c.width * 0.008))
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(m - pad, m - pad, tw + pad * 2, th + pad * 2)
  ctx.drawImage(garment, m, m, tw, th)
  return c.toDataURL('image/jpeg', 0.92)
}

type Frame = { dataUrl: string } | null
type Mode = 'tryon' | 'manual'

export default function DressupPage(): React.JSX.Element {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [mode, setMode] = useState<Mode>('tryon')
  // tryon 模式
  const [person, setPerson] = useState<Frame>(null)
  const [garment, setGarment] = useState<Frame>(null)
  const [firstPreview, setFirstPreview] = useState<string | null>(null)
  // manual 模式
  const [first, setFirst] = useState<Frame>(null)
  const [tail, setTail] = useState<Frame>(null)

  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [history, setHistory] = useState<DressupHistoryItem[]>([])
  const [current, setCurrent] = useState<DressupHistoryItem | null>(null)

  useEffect(() => {
    void api.dressup.history().then(setHistory)
    const off = api.dressup.onProgress((d) => setStage(d.status))
    return off
  }, [])

  // 人物+衣服齐了就合成首帧预览
  useEffect(() => {
    let alive = true
    if (person && garment) {
      composeFirstFrame(person.dataUrl, garment.dataUrl)
        .then((u) => alive && setFirstPreview(u))
        .catch(() => alive && setFirstPreview(null))
    } else {
      setFirstPreview(null)
    }
    return () => {
      alive = false
    }
  }, [person, garment])

  async function pick(setter: (f: Frame) => void, file?: File): Promise<void> {
    if (!file) return
    if (!file.type.startsWith('image/')) return void message.error('请选择图片文件')
    if (file.size > MAX_BYTES) return void message.error('图片太大(需小于 18MB)')
    try {
      setter({ dataUrl: await readFileAsDataUrl(file) })
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取失败')
    }
  }

  async function runTryon(): Promise<void> {
    if (!person || !garment) return void message.warning('请上传人物照和衣服图')
    setBusy(true)
    setStage('uploading')
    setCurrent(null)
    try {
      const p = await downscale(person.dataUrl, 1280)
      const g = await downscale(garment.dataUrl, 1000)
      const firstFrame = await composeFirstFrame(p, g)
      const result = await api.dressup.workflow({
        personDataUrl: p,
        garmentDataUrl: g,
        firstFrameDataUrl: firstFrame,
        prompt: prompt.trim() || undefined,
      })
      if ('error' in result) message.error(result.error)
      else {
        setCurrent(result)
        setHistory((h) => [result, ...h])
        message.success('换装视频已生成')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  async function runManual(): Promise<void> {
    if (!first || !tail) return void message.warning('请上传首帧和尾帧')
    setBusy(true)
    setStage('uploading')
    setCurrent(null)
    try {
      const result = await api.dressup.generate({
        firstFrameDataUrl: first.dataUrl,
        tailFrameDataUrl: tail.dataUrl,
        prompt: prompt.trim() || undefined,
        mode: 'std',
      })
      if ('error' in result) message.error(result.error)
      else {
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

        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { label: 'AI 试衣', value: 'tryon' },
            { label: '手动首尾帧', value: 'manual' },
          ]}
        />

        {mode === 'tryon' ? (
          <>
            <div className={styles.hint}>传一张人物照 + 一件衣服,AI 把衣服穿到人身上,生成"换装上身"的短视频。</div>
            <div className={styles.frames}>
              <FrameSlot label="人物照" icon={<User size={20} />} frame={person} onPick={(f) => pick(setPerson, f)} onClear={() => setPerson(null)} styles={styles} />
              <FrameSlot label="衣服图" icon={<Shirt size={20} />} frame={garment} onPick={(f) => pick(setGarment, f)} onClear={() => setGarment(null)} styles={styles} />
            </div>
            {firstPreview && (
              <div className={styles.previewBox}>
                <div className={styles.previewLabel}>首帧预览(人物 + 左上角衣服)</div>
                <img className={styles.previewImg} src={firstPreview} alt="首帧预览" />
              </div>
            )}
            <Input.TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="可选:补充试衣要求(留空用默认:保持人物不变、只换衣服)"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
            <Button type="primary" size="large" block loading={busy} icon={<Sparkles size={16} />} onClick={runTryon}>
              {busy ? stageLabel(stage) : '生成换装视频'}
            </Button>
          </>
        ) : (
          <>
            <div className={styles.hint}>直接给两帧:首帧和尾帧,Kling 在两帧之间插值成转场视频。</div>
            <div className={styles.frames}>
              <FrameSlot label="首帧" frame={first} onPick={(f) => pick(setFirst, f)} onClear={() => setFirst(null)} styles={styles} />
              <FrameSlot label="尾帧" frame={tail} onPick={(f) => pick(setTail, f)} onClear={() => setTail(null)} styles={styles} />
            </div>
            <Input.TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="可选:补充转场描述"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
            <Button type="primary" size="large" block loading={busy} icon={<Sparkles size={16} />} onClick={runManual}>
              {busy ? stageLabel(stage) : '生成换装视频'}
            </Button>
          </>
        )}
      </div>

      <div className={styles.right}>
        {busy ? (
          <div className={styles.center}>
            <Spin />
            <div className={styles.stage}>{stageLabel(stage)}…</div>
            <div className={styles.subtle}>
              {mode === 'tryon' ? 'AI 试衣约 1 分钟 + 视频约 3–5 分钟,请耐心等待' : '可灵图生视频通常需要 3–5 分钟'}
            </div>
          </div>
        ) : preview ? (
          <video key={preview.id} className={styles.video} src={preview.videoUrl} controls autoPlay loop />
        ) : (
          <div className={styles.center}>
            <Empty description="还没有换装视频" />
          </div>
        )}

        {history.length > 0 && (
          <div className={styles.historyStrip}>
            {history.map((it) => (
              <div key={it.id} className={styles.histItem} onClick={() => setCurrent(it)}>
                <video className={styles.histThumb} src={it.videoUrl} muted preload="metadata" />
                <Popconfirm title="删除这条记录?" onConfirm={() => remove(it.id)} okText="删除" cancelText="取消">
                  <button className={styles.histDel} onClick={(e) => e.stopPropagation()}>
                    <Trash2 size={12} />
                  </button>
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
  label, icon, frame, onPick, onClear, styles,
}: {
  label: string
  icon?: React.ReactNode
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
        onDrop={(e) => {
          e.preventDefault()
          onPick(e.dataTransfer.files?.[0])
        }}
      >
        {frame ? (
          <>
            <img className={styles.slotImg} src={frame.dataUrl} alt={label} />
            <Tooltip title="移除">
              <button className={styles.slotClear} onClick={(e) => { e.stopPropagation(); onClear() }}>
                <X size={14} />
              </button>
            </Tooltip>
          </>
        ) : (
          <div className={styles.slotEmpty}>
            {icon ?? <ImagePlus size={22} />}
            <span>点击或拖入</span>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          onPick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

const useStyles = createStyles(({ token, css }) => ({
  root: css`display: flex; height: 100%; overflow: hidden;`,
  left: css`width: 380px; flex-shrink: 0; padding: 20px; overflow-y: auto; border-right: 1px solid ${token.colorBorderSecondary}; display: flex; flex-direction: column; gap: 14px;`,
  title: css`display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600;`,
  hint: css`color: ${token.colorTextTertiary}; font-size: 12px; margin-top: -4px;`,
  frames: css`display: flex; gap: 12px;`,
  slot: css`flex: 1; display: flex; flex-direction: column; gap: 6px;`,
  slotLabel: css`font-size: 12px; color: ${token.colorTextSecondary};`,
  dropzone: css`position: relative; aspect-ratio: 3/4; border: 1px dashed ${token.colorBorder}; border-radius: ${token.borderRadiusLG}px; overflow: hidden; cursor: pointer; background: ${token.colorFillQuaternary}; &:hover { border-color: ${token.colorPrimary}; }`,
  slotImg: css`width: 100%; height: 100%; object-fit: cover;`,
  slotEmpty: css`position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: ${token.colorTextTertiary}; font-size: 12px;`,
  slotClear: css`position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: none; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; display: grid; place-items: center; cursor: pointer;`,
  previewBox: css`display: flex; flex-direction: column; gap: 6px;`,
  previewLabel: css`font-size: 12px; color: ${token.colorTextSecondary};`,
  previewImg: css`width: 100%; border-radius: ${token.borderRadiusLG}px; border: 1px solid ${token.colorBorderSecondary};`,
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

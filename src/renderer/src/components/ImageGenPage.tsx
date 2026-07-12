import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Button, Input, Modal, Popconfirm, Slider, Spin, Switch, Tooltip, App as AntApp } from 'antd'
import {
  Image as ImageIcon,
  Cloud,
  Monitor,
  Download,
  Link2,
  RefreshCw,
  Brush,
  Eraser,
  Redo2,
  Upload,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  api,
  type ImageGenEngine,
  type ImageGenSize,
  type ImageGenHealth,
  type ImageGenHistoryItem,
} from '../lib/api'

/** 与 icon-studio 一致的风格预设(拼接到 prompt 后,英文更稳)。 */
const STYLE_PRESETS = [
  { id: 'none', label: '自由', suffix: '' },
  {
    id: 'flat',
    label: '扁平',
    suffix:
      'flat design, simple bold shapes, minimal, vibrant solid colors, centered composition',
  },
  {
    id: 'gradient',
    label: '渐变',
    suffix: 'smooth vibrant gradient, glossy, soft shadows, modern, centered composition',
  },
  {
    id: 'line',
    label: '线性',
    suffix: 'minimal line-art, thin clean strokes, monochrome, lots of negative space',
  },
  {
    id: '3d',
    label: '3D',
    suffix: '3D rendered, soft studio lighting, glossy material, subtle reflections, depth',
  },
  {
    id: 'illust',
    label: '插画',
    suffix: 'digital illustration, rich colors, detailed, artstation trending',
  },
]

/** 进行中的生成任务,在历史区占一个转圈的格子。 */
type PendingGen = { key: string; prompt: string; engine: string }

/** 本次会话生成、但没有公网链接(云端不可达没留档)的图,只在本页存在。 */
type SessionResult = {
  key: string
  src: string // dataUrl
  prompt: string
  engine: string
  createdAt: number
}

const PAGE_SIZE = 60

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(340px, 35fr) minmax(0, 65fr);
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};

    @media (max-width: 900px) {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }
  `,
  panel: css`
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: 16px;
    overflow-y: auto;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  chips: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  `,
  /** 修改底图预览:大正方形,右上角删除、左下角涂抹重绘,放在 prompt 上方 */
  basePreview: css`
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    border-radius: ${token.borderRadiusLG}px;
    overflow: hidden;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
  `,
  basePreviewTopRight: css`
    position: absolute;
    top: 8px;
    right: 8px;
  `,
  basePreviewBottomLeft: css`
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    gap: 6px;
  `,
  gallery: css`
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: 16px;
    overflow-y: auto;
  `,
  maskViewport: css`
    position: relative;
    overflow: auto;
    max-height: 60vh;
    min-height: 260px;
    padding: 12px;
    background: #181818;
    overscroll-behavior: contain;
  `,
  galleryHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};

    .sub {
      font-weight: 400;
      font-size: 12px;
      color: ${token.colorTextTertiary};
    }
  `,
  empty: css`
    flex: 1;
    color: ${token.colorTextQuaternary};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 14px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  `,
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    overflow: hidden;
    display: flex;
    flex-direction: column;
  `,
  cardImage: css`
    position: relative;
    aspect-ratio: 1;
    cursor: zoom-in;
    background: ${token.colorFillTertiary};

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  `,
  cardBody: css`
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  cardPrompt: css`
    font-size: 12px;
    line-height: 1.5;
    color: ${token.colorTextSecondary};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 36px;
    word-break: break-word;
  `,
  cardMeta: css`
    display: flex;
    align-items: center;
    gap: 2px;
    font-size: 11px;
    color: ${token.colorTextQuaternary};

    .time {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  pendingBox: css`
    aspect-ratio: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-bottom: 1px dashed ${token.colorPrimaryBorder};
  `,
  histTag: css`
    position: absolute;
    left: 5px;
    bottom: 5px;
    font-size: 11px;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
  `,
  loadState: css`
    text-align: center;
    font-size: 12px;
    color: ${token.colorTextQuaternary};
    padding: 8px 0 2px;
  `,
  /* 放大浮层:hover 版不拦截鼠标(否则会闪烁),点击固定版可点击/Esc 关闭 */
  /* 点击图片打开的灯箱:点背景关闭,点图在「适应屏幕」和「原始尺寸」间切换 */
  lightbox: css`
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.7);
    cursor: zoom-out;
    overscroll-behavior: contain;
  `,
  lightboxImg: css`
    max-width: 92vw;
    max-height: 92vh;
    border-radius: ${token.borderRadiusLG}px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    cursor: zoom-in;
    transform-origin: center center;
    transition: transform 0.12s ease;
    will-change: transform;
    user-select: none;
    -webkit-user-drag: none;
    touch-action: none;
  `,
  lightboxImgZoomed: css`
    max-width: none;
    max-height: none;
    margin: auto;
    cursor: zoom-out;
    border-radius: 0;
    transition: none;
  `,
  offline: css`
    color: ${token.colorWarning};
    font-size: 13px;
    line-height: 1.6;
  `,
}))

export default function ImageGenPage() {
  return (
    <AntApp component={false}>
      <ImageGenInner />
    </AntApp>
  )
}

function ImageGenInner() {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()

  const [health, setHealth] = useState<ImageGenHealth | null>(null)
  const [prompt, setPrompt] = useState('')
  const [presetId, setPresetId] = useState('none')
  const [engine, setEngine] = useState<ImageGenEngine>('comfy')
  const [size, setSize] = useState<ImageGenSize>('square_hd')
  const [comfyBusy, setComfyBusy] = useState(false)
  const [history, setHistory] = useState<ImageGenHistoryItem[]>([])
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([])
  const [pending, setPending] = useState<PendingGen[]>([])
  const [baseImage, setBaseImage] = useState<string | null>(null) // 改图底图 URL
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null)
  const [maskEditorOpen, setMaskEditorOpen] = useState(false)
  const [pinnedSrc, setPinnedSrc] = useState<string | null>(null)
  const [pinnedScale, setPinnedScale] = useState(1)
  const [pinnedOffset, setPinnedOffset] = useState({ x: 0, y: 0 })
  const [loadingMore, setLoadingMore] = useState(false)
  const [historyDone, setHistoryDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const didDragRef = useRef(false)

  const galleryRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const limitRef = useRef(PAGE_SIZE)

  async function refreshHealth() {
    const h = await api.imageGen.health()
    setHealth(h)
    setEngine((prev) => {
      if (prev === 'comfy' && !h.comfy && h.keyConfigured) return 'openai'
      if (prev === 'openai' && !h.keyConfigured && h.comfy) return 'comfy'
      return prev
    })
  }

  async function fetchHistory(limit: number) {
    const r = await api.imageGen.history(limit)
    if (Array.isArray(r)) {
      setHistory(r)
      setHistoryDone(r.length < limit)
    }
  }

  async function loadMore() {
    if (loadingMore || historyDone) return
    setLoadingMore(true)
    try {
      limitRef.current += PAGE_SIZE
      await fetchHistory(limitRef.current)
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    // 设置里的默认引擎优先(refreshHealth 仍会在所选引擎不可用时兜底切换)
    api.settings
      .load()
      .then((s) => {
        if (s.imageEngine === 'comfy' || s.imageEngine === 'openai') setEngine(s.imageEngine)
      })
      .catch(() => {})
    refreshHealth()
    fetchHistory(limitRef.current)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 滚到底自动加载更多
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = galleryRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // loadMore 闭包依赖的状态都从 ref/setState 函数式读取之外,historyDone/loadingMore 变化时重建
  }, [historyDone, loadingMore])

  const serviceUp = health?.ok ?? false

  async function toggleComfy(on: boolean) {
    if (comfyBusy) return
    setComfyBusy(true)
    try {
      if (on) {
        const r = await api.imageGen.comfyStart()
        if ('error' in r) {
          message.error(r.error)
        } else {
          message.success('ComfyUI 已启动')
          setEngine('comfy')
        }
      } else {
        const r = await api.imageGen.comfyStop()
        if (!r.ok && r.external) {
          message.warning('ComfyUI 是在 pi-studio 外部启动的,请从启动它的地方关闭')
        }
      }
    } finally {
      await refreshHealth()
      setComfyBusy(false)
    }
  }

  async function generate() {
    const text = prompt.trim()
    if (!text || pending.length >= 3) return
    const preset = STYLE_PRESETS.find((p) => p.id === presetId)
    const full = preset?.suffix
      ? `${text}, ${preset.suffix}. High quality, sharp, no watermark, no text.`
      : `${text}. High quality, sharp, no watermark, no text.`
    const isEdit = !!baseImage
    const refUrls = baseImage ? [baseImage] : undefined

    // 任务进历史区转圈,按钮立即释放,可连续下多个任务(上限 3 并发)
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const engineTag =
      engine === 'comfy' ? (isEdit ? 'comfy-edit' : 'comfy') : isEdit ? 'cloud-edit' : 'cloud'
    setPending((p) => [{ key, prompt: text, engine: engineTag }, ...p])

    try {
      const r = await api.imageGen.generate({
        prompt: full,
        engine,
        // 尺寸仅云端 gpt-image-2 生效;本地 ComfyUI 由 workflow 固定
        ...(engine === 'openai' ? { size } : {}),
        ...(refUrls ? { referenceUrls: refUrls } : {}),
        ...(maskDataUrl ? { maskDataUrl } : {}),
      })
      if ('error' in r) {
        message.error(r.error)
        return
      }
      if (r.publicUrl) {
        // 已留档云端,刷新历史就能看到
        await fetchHistory(limitRef.current)
      } else {
        // 没有公网链接(云端不可达),本页临时保留,别丢图
        setSessionResults((s) => [
          { key, src: r.dataUrl, prompt: text, engine: engineTag, createdAt: Date.now() },
          ...s,
        ])
      }
    } finally {
      setPending((p) => p.filter((x) => x.key !== key))
    }
  }

  function downloadDataUrl(src: string) {
    const a = document.createElement('a')
    a.href = src
    a.download = `pi-image-${Date.now()}.png`
    a.click()
  }

  async function downloadUrl(url: string) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const obj = URL.createObjectURL(blob)
      downloadDataUrl(obj)
      setTimeout(() => URL.revokeObjectURL(obj), 10_000)
    } catch {
      navigator.clipboard.writeText(url)
      message.warning('直接下载失败,已复制图片链接,可在浏览器打开保存')
    }
  }

  async function deleteHistoryItem(item: ImageGenHistoryItem) {
    const r = await api.imageGen.historyDelete(item.id)
    if (!r.ok) {
      message.error('删除失败')
      return
    }
    setHistory((h) => h.filter((x) => x.id !== item.id))
    if (baseImage === item.url) setBaseImage(null)
  }

  function useAsBase(url: string) {
    setBaseImage(url)
    setMaskDataUrl(null)
    setPrompt('')
    message.info('已设为底图,输入修改要求后点"修改这张图"')
  }

  function openLightbox(src: string) {
    setPinnedSrc(src)
    setPinnedScale(1)
    setPinnedOffset({ x: 0, y: 0 })
  }
  function closeLightbox() {
    setPinnedSrc(null)
    setPinnedScale(1)
    setPinnedOffset({ x: 0, y: 0 })
    dragRef.current = null
  }

  function handleReferenceUpload(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error('图片不能超过 20MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') return
      setBaseImage(reader.result)
      setMaskDataUrl(null)
      setPrompt('')
      message.success('图片已载入，可以输入修改要求')
    }
    reader.onerror = () => message.error('读取图片失败')
    reader.readAsDataURL(file)
  }

  const engineLabel = (e: string) =>
    e.startsWith('cloud') ? '云' : e.startsWith('comfy') ? '本' : e
  const timeLabel = (ts: number) =>
    new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  const canGenerate =
    pending.length < 3 &&
    !!prompt.trim() &&
    (engine === 'comfy' ? !!health?.comfy : !!health?.keyConfigured)

  const totalCount = history.length + sessionResults.length
  const iconBtn = { size: 'small' as const, type: 'text' as const }

  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        {/* 上传底图 + 大图预览:放在 prompt 上方 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            handleReferenceUpload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button block icon={<Upload size={13} />} onClick={() => fileInputRef.current?.click()}>
          {baseImage ? '更换修改底图' : '上传图片作为修改底图'}
        </Button>

        {baseImage && (
          <div className={styles.basePreview}>
            <img src={baseImage} alt="base" />
            <div className={styles.basePreviewTopRight}>
              <Button
                size="small"
                icon={<X size={13} />}
                onClick={() => {
                  setBaseImage(null)
                  setMaskDataUrl(null)
                }}
              />
            </div>
            <div className={styles.basePreviewBottomLeft}>
              <Button
                size="small"
                type="primary"
                icon={<Brush size={13} />}
                onClick={() => setMaskEditorOpen(true)}
              >
                涂抹重绘
              </Button>
              {maskDataUrl && (
                <Button size="small" onClick={() => setMaskDataUrl(null)}>
                  清除蒙版
                </Button>
              )}
            </div>
          </div>
        )}

        <span className={styles.label}>
          {baseImage ? '描述怎么修改这张图' : '描述你想要的图'}
        </span>
        <Input.TextArea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            baseImage
              ? '例如:改成夜晚场景 / 把背景换成雪山 / make it watercolor style'
              : '例如:一座雪山下的湖泊,晨雾 / a cyberpunk city street at night'
          }
          autoSize={{ minRows: 4, maxRows: 8 }}
        />

        <span className={styles.label}>风格</span>
        <div className={styles.chips}>
          {STYLE_PRESETS.map((p) => (
            <Button
              key={p.id}
              size="small"
              type={presetId === p.id ? 'primary' : 'default'}
              onClick={() => setPresetId(p.id)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <span className={styles.label}>
          尺寸
          {engine === 'comfy' && (
            <span style={{ opacity: 0.6 }}> · 本地引擎固定 1024×1024，此项仅云端生效</span>
          )}
        </span>
        <div className={styles.chips}>
          {(
            [
              { id: 'square_hd', label: '方形 1:1' },
              { id: 'landscape_4_3', label: '横版 3:2' },
              { id: 'portrait_4_3', label: '竖版 2:3' },
            ] as { id: ImageGenSize; label: string }[]
          ).map((s) => (
            <Button
              key={s.id}
              size="small"
              type={size === s.id ? 'primary' : 'default'}
              disabled={engine === 'comfy'}
              onClick={() => setSize(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>

        <span className={styles.label}>ComfyUI(本地引擎)</span>
        <div className={styles.chips}>
          <Tooltip
            title={
              health?.comfy && !health.comfyManaged
                ? '由 pi-studio 外部启动,只能从启动它的地方关闭'
                : ''
            }
          >
            <Switch
              checked={health?.comfy ?? false}
              loading={comfyBusy}
              disabled={!!health?.comfy && !health.comfyManaged}
              checkedChildren="运行中"
              unCheckedChildren="已关闭"
              onChange={toggleComfy}
            />
          </Tooltip>
          {comfyBusy && <span className={styles.label}>启动要加载模型,约 10~30 秒…</span>}
          {health?.comfy && (
            <span className={styles.label}>
              {health.comfyCheckpointAvailable === false
                ? health.comfyCheckpoint
                  ? `缺少 checkpoint: ${health.comfyCheckpoint}`
                  : '未发现 checkpoint'
                : !health.comfyWorkflowReady
                ? '未发现当前模板支持的 SD checkpoint'
                : `${health.comfyCheckpoint ? `模型 ${health.comfyCheckpoint}` : '自动选择模型'}${
                    health.comfyPythonVersion ? ` · Python ${health.comfyPythonVersion}` : ''
                  }${health.comfyDevices.length ? ` · ${health.comfyDevices.join(', ')}` : ''}`}
            </span>
          )}
          {!health?.comfy && health?.comfyLastError && (
            <span className={styles.offline} title={health.comfyLastError}>
              {health.comfyLastError}
            </span>
          )}
        </div>

        <span className={styles.label}>引擎</span>
        <div className={styles.chips}>
          <Tooltip title={health?.keyConfigured ? '' : '云端图像服务不可达'}>
            <Button
              size="small"
              type={engine === 'openai' ? 'primary' : 'default'}
              disabled={!health?.keyConfigured}
              icon={<Cloud size={13} />}
              onClick={() => setEngine('openai')}
            >
              云端 {health?.model || ''}
            </Button>
          </Tooltip>
          <Tooltip title={health?.comfy ? '' : 'ComfyUI 未运行,打开上面的开关'}>
            <Button
              size="small"
              type={engine === 'comfy' ? 'primary' : 'default'}
              disabled={!health?.comfy}
              icon={<Monitor size={13} />}
              onClick={() => setEngine('comfy')}
            >
              本地 ComfyUI
            </Button>
          </Tooltip>
          <Tooltip title="重新检测服务状态">
            <Button size="small" icon={<RefreshCw size={13} />} onClick={refreshHealth} />
          </Tooltip>
        </div>

        {!serviceUp && !comfyBusy && (
          <div className={styles.offline}>没有可用引擎——打开上面的 ComfyUI 开关即可。</div>
        )}

        <Button type="primary" disabled={!canGenerate} onClick={generate}>
          {baseImage ? '修改这张图' : '生成'}
          {pending.length > 0 ? `(${pending.length} 个进行中)` : ''}
        </Button>
      </section>

      <section className={styles.gallery} ref={galleryRef}>
        <div className={styles.galleryHead}>
          历史记录({totalCount})
          {pending.length > 0 && <span className="sub">{pending.length} 个生成中…</span>}
          <span className="sub" style={{ marginLeft: 'auto' }}>
            点击放大 · 滚动加载更多
          </span>
        </div>

        {totalCount === 0 && pending.length === 0 && (
          <div className={styles.empty}>
            <ImageIcon size={40} strokeWidth={1.2} />
            还没有图,左边描述一下想要什么
          </div>
        )}

        {(totalCount > 0 || pending.length > 0) && (
          <div className={styles.grid}>
            {pending.map((p) => (
              <div key={p.key} className={styles.card} title={p.prompt}>
                <div className={styles.pendingBox}>
                  <Spin size="small" />
                  <span className={styles.cardMeta}>{engineLabel(p.engine)}·生成中</span>
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardPrompt}>{p.prompt}</div>
                </div>
              </div>
            ))}

            {sessionResults.map((s) => (
              <div key={s.key} className={styles.card}>
                <div className={styles.cardImage} onClick={() => openLightbox(s.src)}>
                  <img src={s.src} alt={s.prompt} />
                  <span className={styles.histTag}>{engineLabel(s.engine)}·未留档</span>
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardPrompt} title={s.prompt}>
                    {s.prompt}
                  </div>
                  <div className={styles.cardMeta}>
                    <span className="time">{timeLabel(s.createdAt)}</span>
                    <Tooltip title="下载 PNG">
                      <Button {...iconBtn} icon={<Download size={13} />} onClick={() => downloadDataUrl(s.src)} />
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))}

            {history.map((h) => (
              <div key={h.id} className={styles.card}>
                <div className={styles.cardImage} onClick={() => openLightbox(h.url)}>
                  <img src={h.url} alt={h.prompt} loading="lazy" />
                  <span className={styles.histTag}>{engineLabel(h.engine)}</span>
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardPrompt} title={h.prompt}>
                    {h.prompt}
                  </div>
                  <div className={styles.cardMeta}>
                    <span className="time">{timeLabel(h.created_at)}</span>
                    <Tooltip title="下载 PNG">
                      <Button {...iconBtn} icon={<Download size={13} />} onClick={() => downloadUrl(h.url)} />
                    </Tooltip>
                    <Tooltip title="复制链接">
                      <Button
                        {...iconBtn}
                        icon={<Link2 size={13} />}
                        onClick={() => {
                          navigator.clipboard.writeText(h.url)
                          message.success('已复制公网链接')
                        }}
                      />
                    </Tooltip>
                    <Tooltip title="以此图修改">
                      <Button {...iconBtn} icon={<Brush size={13} />} onClick={() => useAsBase(h.url)} />
                    </Tooltip>
                    <Popconfirm title="删除这条记录?" onConfirm={() => deleteHistoryItem(h)}>
                      <Button {...iconBtn} danger icon={<Trash2 size={13} />} />
                    </Popconfirm>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={sentinelRef} />
        {totalCount > 0 && (
          <div className={styles.loadState}>
            {loadingMore ? <Spin size="small" /> : historyDone ? '没有更多了' : ''}
          </div>
        )}
      </section>

      {pinnedSrc && (
        <div
          className={styles.lightbox}
          onClick={closeLightbox}
          onWheel={(e) => {
            e.preventDefault()
            setPinnedScale((scale) => {
              const next = Math.min(4, Math.max(1, scale + (e.deltaY < 0 ? 0.15 : -0.15)))
              if (next === 1) setPinnedOffset({ x: 0, y: 0 })
              return next
            })
          }}
        >
          <img
            src={pinnedSrc}
            alt="preview"
            className={pinnedScale > 1 ? `${styles.lightboxImg} ${styles.lightboxImgZoomed}` : styles.lightboxImg}
            style={{ transform: `translate3d(${pinnedOffset.x}px, ${pinnedOffset.y}px, 0) scale(${pinnedScale})` }}
            onPointerDown={(e) => {
              if (pinnedScale <= 1) return
              e.stopPropagation()
              e.currentTarget.setPointerCapture(e.pointerId)
              dragRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                originX: pinnedOffset.x,
                originY: pinnedOffset.y,
              }
              didDragRef.current = false
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== e.pointerId) return
              const dx = e.clientX - drag.startX
              const dy = e.clientY - drag.startY
              if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
              setPinnedOffset({ x: drag.originX + dx, y: drag.originY + dy })
            }}
            onPointerUp={(e) => {
              if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
            }}
            onPointerCancel={() => {
              dragRef.current = null
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (didDragRef.current) {
                didDragRef.current = false
                return
              }
              setPinnedScale((scale) => (scale > 1 ? 1 : 2))
              setPinnedOffset({ x: 0, y: 0 })
            }}
          />
        </div>
      )}

      {baseImage && (
        <MaskEditor
          open={maskEditorOpen}
          src={baseImage}
          onCancel={() => setMaskEditorOpen(false)}
          onApply={(mask) => {
            setMaskDataUrl(mask)
            setMaskEditorOpen(false)
            message.success('蒙版已保存，生成时会只重绘透明区域')
          }}
        />
      )}
    </div>
  )
}

function MaskEditor({
  open,
  src,
  onCancel,
  onApply,
}: {
  open: boolean
  src: string
  onCancel: () => void
  onApply: (maskDataUrl: string) => void
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const paintRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  type CanvasSnapshot = { paint: ImageData; mask: ImageData }
  const historyRef = useRef<CanvasSnapshot[]>([])
  const redoRef = useRef<CanvasSnapshot[]>([])
  const [brushSize, setBrushSize] = useState(16)
  const [mode, setMode] = useState<'paint' | 'erase'>('paint')
  const [ready, setReady] = useState(false)
  const [hasPainted, setHasPainted] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  const [zoom, setZoom] = useState(1)

  function resetCanvases() {
    const image = imageRef.current
    const paint = paintRef.current
    const mask = maskRef.current
    if (!image || !paint || !mask || !image.naturalWidth || !image.naturalHeight) return
    paint.width = image.naturalWidth
    paint.height = image.naturalHeight
    mask.width = image.naturalWidth
    mask.height = image.naturalHeight
    paint.getContext('2d')?.clearRect(0, 0, paint.width, paint.height)
    const maskContext = mask.getContext('2d')
    if (!maskContext) return
    maskContext.globalCompositeOperation = 'source-over'
    maskContext.fillStyle = '#fff'
    maskContext.fillRect(0, 0, mask.width, mask.height)
    historyRef.current = []
    redoRef.current = []
    setUndoCount(0)
    setRedoCount(0)
    setHasPainted(false)
    setMode('paint')
    setZoom(1)
    setReady(true)
  }

  useEffect(() => {
    if (!open) return
    setReady(false)
    setBrushSize(16)
    const image = imageRef.current
    if (image?.complete) requestAnimationFrame(resetCanvases)
  }, [open, src])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const key = event.key.toLowerCase()
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && key === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (key === 'b') setMode('paint')
      else if (key === 'e') setMode('erase')
      else if (key === '[') setBrushSize((size) => Math.max(4, size - 4))
      else if (key === ']') setBrushSize((size) => Math.min(72, size + 4))
      else if (key === '+' || key === '=') setZoom((value) => Math.min(3, value + 0.1))
      else if (key === '-' || key === '_') setZoom((value) => Math.max(1, value - 0.1))
      else if (key === '0') setZoom(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  function snapshot(): CanvasSnapshot | null {
    const paint = paintRef.current
    const mask = maskRef.current
    const paintContext = paint?.getContext('2d')
    const maskContext = mask?.getContext('2d')
    if (!paint || !mask || !paintContext || !maskContext) return null
    return {
      paint: paintContext.getImageData(0, 0, paint.width, paint.height),
      mask: maskContext.getImageData(0, 0, mask.width, mask.height),
    }
  }

  function restore(snapshotValue: CanvasSnapshot) {
    paintRef.current?.getContext('2d')?.putImageData(snapshotValue.paint, 0, 0)
    maskRef.current?.getContext('2d')?.putImageData(snapshotValue.mask, 0, 0)
  }

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = paintRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  function drawLine(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    const paintCanvas = paintRef.current
    const maskCanvas = maskRef.current
    if (!paintCanvas || !maskCanvas) return
    const { x, y } = point(event)
    const rect = paintCanvas.getBoundingClientRect()
    const width = brushSize * (paintCanvas.width / rect.width)
    const paintContext = paintCanvas.getContext('2d')
    const maskContext = maskCanvas.getContext('2d')
    if (!paintContext || !maskContext) return
    const last = lastPointRef.current ?? { x, y }
    paintContext.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'
    paintContext.beginPath()
    paintContext.moveTo(last.x, last.y)
    paintContext.lineCap = 'round'
    paintContext.lineJoin = 'round'
    paintContext.lineWidth = width
    paintContext.strokeStyle = 'rgba(255, 64, 64, 0.48)'
    paintContext.lineTo(x, y)
    paintContext.stroke()
    maskContext.strokeStyle = '#fff'
    maskContext.globalCompositeOperation = mode === 'erase' ? 'source-over' : 'destination-out'
    maskContext.beginPath()
    maskContext.moveTo(last.x, last.y)
    maskContext.lineCap = 'round'
    maskContext.lineJoin = 'round'
    maskContext.lineWidth = width
    maskContext.lineTo(x, y)
    maskContext.stroke()
    lastPointRef.current = { x, y }
    setHasPainted(true)
  }

  function markPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return
    drawingRef.current = true
    lastPointRef.current = null
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = point(event)
    const paintCanvas = paintRef.current
    const maskCanvas = maskRef.current
    if (!paintCanvas || !maskCanvas) return
    const rect = paintCanvas.getBoundingClientRect()
    const width = brushSize * (paintCanvas.width / rect.width)
    const paintContext = paintCanvas.getContext('2d')
    const maskContext = maskCanvas.getContext('2d')
    if (!paintContext || !maskContext) return
    const before = snapshot()
    if (before) historyRef.current = [...historyRef.current.slice(-29), before]
    redoRef.current = []
    setUndoCount(historyRef.current.length)
    setRedoCount(0)
    paintContext.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'
    paintContext.beginPath()
    paintContext.fillStyle = 'rgba(255, 64, 64, 0.48)'
    paintContext.arc(x, y, width / 2, 0, Math.PI * 2)
    paintContext.fill()
    maskContext.globalCompositeOperation = mode === 'erase' ? 'source-over' : 'destination-out'
    maskContext.fillStyle = '#fff'
    maskContext.beginPath()
    maskContext.arc(x, y, width / 2, 0, Math.PI * 2)
    maskContext.fill()
    setHasPainted(true)
  }

  function undo() {
    const current = snapshot()
    const previous = historyRef.current.pop()
    if (!current || !previous) return
    redoRef.current = [...redoRef.current.slice(-29), current]
    restore(previous)
    setUndoCount(historyRef.current.length)
    setRedoCount(redoRef.current.length)
    setHasPainted(historyRef.current.length > 0)
  }

  function redo() {
    const current = snapshot()
    const next = redoRef.current.pop()
    if (!current || !next) return
    historyRef.current = [...historyRef.current.slice(-29), current]
    restore(next)
    setUndoCount(historyRef.current.length)
    setRedoCount(redoRef.current.length)
    setHasPainted(true)
  }

  function changeZoom(delta: number) {
    setZoom((value) => Math.min(3, Math.max(1, Math.round((value + delta) * 10) / 10)))
  }

  return (
    <Modal
      title="涂抹需要重绘的区域"
      open={open}
      width={820}
      destroyOnClose
      onCancel={onCancel}
      okText="使用蒙版"
      cancelText="取消"
      okButtonProps={{ disabled: !ready || !hasPainted }}
      onOk={() => {
        if (maskRef.current && hasPainted) onApply(maskRef.current.toDataURL('image/png'))
      }}
    >
      <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>
        红色区域会被重绘；未涂抹区域保留。白色保留，透明区域重绘。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <Button size="small" type={mode === 'paint' ? 'primary' : 'default'} icon={<Brush size={13} />} onClick={() => setMode('paint')}>
          涂抹
        </Button>
        <Button size="small" type={mode === 'erase' ? 'primary' : 'default'} icon={<Eraser size={13} />} onClick={() => setMode('erase')}>
          橡皮擦
        </Button>
        <Tooltip title="Ctrl/Cmd + Z">
          <Button size="small" disabled={!undoCount} icon={<Undo2 size={13} />} onClick={undo}>
          撤销
          </Button>
        </Tooltip>
        <Tooltip title="Ctrl/Cmd + Shift + Z 或 Ctrl/Cmd + Y">
          <Button size="small" disabled={!redoCount} icon={<Redo2 size={13} />} onClick={redo}>
            重做
          </Button>
        </Tooltip>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8c8c8c' }}>B 涂抹 · E 橡皮 · [ ] 笔刷</span>
      </div>
      <div style={{ position: 'relative', overflow: 'auto', maxHeight: '60vh', minHeight: 260, padding: 12, background: '#181818', overscrollBehavior: 'contain' }} onWheel={(event) => {
        event.preventDefault()
        changeZoom(event.deltaY < 0 ? 0.1 : -0.1)
      }}>
        <div style={{ textAlign: 'center', minWidth: '100%' }}>
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '60vh', transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
          <img
            ref={imageRef}
            src={src}
            alt="mask source"
            onLoad={resetCanvases}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh', userSelect: 'none' }}
          />
          <canvas
            ref={paintRef}
            onPointerDown={markPoint}
            onPointerMove={drawLine}
            onPointerUp={(event) => {
              drawingRef.current = false
              lastPointRef.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              drawingRef.current = false
              lastPointRef.current = null
            }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
          />
          <canvas ref={maskRef} hidden />
        </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <Button size="small" icon={<ZoomOut size={13} />} onClick={() => changeZoom(-0.1)} disabled={zoom <= 1} />
        <span style={{ width: 42, textAlign: 'center', fontSize: 12 }}>{Math.round(zoom * 100)}%</span>
        <Button size="small" icon={<ZoomIn size={13} />} onClick={() => changeZoom(0.1)} disabled={zoom >= 3} />
        <span style={{ fontSize: 12 }}>笔刷大小</span>
        <Slider min={4} max={72} value={brushSize} onChange={setBrushSize} style={{ flex: 1 }} />
        <span style={{ width: 36, textAlign: 'right', fontSize: 12 }}>{brushSize}px</span>
      </div>
    </Modal>
  )
}

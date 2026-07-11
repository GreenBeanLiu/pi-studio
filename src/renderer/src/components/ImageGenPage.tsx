import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Button, Input, Popconfirm, Spin, Switch, Tooltip, App as AntApp } from 'antd'
import {
  Image as ImageIcon,
  Cloud,
  Monitor,
  Download,
  Link2,
  RefreshCw,
  Brush,
  Trash2,
  X,
} from 'lucide-react'
import {
  api,
  type ImageGenEngine,
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
    display: flex;
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
  `,
  panel: css`
    width: 360px;
    flex-shrink: 0;
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
  baseChip: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px dashed ${token.colorPrimaryBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorPrimaryBg};
    font-size: 13px;
    color: ${token.colorPrimaryText};

    img {
      width: 40px;
      height: 40px;
      object-fit: cover;
      border-radius: 4px;
    }
  `,
  gallery: css`
    flex: 1;
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
    overflow: auto;
    background: rgba(0, 0, 0, 0.7);
    cursor: zoom-out;
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
  `,
  lightboxImgZoomed: css`
    max-width: none;
    max-height: none;
    margin: auto;
    cursor: zoom-out;
    border-radius: 0;
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
  const [comfyBusy, setComfyBusy] = useState(false)
  const [history, setHistory] = useState<ImageGenHistoryItem[]>([])
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([])
  const [pending, setPending] = useState<PendingGen[]>([])
  const [baseImage, setBaseImage] = useState<string | null>(null) // 改图底图 URL
  const [pinnedSrc, setPinnedSrc] = useState<string | null>(null)
  const [pinnedScale, setPinnedScale] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [historyDone, setHistoryDone] = useState(false)

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
        ...(refUrls ? { referenceUrls: refUrls } : {}),
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
    setPrompt('')
    message.info('已设为底图,输入修改要求后点"修改这张图"')
  }

  function openLightbox(src: string) {
    setPinnedSrc(src)
    setPinnedScale(1)
  }
  function closeLightbox() {
    setPinnedSrc(null)
    setPinnedScale(1)
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

        {baseImage && (
          <div className={styles.baseChip}>
            <img src={baseImage} alt="base" />
            <span style={{ flex: 1 }}>基于这张图修改</span>
            <Button
              size="small"
              type="text"
              icon={<X size={13} />}
              onClick={() => setBaseImage(null)}
            />
          </div>
        )}

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
            setPinnedScale((scale) => Math.min(4, Math.max(1, scale + (e.deltaY < 0 ? 0.15 : -0.15))))
          }}
        >
          <img
            src={pinnedSrc}
            alt="preview"
            className={pinnedScale > 1 ? `${styles.lightboxImg} ${styles.lightboxImgZoomed}` : styles.lightboxImg}
            style={{ transform: `scale(${pinnedScale})` }}
            onClick={(e) => {
              e.stopPropagation()
              setPinnedScale((scale) => (scale > 1 ? 1 : 2))
            }}
          />
        </div>
      )}
    </div>
  )
}

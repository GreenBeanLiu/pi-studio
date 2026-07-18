import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Button, Input, Modal, Popconfirm, Slider, Spin, Switch, Tabs, Tooltip, App as AntApp } from 'antd'
import {
  Image as ImageIcon,
  Download,
  Link2,
  RefreshCw,
  Brush,
  Eraser,
  Redo2,
  Sparkles,
  ChevronDown,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Copy,
} from 'lucide-react'
import {
  api,
  type ImageGenEngine,
  type ImageGenSize,
  type GeminiImageAspectRatio,
  type GeminiImageResolution,
  type ImageGenQuality,
  type ImageGenBackground,
  type ImageGenOutputFormat,
  type ImageGenModeration,
  type ImageGenResponseFormat,
  type ImageGenHealth,
  type ImageGenHistoryItem,
} from '../lib/api'

const PROMPT_MAX = 500

/** 示例 Prompt(podgen 式折叠列表,点了直接填入)。 */
const EXAMPLE_PROMPTS = [
  '一座雪山下的湖泊,清晨薄雾,电影感光线',
  '可爱的橘猫宇航员,厚涂插画,星空背景',
  'a cozy coffee shop interior, warm light, watercolor style',
  '中国山水画风格的竹林,留白构图,水墨',
  'cyberpunk city street at night, neon signs, rain reflections',
]

const SIZE_OPTIONS: { id: ImageGenSize; label: string }[] = [
  { id: '256x256', label: '256×256' },
  { id: '512x512', label: '512×512' },
  { id: '1024x1024', label: '1024×1024' },
  { id: '1024x1536', label: '1024×1536' },
  { id: '1536x1024', label: '1536×1024' },
  { id: '1024x1792', label: '1024×1792' },
  { id: '1792x1024', label: '1792×1024' },
  { id: 'auto', label: 'auto' },
]

const GEMINI_ASPECT_OPTIONS: { id: GeminiImageAspectRatio }[] = [
  { id: '1:1' },
  { id: '2:3' },
  { id: '3:2' },
  { id: '3:4' },
  { id: '4:3' },
  { id: '4:5' },
  { id: '5:4' },
  { id: '9:16' },
  { id: '16:9' },
  { id: '21:9' },
]

const GEMINI_RESOLUTION_OPTIONS: GeminiImageResolution[] = ['1K', '2K', '4K']

function sizeGlyphDimensions(value: ImageGenSize | GeminiImageAspectRatio) {
  const separator = value.includes('x') ? 'x' : ':'
  const [rawWidth, rawHeight] = value.split(separator).map(Number)
  if (!rawWidth || !rawHeight) return null

  const resolutionScale = value === '256x256' ? 0.7 : value === '512x512' ? 0.85 : 1
  const maxWidth = 30 * resolutionScale
  const maxHeight = 24 * resolutionScale
  const scale = Math.min(maxWidth / rawWidth, maxHeight / rawHeight)
  return {
    width: Math.max(8, Math.round(rawWidth * scale)),
    height: Math.max(8, Math.round(rawHeight * scale)),
  }
}

function SizeGlyph({ value }: { value: ImageGenSize | GeminiImageAspectRatio }) {
  const dimensions = sizeGlyphDimensions(value)
  return (
    <span className="sizeGlyph" aria-hidden="true">
      {dimensions
        ? <span className="sizeGlyphFrame" style={dimensions} />
        : <span className="sizeGlyphAuto">↔</span>}
    </span>
  )
}

const QUALITY_OPTIONS: ImageGenQuality[] = ['low', 'medium', 'high', 'auto', 'standard', 'hd']

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
  sectionLabel: css`
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
  `,
  dropzone: css`
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadiusLG}px;
    padding: 22px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: ${token.colorTextTertiary};
    font-size: 13px;
    transition: border-color 0.15s;
    text-align: center;
    &:hover {
      border-color: ${token.colorPrimary};
      color: ${token.colorTextSecondary};
    }
    .hint {
      font-size: 11px;
      color: ${token.colorTextQuaternary};
    }
  `,
  orDivider: css`
    display: flex;
    align-items: center;
    gap: 12px;
    color: ${token.colorTextQuaternary};
    font-size: 11px;
    &::before,
    &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: ${token.colorBorderSecondary};
    }
  `,
  labelRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    .count {
      font-size: 11px;
      font-family: monospace;
      color: ${token.colorTextQuaternary};
    }
    .count.near {
      color: ${token.colorError};
    }
  `,
  exampleToggle: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    border: none;
    background: transparent;
    padding: 2px 0;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    &:hover {
      color: ${token.colorTextSecondary};
    }
    svg {
      transition: transform 0.15s;
    }
    svg.open {
      transform: rotate(180deg);
    }
  `,
  exampleItem: css`
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 4px 8px;
    border-radius: ${token.borderRadius}px;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &:hover {
      background: ${token.colorFillQuaternary};
      color: ${token.colorTextSecondary};
    }
  `,
  styleChip: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
    font-size: 12px;
    color: ${token.colorTextSecondary};
    cursor: pointer;
    transition: all 0.15s;
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    &:hover {
      color: ${token.colorText};
      border-color: ${token.colorBorder};
    }
  `,
  optionGrid: css`
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  `,
  optionBtn: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
    font-size: 12px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
    cursor: pointer;
    transition: all 0.15s;
    .icon {
      font-size: 14px;
      line-height: 1;
    }
    &:hover:not(:disabled) {
      color: ${token.colorText};
    }
    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `,
  optionBtnActive: css`
    border-color: ${token.colorPrimary} !important;
    background: ${token.colorPrimaryBg} !important;
    color: ${token.colorPrimary} !important;
  `,
  sizeOptionGrid: css`
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  `,
  sizeOption: css`
    height: 58px;
    justify-content: center;
    min-width: 0;
    gap: 2px;
    padding: 5px 3px;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    .sizeGlyph {
      width: 32px;
      height: 25px;
      display: grid;
      place-items: center;
      color: currentColor;
    }
    .sizeGlyphFrame {
      display: block;
      box-sizing: border-box;
      border: 1.5px solid currentColor;
      border-radius: 2px;
    }
    .sizeGlyphAuto {
      font-size: 22px;
      font-weight: 400;
      line-height: 1;
    }
    &:hover:not(:disabled) {
      transform: scale(1.03);
      position: relative;
      z-index: 1;
    }
  `,
  advancedToggle: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: ${token.colorTextTertiary};
    font-size: 12px;
    cursor: pointer;
    &:hover { color: ${token.colorTextSecondary}; }
    svg { transition: transform 0.15s; }
    svg.open { transform: rotate(180deg); }
  `,
  advancedGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  `,
  advancedField: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    color: ${token.colorTextTertiary};
    font-size: 11px;
    select, input {
      width: 100%;
      min-width: 0;
      height: 30px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadius}px;
      padding: 0 8px;
      color: ${token.colorTextSecondary};
      background: ${token.colorFillQuaternary};
      outline: none;
    }
    select:focus, input:focus { border-color: ${token.colorPrimary}; }
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
    /* 关键:panel 是 flex column + overflow,不禁 shrink 的话内容一多预览会被压成一条细线 */
    flex-shrink: 0;
    border-radius: ${token.borderRadiusLG}px;
    overflow: hidden;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      cursor: zoom-in;
    }
  `,
  basePreviewTopLeft: css`
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11px;
    background: rgba(0, 0, 0, 0.55);
    color: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(4px);
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
    overflow: hidden;
    cursor: zoom-in;
    background: ${token.colorFillTertiary};

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.18s ease;
    }
    &:hover img {
      transform: scale(1.08);
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
    cursor: text;
    min-height: 36px;
    word-break: break-word;
    user-select: text;
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
  const { styles, cx } = useStyles()
  const { message } = AntApp.useApp()

  const [health, setHealth] = useState<ImageGenHealth | null>(null)
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<ImageGenEngine>('comfy')
  const [size, setSize] = useState<ImageGenSize>('1024x1024')
  const [geminiAspectRatio, setGeminiAspectRatio] = useState<GeminiImageAspectRatio>('1:1')
  const [geminiImageSize, setGeminiImageSize] = useState<GeminiImageResolution>('1K')
  const [count, setCount] = useState(1)
  const [quality, setQuality] = useState<ImageGenQuality>('auto')
  const [background, setBackground] = useState<ImageGenBackground>('auto')
  const [outputFormat, setOutputFormat] = useState<ImageGenOutputFormat>('png')
  const [outputCompression, setOutputCompression] = useState(90)
  const [moderation, setModeration] = useState<ImageGenModeration>('auto')
  const [responseFormat, setResponseFormat] = useState<ImageGenResponseFormat>('b64_json')
  const [requestUser, setRequestUser] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [comfyBusy, setComfyBusy] = useState(false)
  const [history, setHistory] = useState<ImageGenHistoryItem[]>([])
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([])
  const [pending, setPending] = useState<PendingGen[]>([])
  const [baseImage, setBaseImage] = useState<string | null>(null) // 改图底图 URL
  // 底图选定后立刻后台传 R2:预览可打开公网原图,生成时免每次重传 base64
  const [refUpload, setRefUpload] = useState<
    { status: 'idle' } | { status: 'uploading' } | { status: 'done'; url: string } | { status: 'error'; error: string }
  >({ status: 'idle' })
  const refUploadForRef = useRef<string | null>(null) // 当前上传属于哪张底图(防替换竞态)
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
      if ((prev === 'openai' || prev === 'gemini') && !h.keyConfigured && h.comfy) return 'comfy'
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
        if (s.imageEngine === 'comfy' || s.imageEngine === 'openai' || s.imageEngine === 'gemini') setEngine(s.imageEngine)
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
    if (!text || pending.length >= 4) return
    const isEdit = !!baseImage
    // 出图数量:改图固定 1 张;并发总量封顶 4
    const n = isEdit ? 1 : Math.min(count, 4 - pending.length)
    if (engine === 'openai' || engine === 'gemini') {
      void generateOne(text, isEdit, n)
      return
    }
    for (let i = 0; i < n; i++) void generateOne(text, isEdit)
  }

  async function generateOne(text: string, isEdit: boolean, n = 1) {
    const full = text
    // 云端引擎优先用已传好的 R2 地址(免每次生成重传 base64);本地 ComfyUI 仍要 dataURL
    const refSource =
      engine !== 'comfy' && refUpload.status === 'done' ? refUpload.url : baseImage
    const refUrls = baseImage && refSource ? [refSource] : undefined

    // 任务进历史区转圈,按钮立即释放,可连续下多个任务
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const engineTag =
      engine === 'comfy'
        ? (isEdit ? 'comfy-edit' : 'comfy')
        : engine === 'gemini'
          ? (isEdit ? 'gemini-edit' : 'gemini')
          : (isEdit ? 'cloud-edit' : 'cloud')
    setPending((p) => [{ key, prompt: text, engine: engineTag }, ...p])

    try {
      const r = await api.imageGen.generate({
        prompt: full,
        engine,
        // 尺寸仅云端 gpt-image-2 生效;本地 ComfyUI 由 workflow 固定
        ...(engine === 'openai'
          ? {
              size,
              n,
              quality,
              ...(advancedOpen
                ? {
                    background,
                    outputFormat,
                    ...(outputFormat !== 'png' ? { outputCompression } : {}),
                    moderation,
                    responseFormat,
                    ...(requestUser.trim() ? { user: requestUser.trim() } : {}),
                  }
                : {}),
            }
          : engine === 'gemini'
            ? {
                model: 'gemini-3-pro-image-preview',
                n,
                aspectRatio: geminiAspectRatio,
                imageSize: geminiImageSize,
              }
          : {}),
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

  function downloadDataUrl(src: string, extension = 'png') {
    const a = document.createElement('a')
    a.href = src
    a.download = `pi-image-${Date.now()}.${extension}`
    a.click()
  }

  function imageExtension(contentType: string) {
    if (contentType.includes('jpeg')) return 'jpg'
    if (contentType.includes('webp')) return 'webp'
    return 'png'
  }

  async function downloadUrl(url: string) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const obj = URL.createObjectURL(blob)
      downloadDataUrl(obj, imageExtension(blob.type))
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
    if (baseImage === item.url) clearBaseImage()
  }

  function useAsBase(url: string) {
    setBaseImage(url)
    setMaskDataUrl(null)
    setPrompt('')
    // 历史图本身就是 R2 公网地址,无需再传
    refUploadForRef.current = url
    setRefUpload({ status: 'done', url })
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
      const dataUrl = reader.result
      setBaseImage(dataUrl)
      setMaskDataUrl(null)
      setPrompt('')
      // 后台传 R2(需云端中继已配置);失败不阻塞——生成时走原有的 base64 兜底上传
      refUploadForRef.current = dataUrl
      if (health?.keyConfigured) {
        setRefUpload({ status: 'uploading' })
        void api.imageGen
          .uploadReference(dataUrl)
          .then((r) => {
            if (refUploadForRef.current !== dataUrl) return // 已换图,丢弃过期结果
            setRefUpload('error' in r ? { status: 'error', error: r.error } : { status: 'done', url: r.url })
          })
          .catch((err: unknown) => {
            // IPC 本身失败(如 handler 缺失)也不能让徽标卡在"上传中"
            if (refUploadForRef.current !== dataUrl) return
            setRefUpload({ status: 'error', error: err instanceof Error ? err.message : String(err) })
          })
      } else {
        setRefUpload({ status: 'idle' })
      }
    }
    reader.onerror = () => message.error('读取图片失败')
    reader.readAsDataURL(file)
  }

  function clearBaseImage() {
    setBaseImage(null)
    setMaskDataUrl(null)
    setRefUpload({ status: 'idle' })
    refUploadForRef.current = null
  }

  const engineLabel = (e: string) =>
    e.startsWith('gemini') ? 'Gemini' : e.startsWith('cloud') ? 'GPT' : e.startsWith('comfy') ? 'SDXL' : e
  const historyTag = (engineName: string, provider: string | null) => {
    const providerName = provider === 'three-a' ? '3A' : provider === 'tikhub' ? 'TikHub' : provider
    return providerName ? `${engineLabel(engineName)} · ${providerName}` : engineLabel(engineName)
  }
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

  async function copyPrompt(value: string) {
    try {
      await api.clipboard.writeText(value)
      message.success('提示词已复制')
    } catch {
      message.error('复制提示词失败')
    }
  }

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
        <Tabs
          size="small"
          activeKey={engine}
          onChange={(value) => {
            const nextEngine = value as ImageGenEngine
            if (nextEngine === 'gemini') {
              setMaskDataUrl(null)
              setMaskEditorOpen(false)
            }
            setEngine(nextEngine)
          }}
          items={[
            { key: 'openai', label: 'GPT Image 2', disabled: !health?.keyConfigured },
            { key: 'comfy', label: 'SDXL 生图' },
            { key: 'gemini', label: 'Gemini Image', disabled: !health?.keyConfigured },
          ]}
        />
        <span className={styles.sectionLabel}>上传图片(改图)</span>
        <div
          className={styles.dropzone}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            handleReferenceUpload(e.dataTransfer.files?.[0])
          }}
        >
          <ImageIcon size={22} strokeWidth={1.5} />
          <div>{baseImage ? '更换修改底图' : '拖拽或点击上传图片作为修改底图'}</div>
          <div className="hint">支持 PNG / JPG / WebP</div>
        </div>

        {baseImage && (
          <div className={styles.basePreview}>
            <img src={baseImage} alt="base" onClick={() => openLightbox(baseImage)} />
            {refUpload.status === 'uploading' && (
              <div className={styles.basePreviewTopLeft}>
                <Spin size="small" />
                上传 R2 中…
              </div>
            )}
            {refUpload.status === 'done' && (
              <Tooltip title="已存入 R2,点击打开公网原图">
                <div
                  className={styles.basePreviewTopLeft}
                  style={{ cursor: 'pointer' }}
                  onClick={() => window.open(refUpload.url, '_blank')}
                >
                  <Link2 size={11} />
                  R2 ✓
                </div>
              </Tooltip>
            )}
            {refUpload.status === 'error' && (
              <Tooltip title={`R2 上传失败:${refUpload.error};不影响生成,会在生成时重试`}>
                <div className={styles.basePreviewTopLeft} style={{ color: '#ffb020' }}>
                  上传失败
                </div>
              </Tooltip>
            )}
            <div className={styles.basePreviewTopRight}>
              <Button size="small" icon={<X size={13} />} onClick={clearBaseImage} />
            </div>
            <div className={styles.basePreviewBottomLeft}>
              {engine !== 'gemini' && <Button
                size="small"
                type="primary"
                icon={<Brush size={13} />}
                onClick={() => setMaskEditorOpen(true)}
              >
                涂抹重绘
              </Button>}
              {engine !== 'gemini' && maskDataUrl && (
                <Button size="small" onClick={() => setMaskDataUrl(null)}>
                  清除蒙版
                </Button>
              )}
            </div>
          </div>
        )}

        {!baseImage && <div className={styles.orDivider}>or</div>}

        <div className={styles.labelRow}>
          <span className={styles.sectionLabel}>
            {baseImage ? '描述怎么修改这张图' : 'Prompt 描述'}
          </span>
          <span className={`count${prompt.length > PROMPT_MAX - 100 ? ' near' : ''}`}>
            {prompt.length} / {PROMPT_MAX}
          </span>
        </div>
        <Input.TextArea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
          placeholder={
            baseImage
              ? '例如:改成夜晚场景 / 把背景换成雪山 / make it watercolor style'
              : '描述你想要的图案,支持中英文…'
          }
          autoSize={{ minRows: 5, maxRows: 10 }}
        />
        <div>
          <button
            type="button"
            className={styles.exampleToggle}
            onClick={() => setExamplesOpen((v) => !v)}
          >
            <span>示例 Prompt</span>
            <ChevronDown size={13} className={examplesOpen ? 'open' : ''} />
          </button>
          {examplesOpen &&
            EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                className={styles.exampleItem}
                onClick={() => {
                  setPrompt(p)
                  setExamplesOpen(false)
                }}
              >
                <Sparkles size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                {p}
              </button>
            ))}
        </div>

        {engine === 'openai' && (
          <>
            <span className={styles.sectionLabel}>尺寸</span>
            <div className={cx(styles.optionGrid, styles.sizeOptionGrid)}>
              {SIZE_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cx(styles.optionBtn, styles.sizeOption, size === s.id && styles.optionBtnActive)}
                  onClick={() => setSize(s.id)}
                >
                  <SizeGlyph value={s.id} />
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}

        {engine === 'gemini' && (
          <>
            <span className={styles.sectionLabel}>画幅比例</span>
            <div className={cx(styles.optionGrid, styles.sizeOptionGrid)}>
              {GEMINI_ASPECT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={cx(styles.optionBtn, styles.sizeOption, geminiAspectRatio === option.id && styles.optionBtnActive)}
                  onClick={() => setGeminiAspectRatio(option.id)}
                >
                  <SizeGlyph value={option.id} />
                  {option.id}
                </button>
              ))}
            </div>
            <span className={styles.sectionLabel}>分辨率</span>
            <div className={styles.optionGrid}>
              {GEMINI_RESOLUTION_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cx(styles.optionBtn, geminiImageSize === option && styles.optionBtnActive)}
                  onClick={() => setGeminiImageSize(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </>
        )}

        {engine === 'openai' && (
          <>
            <span className={styles.sectionLabel}>质量</span>
            <div className={styles.chips}>
              {QUALITY_OPTIONS.map((option) => {
                const active = quality === option
                return (
                  <button
                    key={option}
                    type="button"
                    className={styles.styleChip}
                    style={active ? { background: '#1677ff', borderColor: '#1677ff', color: '#fff' } : undefined}
                    onClick={() => setQuality(option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {engine === 'openai' && (
          <div>
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>GPT Image 2 高级参数</span>
              <ChevronDown size={13} className={advancedOpen ? 'open' : ''} />
            </button>
            {advancedOpen && (
              <div className={styles.advancedGrid} style={{ marginTop: 8 }}>
                <label className={styles.advancedField}>
                  背景
                  <select value={background} onChange={(e) => setBackground(e.target.value as ImageGenBackground)}>
                    <option value="auto">auto</option>
                    <option value="transparent">transparent</option>
                    <option value="opaque">opaque</option>
                  </select>
                </label>
                <label className={styles.advancedField}>
                  输出格式
                  <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as ImageGenOutputFormat)}>
                    <option value="png">png</option>
                    <option value="jpeg">jpeg</option>
                    <option value="webp">webp</option>
                  </select>
                </label>
                <label className={styles.advancedField}>
                  压缩 0–100
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={outputFormat === 'png'}
                    value={outputCompression}
                    onChange={(e) => setOutputCompression(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  />
                </label>
                <label className={styles.advancedField}>
                  审核
                  <select value={moderation} onChange={(e) => setModeration(e.target.value as ImageGenModeration)}>
                    <option value="auto">auto</option>
                    <option value="low">low</option>
                  </select>
                </label>
                <label className={styles.advancedField}>
                  响应格式
                  <select value={responseFormat} onChange={(e) => setResponseFormat(e.target.value as ImageGenResponseFormat)}>
                    <option value="b64_json">b64_json</option>
                    <option value="url">url</option>
                  </select>
                </label>
                <label className={styles.advancedField}>
                  用户标识（可选）
                  <input
                    maxLength={64}
                    value={requestUser}
                    placeholder="例如 pi-studio-user"
                    onChange={(e) => setRequestUser(e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        )}

        <span className={styles.sectionLabel}>
          出图数量
          {baseImage && <span style={{ opacity: 0.6, textTransform: 'none' }}> · 改图固定 1 张</span>}
        </span>
        <div className={styles.optionGrid}>
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={cx(styles.optionBtn, count === n && styles.optionBtnActive)}
              disabled={!!baseImage}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {engine === 'comfy' && <>
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
        </>}

        <Tooltip title="重新检测服务状态">
          <Button size="small" icon={<RefreshCw size={13} />} onClick={refreshHealth} />
        </Tooltip>

        {!serviceUp && !comfyBusy && (
          <div className={styles.offline}>没有可用引擎——打开上面的 ComfyUI 开关即可。</div>
        )}

        <Button
          type="primary"
          size="large"
          icon={<Sparkles size={15} />}
          disabled={!canGenerate}
          onClick={generate}
        >
          {baseImage ? '修改这张图' : `生成图片${count > 1 ? ` ×${count}` : ''}`}
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
                    <Tooltip title="复制提示词">
                      <Button {...iconBtn} icon={<Copy size={13} />} onClick={() => void copyPrompt(s.prompt)} />
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))}

            {history.map((h) => (
              <div key={h.id} className={styles.card}>
                <div className={styles.cardImage} onClick={() => openLightbox(h.url)}>
                  <img src={h.url} alt={h.prompt} loading="lazy" />
                  <span className={styles.histTag}>{historyTag(h.engine, h.provider)}</span>
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
                    <Tooltip title="复制提示词">
                      <Button {...iconBtn} icon={<Copy size={13} />} onClick={() => void copyPrompt(h.prompt)} />
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

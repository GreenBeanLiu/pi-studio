import { useEffect, useState } from 'react'
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

/** 当前预览:刚生成的图(dataUrl)或历史里的图(url)。 */
type Current = {
  src: string
  publicUrl: string | null
  prompt: string
  historyId?: string
}

/** 进行中的生成任务,在历史区占一个转圈的格子。 */
type PendingGen = { key: string; prompt: string; engine: string }

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
  preview: css`
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
  stage: css`
    flex: 1;
    min-height: 320px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};

    img {
      max-width: 100%;
      max-height: 100%;
      border-radius: ${token.borderRadius}px;
    }
  `,
  empty: css`
    color: ${token.colorTextQuaternary};
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  `,
  actions: css`
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  `,
  historyGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 8px;
  `,
  historyCell: css`
    position: relative;
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    cursor: pointer;
    border: 2px solid transparent;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    &:hover {
      border-color: ${token.colorPrimary};
    }
  `,
  pendingCell: css`
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    border: 1px dashed ${token.colorPrimaryBorder};
    background: ${token.colorFillTertiary};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px;

    span.pending-label {
      font-size: 11px;
      color: ${token.colorTextTertiary};
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  histTag: css`
    position: absolute;
    left: 4px;
    bottom: 4px;
    font-size: 11px;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
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
  const [current, setCurrent] = useState<Current | null>(null)
  const [history, setHistory] = useState<ImageGenHistoryItem[]>([])
  const [pending, setPending] = useState<PendingGen[]>([])
  const [baseImage, setBaseImage] = useState<string | null>(null) // 改图底图 URL

  async function refreshHealth() {
    const h = await api.imageGen.health()
    setHealth(h)
    setEngine((prev) => {
      if (prev === 'comfy' && !h.comfy && h.keyConfigured) return 'openai'
      if (prev === 'openai' && !h.keyConfigured && h.comfy) return 'comfy'
      return prev
    })
  }

  async function refreshHistory() {
    const r = await api.imageGen.history()
    if (Array.isArray(r)) setHistory(r)
  }

  useEffect(() => {
    refreshHealth()
    refreshHistory()
  }, [])

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
      setCurrent({ src: r.dataUrl, publicUrl: r.publicUrl, prompt: text })
      await refreshHistory()
    } finally {
      setPending((p) => p.filter((x) => x.key !== key))
    }
  }

  function download() {
    if (!current) return
    const a = document.createElement('a')
    a.href = current.src
    a.download = `pi-image-${Date.now()}.png`
    a.click()
  }

  async function deleteHistoryItem(item: ImageGenHistoryItem) {
    const r = await api.imageGen.historyDelete(item.id)
    if (!r.ok) {
      message.error('删除失败')
      return
    }
    setHistory((h) => h.filter((x) => x.id !== item.id))
    if (current?.historyId === item.id) setCurrent(null)
    if (baseImage === item.url) setBaseImage(null)
  }

  const engineLabel = (e: string) =>
    e.startsWith('cloud') ? '云' : e.startsWith('comfy') ? '本' : e
  const canGenerate =
    pending.length < 3 &&
    !!prompt.trim() &&
    (engine === 'comfy' ? !!health?.comfy : !!health?.keyConfigured)

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
              本地 SDXL
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

      <section className={styles.preview}>
        <div className={styles.stage}>
          {current ? (
            <img src={current.src} alt={current.prompt} title={current.prompt} />
          ) : (
            <div className={styles.empty}>
              <ImageIcon size={40} strokeWidth={1.2} />
              {pending.length > 0
                ? `${pending.length} 个任务生成中…(本地约 10~20 秒,云端约 30~60 秒)`
                : '生成的图会显示在这里,下面是历史记录'}
            </div>
          )}
        </div>

        {current && (
          <div className={styles.actions}>
            <Button icon={<Download size={13} />} onClick={download}>
              下载 PNG
            </Button>
            {current.publicUrl && (
              <Button
                icon={<Link2 size={13} />}
                onClick={() => {
                  navigator.clipboard.writeText(current.publicUrl!)
                  message.success('已复制公网链接')
                }}
              >
                复制链接
              </Button>
            )}
            {current.publicUrl && (
              <Button
                icon={<Brush size={13} />}
                onClick={() => {
                  setBaseImage(current.publicUrl)
                  setPrompt('')
                  message.info('已设为底图,输入修改要求后点"修改这张图"')
                }}
              >
                以此图修改
              </Button>
            )}
          </div>
        )}

        {(history.length > 0 || pending.length > 0) && (
          <>
            <span className={styles.label}>
              历史记录({history.length}
              {pending.length > 0 ? ` · ${pending.length} 个生成中` : ''})
            </span>
            <div className={styles.historyGrid}>
              {pending.map((p) => (
                <div key={p.key} className={styles.pendingCell} title={p.prompt}>
                  <Spin size="small" />
                  <span className="pending-label">{p.prompt}</span>
                  <span className="pending-label">{engineLabel(p.engine)}·生成中</span>
                </div>
              ))}
              {history.map((h) => (
                <div
                  key={h.id}
                  className={styles.historyCell}
                  title={h.prompt}
                  onClick={() =>
                    setCurrent({ src: h.url, publicUrl: h.url, prompt: h.prompt, historyId: h.id })
                  }
                >
                  <img src={h.url} alt={h.prompt} loading="lazy" />
                  <span className={styles.histTag}>{engineLabel(h.engine)}</span>
                  <Popconfirm
                    title="删除这条记录?"
                    onConfirm={(e) => {
                      e?.stopPropagation()
                      deleteHistoryItem(h)
                    }}
                    onPopupClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<Trash2 size={12} />}
                      style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.4)' }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

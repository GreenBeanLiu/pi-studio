import { useEffect, useState } from 'react'
import { createStyles } from 'antd-style'
import { Button, Input, Tooltip, App as AntApp } from 'antd'
import { Image as ImageIcon, Cloud, Monitor, Download, Link2, RefreshCw } from 'lucide-react'
import { api, type ImageGenEngine, type ImageGenHealth } from '../lib/api'

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

type HistoryItem = { dataUrl: string; publicUrl: string | null; prompt: string }

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
    width: 340px;
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
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,
  chips: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    min-height: 0;
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
    font-size: 13px;
  `,
  actions: css`
    display: flex;
    gap: 8px;
    justify-content: center;
  `,
  history: css`
    display: flex;
    gap: 8px;
    flex-wrap: wrap;

    img {
      width: 64px;
      height: 64px;
      object-fit: cover;
      border-radius: ${token.borderRadius}px;
      cursor: pointer;
      border: 2px solid transparent;
      &:hover {
        border-color: ${token.colorPrimary};
      }
    }
  `,
  offline: css`
    color: ${token.colorWarning};
    font-size: 12px;
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
  const [loading, setLoading] = useState(false)
  const [current, setCurrent] = useState<HistoryItem | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])

  async function refreshHealth() {
    const h = await api.imageGen.health()
    setHealth(h)
    // 默认引擎:本地可用优先本地(免费),否则云端
    setEngine((prev) => {
      if (prev === 'comfy' && !h.comfy && h.keyConfigured) return 'openai'
      if (prev === 'openai' && !h.keyConfigured && h.comfy) return 'comfy'
      return prev
    })
  }

  useEffect(() => {
    refreshHealth()
  }, [])

  const serviceUp = health?.ok ?? false

  async function generate() {
    const text = prompt.trim()
    if (!text || loading) return
    const preset = STYLE_PRESETS.find((p) => p.id === presetId)
    const full = preset?.suffix
      ? `${text}, ${preset.suffix}. High quality, sharp, no watermark, no text.`
      : `${text}. High quality, sharp, no watermark, no text.`

    setLoading(true)
    try {
      const r = await api.imageGen.generate({ prompt: full, engine })
      if ('error' in r) {
        message.error(r.error)
        return
      }
      const item: HistoryItem = { ...r, prompt: text }
      setCurrent(item)
      setHistory((h) => [item, ...h].slice(0, 12))
    } finally {
      setLoading(false)
    }
  }

  function download() {
    if (!current) return
    const a = document.createElement('a')
    a.href = current.dataUrl
    a.download = `pi-image-${Date.now()}.png`
    a.click()
  }

  return (
    <div className={styles.page}>
      <section className={styles.panel}>
        <span className={styles.label}>描述你想要的图</span>
        <Input.TextArea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例如:一座雪山下的湖泊,晨雾 / a cyberpunk city street at night"
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

        <span className={styles.label}>引擎</span>
        <div className={styles.chips}>
          <Tooltip title={health?.keyConfigured ? '' : '图像服务未配置云端 API Key'}>
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
          <Tooltip title={health?.comfy ? '' : 'ComfyUI 未运行(127.0.0.1:8188)'}>
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

        {!serviceUp && (
          <div className={styles.offline}>
            没有可用引擎。启动本地 ComfyUI 即可:
            <br />
            D:\Works\ComfyUI&gt; .venv\Scripts\python.exe main.py --port 8188
            <br />
            (云端引擎可选,需 icon-studio 后端在运行)
          </div>
        )}

        <Button
          type="primary"
          loading={loading}
          disabled={!serviceUp || !prompt.trim()}
          onClick={generate}
        >
          {loading ? '生成中…' : '生成'}
        </Button>

        {history.length > 0 && (
          <>
            <span className={styles.label}>本次会话历史</span>
            <div className={styles.history}>
              {history.map((h, i) => (
                <img key={i} src={h.dataUrl} title={h.prompt} onClick={() => setCurrent(h)} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className={styles.preview}>
        <div className={styles.stage}>
          {current ? (
            <img src={current.dataUrl} alt={current.prompt} />
          ) : (
            <div className={styles.empty}>
              <ImageIcon size={40} strokeWidth={1.2} />
              {loading ? '正在生成…(本地引擎约 10~20 秒)' : '生成的图会显示在这里'}
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
                  message.success('已复制 R2 公网链接')
                }}
              >
                复制公网链接
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

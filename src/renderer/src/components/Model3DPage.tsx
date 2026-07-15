import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import {
  Alert,
  Divider,
  App as AntApp,
  Button,
  Empty,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Slider,
  Spin,
  Switch,
  Tooltip,
} from 'antd'
import { Box, Sparkles, Trash2, ImagePlus, X, Wrench } from 'lucide-react'
import { api, type Model3DHistoryItem, type Model3DOptions } from '../lib/api'
import { assessReferenceImage, normalizeReferenceImage } from '../lib/reference-check'
import ModelViewer from './ModelViewer'

const MODEL_VERSIONS = [
  { value: '', label: '默认(最新)' },
  { value: 'v2.5-20250123', label: 'v2.5' },
  { value: 'v2.0-20240919', label: 'v2.0' },
]

const STATUS_TEXT: Record<string, string> = {
  uploading: '上传参考图…',
  submitting: '提交任务…',
  queued: '排队中…',
  running: '生成中…',
  downloading: '下载模型…',
  building: 'agent 建模中…',
  repairing: '报错修复中…',
  exporting: '导出模型…',
  done: '完成',
  error: '失败',
}

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: 30fr 70fr;
    gap: 16px;
    padding: 16px;
    background: ${token.colorBgLayout};
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
    color: ${token.colorText};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  label: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  `,
  dropzone: css`
    position: relative;
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadiusLG}px;
    min-height: 150px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: ${token.colorTextTertiary};
    overflow: hidden;
    &:hover {
      border-color: ${token.colorPrimary};
    }
  `,
  dropImg: css`
    max-width: 100%;
    max-height: 220px;
    object-fit: contain;
  `,
  clearImg: css`
    position: absolute;
    top: 6px;
    right: 6px;
  `,
  right: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  `,
  stage: css`
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  gallery: css`
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 10px;
    max-height: 220px;
    overflow-y: auto;
    padding: 2px;
  `,
  card: css`
    position: relative;
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    border: 2px solid transparent;
    cursor: pointer;
    background: ${token.colorFillQuaternary};
    &:hover .del {
      opacity: 1;
    }
  `,
  cardActive: css`
    border-color: ${token.colorPrimary};
  `,
  thumb: css`
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  thumbFallback: css`
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${token.colorTextQuaternary};
  `,
  del: css`
    position: absolute;
    top: 4px;
    right: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  `,
  scoreBadge: css`
    position: absolute;
    left: 4px;
    bottom: 4px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    color: #fff;
    pointer-events: none;
  `,
  placeholderCard: css`
    position: relative;
    aspect-ratio: 1;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    border: 2px solid ${token.colorPrimaryBorder};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextSecondary};
    font-size: 11px;
    text-align: center;
    padding: 4px;
  `,
}))

/** 还原度配色:≥80 绿 / ≥60 橙 / 其余红 */
function scoreColor(score: number): string {
  return score >= 80 ? '#52c41a' : score >= 60 ? '#faad14' : '#ff4d4f'
}

function Model3DPageInner(): React.JSX.Element {
  const { styles, cx } = useStyles()
  const { message } = AntApp.useApp()

  const [configured, setConfigured] = useState(true)
  const [mode, setMode] = useState<'text' | 'image' | 'code' | 'blender'>('text')
  const [prompt, setPrompt] = useState('')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [refWarnings, setRefWarnings] = useState<string[]>([])
  const [blenderUp, setBlenderUp] = useState<boolean | null>(null)
  const [refineText, setRefineText] = useState('')
  const [opts, setOpts] = useState<Model3DOptions>({ texture: true, pbr: false })
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<{ status: string; progress: number } | null>(null)
  const [history, setHistory] = useState<Model3DHistoryItem[]>([])
  const [selected, setSelected] = useState<Model3DHistoryItem | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api.model3d.health().then((h) => setConfigured(h.configured))
    void api.model3d.history().then((items) => {
      setHistory(items)
      if (items[0]) setSelected(items[0])
    })
    const off = api.model3d.onProgress((data) => setProgress({ status: data.status, progress: data.progress }))
    const offScored = api.model3d.onScored(({ id, fidelity }) => {
      setHistory((prev) => prev.map((it) => (it.id === id ? { ...it, fidelity } : it)))
      setSelected((cur) => (cur?.id === id ? { ...cur, fidelity } : cur))
    })
    return () => {
      off()
      offScored()
    }
  }, [])

  useEffect(() => {
    if (mode === 'blender') void api.model3d.blenderHealth().then(setBlenderUp)
  }, [mode])

  const pickFile = (file: File | null | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setRefWarnings([])
      // 透明底先压平到白底(否则 Tripo 压成黑底重建出黑色面片),预览即所传;
      // 压平过的图背景必然纯白,跳过背景类预检
      void normalizeReferenceImage(reader.result as string).then(async ({ dataUrl, flattened }) => {
        setImageDataUrl(dataUrl)
        const r = await assessReferenceImage(dataUrl, { skipBackground: flattened })
        setRefWarnings(r.warnings)
      })
    }
    reader.readAsDataURL(file)
  }

  const onGenerate = async (): Promise<void> => {
    if (mode !== 'image' && !prompt.trim())
      return void message.warning('请输入描述')
    if (mode === 'image' && !imageDataUrl) return void message.warning('请选择参考图片')
    setGenerating(true)
    setProgress({ status: mode === 'code' || mode === 'blender' ? 'building' : 'submitting', progress: 0 })
    try {
      const res =
        mode === 'blender'
          ? await api.model3d.generateBlender({ prompt })
          : mode === 'code'
          ? await api.model3d.generateCode({ prompt })
          : await api.model3d.generate({
              mode,
              prompt,
              ...(mode === 'image' && imageDataUrl ? { imageDataUrl } : {}),
              options: opts,
            })
      if ('error' in res) {
        message.error(res.error)
      } else {
        setHistory((prev) => [res, ...prev])
        setSelected(res)
        message.success(mode === 'code' || mode === 'blender' ? '模型已生成' : '3D 模型已生成')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  /** 迭代修改选中的代码建模/Blender 模型:以其脚本为起点生成新版本(原模型保留)。 */
  const onRefine = async (): Promise<void> => {
    if (!selected || !refineText.trim()) return void message.warning('请输入修改要求')
    const source = selected
    setGenerating(true)
    setProgress({ status: 'building', progress: 0 })
    try {
      const payload = { prompt: refineText.trim(), sourceId: source.id }
      const res =
        source.mode === 'blender'
          ? await api.model3d.generateBlender(payload)
          : await api.model3d.generateCode(payload)
      if ('error' in res) {
        message.error(res.error)
      } else {
        setHistory((prev) => [res, ...prev])
        setSelected(res)
        setRefineText('')
        message.success('修改版已生成(原模型保留在历史里)')
      }
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    await api.model3d.historyDelete(id)
    setHistory((prev) => {
      const next = prev.filter((it) => it.id !== id)
      setSelected((cur) => (cur?.id === id ? next[0] ?? null : cur))
      return next
    })
  }

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.title}>
          <Box size={18} /> 3D 生成
        </div>

        {!configured && (
          <div style={{ fontSize: 12, color: '#faad14' }}>
            未配置云端中继,请到「设置 → 生图 → 云端中继」填写(3D 生成与生图共用)。
          </div>
        )}

        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as 'text' | 'image' | 'code' | 'blender')}
          options={[
            { label: '文生 3D', value: 'text' },
            { label: '图生 3D', value: 'image' },
            { label: '代码建模', value: 'code' },
            { label: 'Blender', value: 'blender' },
          ]}
        />

        {mode === 'blender' && (
          <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
            由内嵌 agent 驱动本机 Blender(blender-mcp)建模并导出 glb,可用修改器/布尔/倒角等真建模工具。
            {blenderUp === false && (
              <div style={{ color: '#faad14', marginTop: 4 }}>
                连不上 Blender(localhost:9876)——先启动 Blender 并连接 blender-mcp addon。
              </div>
            )}
          </div>
        )}

        {mode === 'code' && (
          <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
            由内嵌 agent 用 three.js 程序化手搓「可动画/可拆解」的代码模型,导出为 glb。
            比 Tripo 慢(数分钟),适合游戏道具、需要绑定交互的场景。
          </div>
        )}

        {mode !== 'image' ? (
          <div className={styles.field}>
            <span className={styles.label}>{mode === 'text' ? '提示词' : '模型描述'}</span>
            <Input.TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === 'code' || mode === 'blender'
                  ? '例如:一个带铰链盖子和金属搭扣的木质宝箱'
                  : '例如:a cute low-poly red mushroom'
              }
              autoSize={{ minRows: 3, maxRows: 6 }}
            />
          </div>
        ) : (
          <div className={styles.field}>
            <span className={styles.label}>参考图片</span>
            <div className={styles.dropzone} onClick={() => fileRef.current?.click()}>
              {imageDataUrl ? (
                <>
                  <img className={styles.dropImg} src={imageDataUrl} alt="reference" />
                  <Button
                    className={styles.clearImg}
                    size="small"
                    icon={<X size={14} />}
                    onClick={(e) => {
                      e.stopPropagation()
                      setImageDataUrl(null)
                      setRefWarnings([])
                    }}
                  />
                </>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <ImagePlus size={26} />
                  <div style={{ marginTop: 6, fontSize: 12 }}>点击选择图片</div>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <span className={styles.label} style={{ fontSize: 12 }}>
              建议:单一主体、白底或透明底、无遮挡,重建效果最好
            </span>
            {refWarnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                title={
                  refWarnings.length === 1 ? (
                    refWarnings[0]
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {refWarnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )
                }
              />
            )}
          </div>
        )}

        {/* Tripo 专属参数,仅云端文生/图生模式显示(代码建模/Blender 用不上) */}
        {(mode === 'text' || mode === 'image') && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>模型版本</span>
              <Select
                value={opts.modelVersion ?? ''}
                onChange={(v) => setOpts((o) => ({ ...o, modelVersion: v || undefined }))}
                options={MODEL_VERSIONS}
              />
            </div>

            <div className={styles.row}>
              <span className={styles.label}>贴图纹理</span>
              <Switch checked={opts.texture ?? true} onChange={(v) => setOpts((o) => ({ ...o, texture: v }))} />
            </div>
            <div className={styles.row}>
              <span className={styles.label}>PBR 材质</span>
              <Switch checked={opts.pbr ?? false} onChange={(v) => setOpts((o) => ({ ...o, pbr: v }))} />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>面数上限(0 = 自动)：{opts.faceLimit ?? 0}</span>
              <Slider
                min={0}
                max={50000}
                step={1000}
                value={opts.faceLimit ?? 0}
                onChange={(v) => setOpts((o) => ({ ...o, faceLimit: v || undefined }))}
              />
            </div>
          </>
        )}

        <Button
          type="primary"
          icon={<Sparkles size={15} />}
          loading={generating}
          disabled={generating}
          onClick={onGenerate}
          block
        >
          生成 3D 模型
        </Button>

        {selected && (selected.mode === 'code' || selected.mode === 'blender') && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div className={styles.field}>
              <span className={styles.label}>修改选中的模型</span>
              <span
                style={{ fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={selected.prompt}
              >
                {selected.prompt}
              </span>
              <Input.TextArea
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                placeholder="例如:盖子再大一点,正面加一把锁"
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                {selected.fidelity?.notes && (
                  <Tooltip title={selected.fidelity.notes}>
                    <Button
                      size="small"
                      onClick={() => setRefineText(`按以下点评改进:${selected.fidelity!.notes}`)}
                    >
                      按 AI 点评修改
                    </Button>
                  </Tooltip>
                )}
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<Wrench size={13} />}
                  loading={generating}
                  disabled={generating || !refineText.trim()}
                  onClick={onRefine}
                  style={{ marginLeft: 'auto' }}
                >
                  生成修改版
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className={styles.right}>
        <div className={styles.stage}>
          {selected ? (
            <ModelViewer
              url={selected.modelUrl}
              downloadUrl={selected.cloudModelUrl ?? null}
              onSnapshot={
                !selected.thumbnailUrl && (selected.mode === 'code' || selected.mode === 'blender')
                  ? async (dataUrl) => {
                      const r = await api.model3d.saveThumbnail({ id: selected.id, dataUrl })
                      if (!('error' in r)) {
                        setHistory((prev) => prev.map((it) => (it.id === r.id ? r : it)))
                        setSelected((cur) => (cur?.id === r.id ? r : cur))
                      }
                    }
                  : undefined
              }
            />
          ) : (
            <Empty description="还没有 3D 模型" image={<Box size={48} strokeWidth={1} />} />
          )}
        </div>

        {(generating || history.length > 0) && (
          <div className={styles.gallery}>
            {generating && (
              <div className={styles.placeholderCard}>
                <Spin size="small" />
                <span>
                  {STATUS_TEXT[progress?.status ?? 'submitting'] ?? '生成中…'}
                  {progress && progress.progress > 0 ? ` ${Math.round(progress.progress)}%` : ''}
                </span>
              </div>
            )}
            {history.map((it) => (
              <div
                key={it.id}
                className={cx(styles.card, selected?.id === it.id && styles.cardActive)}
                onClick={() => setSelected(it)}
                title={it.prompt}
              >
                {it.thumbnailUrl ? (
                  <img className={styles.thumb} src={it.thumbnailUrl} alt={it.prompt} />
                ) : (
                  <div className={styles.thumbFallback}>
                    <Box size={22} />
                  </div>
                )}
                {it.fidelity && (
                  <span
                    className={styles.scoreBadge}
                    style={{ background: scoreColor(it.fidelity.score) }}
                  >
                    {it.fidelity.score}
                  </span>
                )}
                <Popconfirm
                  title="删除这个模型?"
                  onConfirm={(e) => {
                    e?.stopPropagation()
                    void onDelete(it.id)
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Tooltip title="删除">
                    <Button
                      className={cx(styles.del, 'del')}
                      size="small"
                      danger
                      icon={<Trash2 size={13} />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Tooltip>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 项目没有全局 antd App provider,包一层才能用 useApp() 拿 message。 */
export default function Model3DPage(): React.JSX.Element {
  return (
    <AntApp component={false} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
      <Model3DPageInner />
    </AntApp>
  )
}

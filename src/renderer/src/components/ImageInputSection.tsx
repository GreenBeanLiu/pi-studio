import { useRef, useState } from 'react'
import { Button, Input, Spin, Tooltip } from 'antd'
import { createStyles } from 'antd-style'
import { Brush, ChevronDown, Image as ImageIcon, Link2, Sparkles, X } from 'lucide-react'

export type ReferenceUploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; url: string }
  | { status: 'error'; error: string }

const EXAMPLE_PROMPTS = [
  '一座雪山下的湖泊,清晨薄雾,电影感光线',
  '可爱的橘猫宇航员,厚涂插画,星空背景',
  'a cozy coffee shop interior, warm light, watercolor style',
  '中国山水画风格的竹林,留白构图,水墨',
  'cyberpunk city street at night, neon signs, rain reflections',
]

const useStyles = createStyles(({ token, css }) => ({
  section: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  sectionTitle: css`
    font-size: 12px;
    line-height: 18px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
  `,
  dropzone: css`
    min-height: 96px;
    display: grid;
    place-items: center;
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextTertiary};
    cursor: pointer;
    transition: border-color ${token.motionDurationFast}, background ${token.motionDurationFast};
    &:hover,
    &:focus-visible {
      border-color: ${token.colorPrimaryBorder};
      background: ${token.colorPrimaryBg};
      outline: none;
    }
  `,
  dropzoneContent: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
  `,
  preview: css`
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
  `,
  previewImage: css`
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: zoom-in;
  `,
  uploadBadge: css`
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: ${token.colorBgMask};
    color: ${token.colorTextLightSolid};
    font-size: 11px;
  `,
  clearButton: css`
    position: absolute;
    top: 8px;
    right: 8px;
  `,
  maskActions: css`
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    gap: 6px;
  `,
  caption: css`
    display: flex;
    justify-content: space-between;
    color: ${token.colorTextTertiary};
    font-size: 11px;
  `,
  examplesToggle: css`
    display: flex;
    justify-content: space-between;
    padding: 0;
    border: 0;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    &:hover { color: ${token.colorTextSecondary}; }
  `,
  example: css`
    padding: 4px 6px;
    border: 0;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    color: ${token.colorTextSecondary};
    text-align: left;
    cursor: pointer;
    &:hover { background: ${token.colorFillQuaternary}; }
  `,
}))

export default function ImageInputSection({
  prompt,
  promptMax,
  acceptsImage,
  acceptsMask,
  baseImage,
  maskDataUrl,
  upload,
  onPromptChange,
  onFile,
  onPreview,
  onClearImage,
  onEditMask,
  onClearMask,
}: {
  prompt: string
  promptMax: number
  acceptsImage: boolean
  acceptsMask: boolean
  baseImage: string | null
  maskDataUrl: string | null
  upload: ReferenceUploadState
  onPromptChange: (value: string) => void
  onFile: (file?: File) => void
  onPreview: (url: string) => void
  onClearImage: () => void
  onEditMask: () => void
  onClearMask: () => void
}) {
  const { styles } = useStyles()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [examplesOpen, setExamplesOpen] = useState(false)

  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>输入</div>
      {acceptsImage && <>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            onFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        {!baseImage && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click()
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              onFile(event.dataTransfer.files?.[0])
            }}
            className={styles.dropzone}
          >
            <div className={styles.dropzoneContent}>
              <ImageIcon size={22} strokeWidth={1.5} />
              <span>可选：上传参考图片</span>
              <span style={{ fontSize: 11 }}>PNG / JPG / WebP</span>
            </div>
          </div>
        )}
        {baseImage && (
          <div className={styles.preview}>
            <img
              src={baseImage}
              alt="输入图片"
              onClick={() => onPreview(baseImage)}
              className={styles.previewImage}
            />
            <div className={styles.uploadBadge}>
              {upload.status === 'uploading' && <><Spin size="small" />上传中</>}
              {upload.status === 'done' && <span style={{ cursor: 'pointer' }} onClick={() => window.open(upload.url, '_blank')}><Link2 size={11} /> R2 ✓</span>}
              {upload.status === 'error' && <Tooltip title={upload.error}><span>上传失败</span></Tooltip>}
              {upload.status === 'idle' && <span>输入图片</span>}
            </div>
            <Button
              size="small"
              icon={<X size={13} />}
              onClick={onClearImage}
              className={styles.clearButton}
            />
            {acceptsMask && (
              <div className={styles.maskActions}>
                <Button size="small" type="primary" icon={<Brush size={13} />} onClick={onEditMask}>涂抹重绘</Button>
                {maskDataUrl && <Button size="small" onClick={onClearMask}>清除蒙版</Button>}
              </div>
            )}
          </div>
        )}
      </>}

      <div className={styles.caption}>
        <span>{baseImage ? '修改说明（可留空）' : '文字描述'}</span>
        <span>{prompt.length} / {promptMax}</span>
      </div>
      <Input.TextArea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value.slice(0, promptMax))}
        placeholder={baseImage ? '可留空生成图片变体，或描述希望怎样修改' : '描述你想生成的图片…'}
        autoSize={{ minRows: 4, maxRows: 9 }}
      />
      <button
        type="button"
        onClick={() => setExamplesOpen((open) => !open)}
        className={styles.examplesToggle}
      >
        <span>示例 Prompt</span>
        <ChevronDown size={13} style={{ transform: examplesOpen ? 'rotate(180deg)' : undefined }} />
      </button>
      {examplesOpen && EXAMPLE_PROMPTS.map((example) => (
        <button
          key={example}
          type="button"
          onClick={() => {
            onPromptChange(example)
            setExamplesOpen(false)
          }}
          className={styles.example}
        >
          <Sparkles size={11} style={{ marginRight: 4 }} />{example}
        </button>
      ))}
    </section>
  )
}

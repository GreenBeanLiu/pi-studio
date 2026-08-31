import { useRef, useState } from 'react'
import { Button, Input, Spin, Tooltip } from 'antd'
import { createStyles } from 'antd-style'
import { Brush, ChevronDown, Image as ImageIcon, Link2, Search, Sparkles, X } from 'lucide-react'
import {
  IMAGE_STYLE_CATEGORIES,
  filterImageStyleTemplates,
  imageStyleCategoryLabel,
  type ImageStyleCategoryId,
  type ImageStyleTemplate,
} from '../lib/image-style-templates'

export type ReferenceUploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; url: string }
  | { status: 'error'; error: string }

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
  templateChips: css`
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  `,
  chip: css`
    flex: none;
    padding: 2px 9px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 999px;
    background: transparent;
    color: ${token.colorTextTertiary};
    font-size: 11px;
    line-height: 18px;
    white-space: nowrap;
    cursor: pointer;
    &:hover { color: ${token.colorText}; border-color: ${token.colorBorder}; }
  `,
  chipActive: css`
    border-color: ${token.colorPrimaryBorder};
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimary};
  `,
  templateList: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 216px;
    overflow-y: auto;
  `,
  template: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 7px;
    border: 0;
    border-radius: ${token.borderRadiusSM}px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    &:hover { background: ${token.colorFillQuaternary}; }
  `,
  templateLabel: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: ${token.colorText};
    font-size: 12px;
  `,
  templateSize: css`
    flex: none;
    color: ${token.colorTextQuaternary};
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  `,
  templateHint: css`
    color: ${token.colorTextTertiary};
    font-size: 11px;
    line-height: 16px;
  `,
  templateEmpty: css`
    padding: 8px 7px;
    color: ${token.colorTextTertiary};
    font-size: 11px;
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
  onApplyTemplate,
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
  onApplyTemplate: (template: ImageStyleTemplate) => void
  onFile: (file?: File) => void
  onPreview: (url: string) => void
  onClearImage: () => void
  onEditMask: () => void
  onClearMask: () => void
}) {
  const { styles, cx } = useStyles()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateCategory, setTemplateCategory] = useState<ImageStyleCategoryId | null>(null)
  const templates = filterImageStyleTemplates(templateQuery, templateCategory)

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
        onClick={() => setTemplatesOpen((open) => !open)}
        className={styles.examplesToggle}
      >
        <span><Sparkles size={11} style={{ marginRight: 4 }} />风格模板</span>
        <ChevronDown size={13} style={{ transform: templatesOpen ? 'rotate(180deg)' : undefined }} />
      </button>
      {templatesOpen && (
        <>
          <Input
            size="small"
            allowClear
            prefix={<Search size={12} />}
            placeholder="搜模板、风格或场景，如 海报 / 电商 / UI"
            value={templateQuery}
            onChange={(event) => setTemplateQuery(event.target.value)}
          />
          <div className={styles.templateChips}>
            <button
              type="button"
              onClick={() => setTemplateCategory(null)}
              className={cx(styles.chip, templateCategory === null && styles.chipActive)}
            >
              全部
            </button>
            {IMAGE_STYLE_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() =>
                  setTemplateCategory((current) => (current === category.id ? null : category.id))
                }
                className={cx(styles.chip, templateCategory === category.id && styles.chipActive)}
              >
                {category.label}
              </button>
            ))}
          </div>
          <div className={styles.templateList}>
            {templates.length === 0 && <div className={styles.templateEmpty}>没有匹配的模板</div>}
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => {
                  onApplyTemplate(template)
                  setTemplatesOpen(false)
                }}
                className={styles.template}
              >
                <span className={styles.templateLabel}>
                  {template.label}
                  <span className={styles.templateSize}>
                    {imageStyleCategoryLabel(template.category)} · {template.size.replace('x', '×')}
                  </span>
                </span>
                <span className={styles.templateHint}>{template.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

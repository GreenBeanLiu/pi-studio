import { useRef, useState } from 'react'
import { Button, Input, Spin, Tooltip } from 'antd'
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [examplesOpen, setExamplesOpen] = useState(false)

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.55)' }}>输入</div>
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
            style={{
              minHeight: 96,
              border: '1px dashed rgba(0,0,0,0.2)',
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              color: 'rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
              <ImageIcon size={22} strokeWidth={1.5} />
              <span>可选：上传参考图片</span>
              <span style={{ fontSize: 11 }}>PNG / JPG / WebP</span>
            </div>
          </div>
        )}
        {baseImage && (
          <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'rgba(0,0,0,0.04)' }}>
            <img
              src={baseImage}
              alt="输入图片"
              onClick={() => onPreview(baseImage)}
              style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'zoom-in' }}
            />
            <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 999, background: 'rgba(0,0,0,.58)', color: '#fff', fontSize: 11 }}>
              {upload.status === 'uploading' && <><Spin size="small" />上传中</>}
              {upload.status === 'done' && <span style={{ cursor: 'pointer' }} onClick={() => window.open(upload.url, '_blank')}><Link2 size={11} /> R2 ✓</span>}
              {upload.status === 'error' && <Tooltip title={upload.error}><span>上传失败</span></Tooltip>}
              {upload.status === 'idle' && <span>输入图片</span>}
            </div>
            <Button
              size="small"
              icon={<X size={13} />}
              onClick={onClearImage}
              style={{ position: 'absolute', top: 8, right: 8 }}
            />
            {acceptsMask && (
              <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 6 }}>
                <Button size="small" type="primary" icon={<Brush size={13} />} onClick={onEditMask}>涂抹重绘</Button>
                {maskDataUrl && <Button size="small" onClick={onClearMask}>清除蒙版</Button>}
              </div>
            )}
          </div>
        )}
      </>}

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(0,0,0,.45)' }}>
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
        style={{ display: 'flex', justifyContent: 'space-between', border: 0, padding: 0, background: 'transparent', color: 'rgba(0,0,0,.45)', cursor: 'pointer' }}
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
          style={{ border: 0, background: 'transparent', textAlign: 'left', padding: '3px 6px', cursor: 'pointer', color: 'rgba(0,0,0,.55)' }}
        >
          <Sparkles size={11} style={{ marginRight: 4 }} />{example}
        </button>
      ))}
    </section>
  )
}

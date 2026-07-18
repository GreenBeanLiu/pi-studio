import type { CSSProperties } from 'react'

import type {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  GrokImageAspectRatio,
  GrokImageResolution,
  ImageGenQuality,
  ImageGenSize,
} from '../lib/api'
import { imageModel, type ImageModelKey, type ImageOutputSettings } from './image-generation-models'

const GPT_SIZES: ImageGenSize[] = [
  '256x256', '512x512', '1024x1024', '1024x1536',
  '1536x1024', '1024x1792', '1792x1024', 'auto',
]
const GEMINI_RATIOS: GeminiImageAspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const GEMINI_SIZES: GeminiImageResolution[] = ['1K', '2K', '4K']
const GROK_RATIOS: GrokImageAspectRatio[] = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto',
]
const GROK_SIZES: GrokImageResolution[] = ['1K', '2K']
const QUALITIES: ImageGenQuality[] = ['low', 'medium', 'high', 'auto', 'standard', 'hd']

const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }
const buttonStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 38,
  border: '1px solid rgba(0,0,0,.12)',
  borderRadius: 6,
  background: 'rgba(0,0,0,.025)',
  color: 'rgba(0,0,0,.65)',
  cursor: 'pointer',
}
const activeStyle: CSSProperties = { borderColor: '#1677ff', background: '#e6f4ff', color: '#1677ff' }
const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'rgba(0,0,0,.45)', marginTop: 2 }

function Options<T extends string>({ values, value, onChange }: { values: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div style={gridStyle}>
      {values.map((option) => (
        <button key={option} type="button" style={{ ...buttonStyle, ...(option === value ? activeStyle : {}) }} onClick={() => onChange(option)}>
          {option.replace('x', '×')}
        </button>
      ))}
    </div>
  )
}

export default function ImageOutputSection({
  modelKey,
  value,
  hasMask,
  onChange,
}: {
  modelKey: ImageModelKey
  value: ImageOutputSettings
  hasMask: boolean
  onChange: (patch: Partial<ImageOutputSettings>) => void
}) {
  const model = imageModel(modelKey)
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(0,0,0,0.55)' }}>输出参数</div>

      {model.parameters === 'gpt' && <>
        <span style={labelStyle}>尺寸</span>
        <Options values={GPT_SIZES} value={value.size} onChange={(size) => onChange({ size })} />
        <span style={labelStyle}>质量</span>
        <Options values={QUALITIES} value={value.quality} onChange={(quality) => onChange({ quality })} />
        <button type="button" style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', color: 'rgba(0,0,0,.45)' }} onClick={() => onChange({ advanced: !value.advanced })}>
          GPT Image 2 高级参数 {value.advanced ? '▴' : '▾'}
        </button>
        {value.advanced && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>
            <label>背景<select value={value.background} onChange={(event) => onChange({ background: event.target.value as ImageOutputSettings['background'] })}><option>auto</option><option>transparent</option><option>opaque</option></select></label>
            <label>格式<select value={value.outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value as ImageOutputSettings['outputFormat'] })}><option>png</option><option>jpeg</option><option>webp</option></select></label>
            <label>压缩<input type="number" min={0} max={100} disabled={value.outputFormat === 'png'} value={value.outputCompression} onChange={(event) => onChange({ outputCompression: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></label>
            <label>审核<select value={value.moderation} onChange={(event) => onChange({ moderation: event.target.value as ImageOutputSettings['moderation'] })}><option>auto</option><option>low</option></select></label>
            <label>响应<select value={value.responseFormat} onChange={(event) => onChange({ responseFormat: event.target.value as ImageOutputSettings['responseFormat'] })}><option>b64_json</option><option>url</option></select></label>
            <label>用户<input maxLength={64} value={value.requestUser} onChange={(event) => onChange({ requestUser: event.target.value })} /></label>
          </div>
        )}
      </>}

      {model.parameters === 'gemini' && <>
        <span style={labelStyle}>画幅比例</span>
        <Options values={GEMINI_RATIOS} value={value.geminiAspectRatio} onChange={(geminiAspectRatio) => onChange({ geminiAspectRatio })} />
        <span style={labelStyle}>分辨率</span>
        <Options values={GEMINI_SIZES} value={value.geminiImageSize} onChange={(geminiImageSize) => onChange({ geminiImageSize })} />
      </>}

      {model.parameters === 'grok' && <>
        <span style={labelStyle}>画幅比例</span>
        <Options values={GROK_RATIOS} value={value.grokAspectRatio} onChange={(grokAspectRatio) => onChange({ grokAspectRatio })} />
        <span style={labelStyle}>分辨率</span>
        <Options values={GROK_SIZES} value={value.grokImageSize} onChange={(grokImageSize) => onChange({ grokImageSize })} />
      </>}

      <span style={labelStyle}>一次生成</span>
      <div style={gridStyle}>
        {[1, 2, 3, 4].map((count) => (
          <button
            key={count}
            type="button"
            disabled={hasMask && count !== 1}
            style={{ ...buttonStyle, ...(count === (hasMask ? 1 : value.count) ? activeStyle : {}), opacity: hasMask && count !== 1 ? 0.4 : 1 }}
            onClick={() => onChange({ count })}
          >
            {count} 张
          </button>
        ))}
      </div>
      {hasMask && <span style={{ fontSize: 11, color: '#d48806' }}>蒙版局部重绘固定输出 1 张</span>}
    </section>
  )
}

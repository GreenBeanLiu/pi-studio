import { createStyles } from 'antd-style'

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

// 全部走主题 token,不再硬编码浅色 —— 之前 rgba(0,0,0,…) 在暗色下几乎不可见
const useStyles = createStyles(({ token, css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  `,
  option: css`
    min-width: 0;
    min-height: 38px;
    border: 1px solid ${token.colorBorder};
    border-radius: 6px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorText};
    cursor: pointer;
    transition: all ${token.motionDurationFast};
    &:hover:not(:disabled) {
      border-color: ${token.colorPrimaryBorder};
    }
    &:disabled {
      cursor: not-allowed;
    }
  `,
  optionActive: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimary};
  `,
  sectionTitle: css`
    font-size: 12px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
  `,
  label: css`
    font-size: 11px;
    font-weight: 500;
    color: ${token.colorTextTertiary};
    margin-top: 2px;
  `,
  advancedToggle: css`
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: ${token.colorTextTertiary};
    &:hover {
      color: ${token.colorText};
    }
  `,
  advancedGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    color: ${token.colorTextSecondary};
    font-size: 12px;
    & select,
    & input {
      width: 100%;
      background: ${token.colorFillQuaternary};
      color: ${token.colorText};
      border: 1px solid ${token.colorBorder};
      border-radius: 4px;
      padding: 2px 4px;
    }
  `,
  maskHint: css`
    font-size: 11px;
    color: ${token.colorWarning};
  `,
}))

function Options<T extends string>({
  values,
  value,
  onChange,
}: {
  values: readonly T[]
  value: T
  onChange: (value: T) => void
}) {
  const { styles, cx } = useStyles()
  return (
    <div className={styles.grid}>
      {values.map((option) => (
        <button
          key={option}
          type="button"
          className={cx(styles.option, option === value && styles.optionActive)}
          onClick={() => onChange(option)}
        >
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
  const { styles, cx } = useStyles()
  const model = imageModel(modelKey)
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className={styles.sectionTitle}>输出参数</div>

      {model.parameters === 'gpt' && (
        <>
          <span className={styles.label}>尺寸</span>
          <Options values={GPT_SIZES} value={value.size} onChange={(size) => onChange({ size })} />
          <span className={styles.label}>质量</span>
          <Options
            values={QUALITIES}
            value={value.quality}
            onChange={(quality) => onChange({ quality })}
          />
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => onChange({ advanced: !value.advanced })}
          >
            GPT Image 2 高级参数 {value.advanced ? '▴' : '▾'}
          </button>
          {value.advanced && (
            <div className={styles.advancedGrid}>
              <label>背景<select value={value.background} onChange={(event) => onChange({ background: event.target.value as ImageOutputSettings['background'] })}><option>auto</option><option>transparent</option><option>opaque</option></select></label>
              <label>格式<select value={value.outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value as ImageOutputSettings['outputFormat'] })}><option>png</option><option>jpeg</option><option>webp</option></select></label>
              <label>压缩<input type="number" min={0} max={100} disabled={value.outputFormat === 'png'} value={value.outputCompression} onChange={(event) => onChange({ outputCompression: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></label>
              <label>审核<select value={value.moderation} onChange={(event) => onChange({ moderation: event.target.value as ImageOutputSettings['moderation'] })}><option>auto</option><option>low</option></select></label>
              <label>响应<select value={value.responseFormat} onChange={(event) => onChange({ responseFormat: event.target.value as ImageOutputSettings['responseFormat'] })}><option>b64_json</option><option>url</option></select></label>
              <label>用户<input maxLength={64} value={value.requestUser} onChange={(event) => onChange({ requestUser: event.target.value })} /></label>
            </div>
          )}
        </>
      )}

      {model.parameters === 'gemini' && (
        <>
          <span className={styles.label}>画幅比例</span>
          <Options values={GEMINI_RATIOS} value={value.geminiAspectRatio} onChange={(geminiAspectRatio) => onChange({ geminiAspectRatio })} />
          <span className={styles.label}>分辨率</span>
          <Options values={GEMINI_SIZES} value={value.geminiImageSize} onChange={(geminiImageSize) => onChange({ geminiImageSize })} />
        </>
      )}

      {model.parameters === 'grok' && (
        <>
          <span className={styles.label}>画幅比例</span>
          <Options values={GROK_RATIOS} value={value.grokAspectRatio} onChange={(grokAspectRatio) => onChange({ grokAspectRatio })} />
          <span className={styles.label}>分辨率</span>
          <Options values={GROK_SIZES} value={value.grokImageSize} onChange={(grokImageSize) => onChange({ grokImageSize })} />
        </>
      )}

      <span className={styles.label}>一次生成</span>
      <div className={styles.grid}>
        {[1, 2, 3, 4].map((count) => (
          <button
            key={count}
            type="button"
            disabled={hasMask && count !== 1}
            className={cx(
              styles.option,
              count === (hasMask ? 1 : value.count) && styles.optionActive,
            )}
            style={hasMask && count !== 1 ? { opacity: 0.4 } : undefined}
            onClick={() => onChange({ count })}
          >
            {count} 张
          </button>
        ))}
      </div>
      {hasMask && <span className={styles.maskHint}>蒙版局部重绘固定输出 1 张</span>}
    </section>
  )
}

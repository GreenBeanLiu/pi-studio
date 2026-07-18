import { Select } from 'antd'

import { IMAGE_MODELS, type ImageModelKey } from './image-generation-models'

export default function ImageModelSelector({
  value,
  cloudAvailable,
  onChange,
}: {
  value: ImageModelKey
  cloudAvailable: boolean
  onChange: (value: ImageModelKey) => void
}) {
  const groups = ['云端模型', '本地模型'] as const
  return (
    <Select
      value={value}
      onChange={(next) => onChange(next as ImageModelKey)}
      style={{ width: '100%' }}
      size="large"
      optionLabelProp="label"
      options={groups.map((group) => ({
        label: group,
        options: IMAGE_MODELS.filter((model) => model.group === group).map((model) => ({
          value: model.key,
          label: model.label,
          disabled: model.group === '云端模型' && !cloudAvailable,
          title: model.description,
        })),
      }))}
      optionRender={(option) => {
        const model = IMAGE_MODELS.find((entry) => entry.key === option.value)
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 0' }}>
            <span>{model?.label ?? option.label}</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>{model?.description}</span>
          </div>
        )
      }}
    />
  )
}

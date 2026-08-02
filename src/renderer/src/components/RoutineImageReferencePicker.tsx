import { useState } from 'react'
import { App as AntApp, Button, Empty, Input, Modal } from 'antd'
import { createStyles, cx } from 'antd-style'
import { Images } from 'lucide-react'
import { api, type ImageGenHistoryItem } from '../lib/api'
import { buildRoutineImageLibrary } from '../lib/routine-image-library'

type Props = {
  label: string
  title: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;

    .ant-input-group-wrapper {
      min-width: 0;
      flex: 1;
    }
  `,
  library: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    max-height: 520px;
    overflow-y: auto;
    padding: 2px;
  `,
  item: css`
    appearance: none;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    color: ${token.colorText};
    padding: 0;
    overflow: hidden;
    text-align: left;
    cursor: pointer;

    &:hover {
      border-color: ${token.colorPrimary};
    }

    img {
      display: block;
      width: 100%;
      aspect-ratio: 1;
      object-fit: cover;
      background: ${token.colorFillQuaternary};
    }

    span {
      display: block;
      padding: 7px 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
  `,
  selected: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 2px ${token.colorPrimaryBg};
  `,
}))

export default function RoutineImageReferencePicker({ label, title, value, placeholder, onChange }: Props) {
  const { styles } = useStyles()
  const { message } = AntApp.useApp()
  const [open, setOpen] = useState(false)
  const [images, setImages] = useState<ImageGenHistoryItem[]>([])
  const [loading, setLoading] = useState(false)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const result = await api.imageGen.history(100)
      if (!Array.isArray(result)) {
        message.error(result.error)
        return
      }
      setImages(buildRoutineImageLibrary(result))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  function showLibrary(): void {
    setOpen(true)
    void refresh()
  }

  return (
    <>
      <div className={styles.row}>
        <Input value={value} onChange={(event) => onChange(event.target.value)} addonBefore={label} placeholder={placeholder} />
        <Button icon={<Images size={14} />} onClick={showLibrary}>
          选素材
        </Button>
      </div>
      <Modal
        open={open}
        title={title}
        width={720}
        footer={
          <Button loading={loading} onClick={() => void refresh()}>
            刷新生成记录
          </Button>
        }
        onCancel={() => setOpen(false)}
      >
        {loading && images.length === 0 ? (
          <Empty description="正在加载生成记录…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : images.length === 0 ? (
          <Empty
            description="暂无可选图片。请先到左侧“生图”页面生成人物图或服装图。"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <div className={styles.library}>
            {images.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx(styles.item, value === item.url && styles.selected)}
                title={item.prompt || '生成图片'}
                aria-pressed={value === item.url}
                onClick={() => {
                  onChange(item.url)
                  setOpen(false)
                }}
              >
                <img src={item.url} alt={item.prompt || '生成图片'} loading="lazy" />
                <span>{item.prompt || '未命名生成图片'}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

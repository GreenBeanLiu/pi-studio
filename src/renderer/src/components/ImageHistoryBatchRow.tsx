import { Button, Popconfirm, Tooltip } from 'antd'
import { createStyles } from 'antd-style'
import { Brush, Check, Copy, Download, Link2, Trash2, ZoomIn } from 'lucide-react'

import type { ImageGenerationBatch } from './image-generation-history'

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  `,
  head: css`
    display: flex;
    align-items: flex-start;
    gap: 8px;
  `,
  prompt: css`
    flex: 1;
    min-width: 0;
    font-size: 12px;
    line-height: 1.5;
    color: ${token.colorTextSecondary};
    user-select: text;
  `,
  meta: css`
    flex-shrink: 0;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  images: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  `,
  item: css`
    min-width: 0;
    border: 2px solid transparent;
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    background: ${token.colorBgContainer};
    transition: border-color .15s, box-shadow .15s;
  `,
  selected: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 2px ${token.colorPrimaryBg};
  `,
  picture: css`
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    cursor: pointer;
    background: ${token.colorFillTertiary};
    img { width: 100%; height: 100%; display: block; object-fit: cover; }
    &:hover img { transform: scale(1.035); }
  `,
  badge: css`
    position: absolute;
    top: 6px;
    left: 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 6px;
    border-radius: 999px;
    background: rgba(0,0,0,.58);
    color: #fff;
    font-size: 10px;
  `,
  actions: css`
    display: flex;
    justify-content: center;
    padding: 3px 2px;
  `,
}))

export default function ImageHistoryBatchRow({
  batch,
  selectedId,
  tag,
  time,
  canUseAsInput,
  onSelect,
  onPreview,
  onDownload,
  onCopyPrompt,
  onCopyLink,
  onUseAsInput,
  onDeleteImage,
  onDeleteBatch,
}: {
  batch: ImageGenerationBatch
  selectedId?: string
  tag: string
  time: string
  canUseAsInput: boolean
  onSelect: (id: string) => void
  onPreview: (url: string) => void
  onDownload: (url: string) => void
  onCopyPrompt: () => void
  onCopyLink: (url: string) => void
  onUseAsInput: (url: string) => void
  onDeleteImage: (id: string) => void
  onDeleteBatch: () => void
}) {
  const { styles, cx } = useStyles()
  return (
    <article className={styles.row}>
      <header className={styles.head}>
        <div className={styles.prompt}>{batch.prompt}</div>
        <span className={styles.meta}>{tag} · {time} · {batch.images.length} 张</span>
        <Tooltip title="复制提示词"><Button size="small" type="text" icon={<Copy size={13} />} onClick={onCopyPrompt} /></Tooltip>
        <Popconfirm title="删除这一批图片?" onConfirm={onDeleteBatch}>
          <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
        </Popconfirm>
      </header>
      <div className={styles.images}>
        {batch.images.map((image, index) => {
          const selected = selectedId === image.id
          return (
            <div key={image.id} className={cx(styles.item, selected && styles.selected)}>
              <div className={styles.picture} onClick={() => onSelect(image.id)} title="点击选中这张图">
                <img src={image.url} alt={`${batch.prompt} ${index + 1}`} loading="lazy" />
                <span className={styles.badge}>{selected && <Check size={11} />} {selected ? '已选' : `#${index + 1}`}</span>
              </div>
              <div className={styles.actions}>
                <Tooltip title="放大"><Button size="small" type="text" icon={<ZoomIn size={13} />} onClick={() => onPreview(image.url)} /></Tooltip>
                <Tooltip title="下载"><Button size="small" type="text" icon={<Download size={13} />} onClick={() => onDownload(image.url)} /></Tooltip>
                <Tooltip title="复制链接"><Button size="small" type="text" icon={<Link2 size={13} />} onClick={() => onCopyLink(image.url)} /></Tooltip>
                {canUseAsInput && <Tooltip title="作为输入图片"><Button size="small" type="text" icon={<Brush size={13} />} onClick={() => onUseAsInput(image.url)} /></Tooltip>}
                <Popconfirm title="删除这张图片?" onConfirm={() => onDeleteImage(image.id)}>
                  <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                </Popconfirm>
              </div>
            </div>
          )
        })}
      </div>
    </article>
  )
}

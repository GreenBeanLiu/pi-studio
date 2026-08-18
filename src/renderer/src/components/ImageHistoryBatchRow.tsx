import { Button, Popconfirm, Tooltip } from 'antd'
import { createStyles } from 'antd-style'
import { Brush, Copy, Download, Link2, Trash2 } from 'lucide-react'

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
    align-items: center;
    gap: 8px;
  `,
  prompt: css`
    flex: 1;
    min-width: 0;
    font-size: 12px;
    line-height: 22px;
    color: ${token.colorTextSecondary};
    user-select: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    flex-shrink: 0;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  images: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 220px));
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
  picture: css`
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    cursor: pointer;
    background: ${token.colorFillTertiary};
    img { width: 100%; height: 100%; display: block; object-fit: cover; transition: transform .15s; }
    &:hover img { transform: scale(1.035); }
    &:hover .image-actions,
    &:focus-within .image-actions {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
  `,
  actions: css`
    position: absolute;
    left: 50%;
    bottom: 8px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 4px;
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorBgMask};
    transform: translateX(-50%);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity .15s, visibility .15s;
    & .ant-btn:not(.ant-btn-dangerous) { color: ${token.colorTextLightSolid}; }
  `,
}))

export default function ImageHistoryBatchRow({
  batch,
  tag,
  time,
  canUseAsInput,
  onPreview,
  onDownload,
  onCopyPrompt,
  onCopyLink,
  onUseAsInput,
  onDeleteImage,
  onDeleteBatch,
}: {
  batch: ImageGenerationBatch
  tag: string
  time: string
  canUseAsInput: boolean
  onPreview: (url: string) => void
  onDownload: (url: string) => void
  onCopyPrompt: () => void
  onCopyLink: (url: string) => void
  onUseAsInput: (url: string) => void
  onDeleteImage: (id: string) => void
  onDeleteBatch: () => void
}) {
  const { styles } = useStyles()
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
        {batch.images.map((image, index) => (
          <div key={image.id} className={styles.item}>
            <div className={styles.picture} onClick={() => onPreview(image.url)} title="点击放大">
              <img src={image.url} alt={`${batch.prompt} ${index + 1}`} loading="lazy" />
              <div className={`${styles.actions} image-actions`} onClick={(event) => event.stopPropagation()}>
                <Tooltip title="下载"><Button size="small" type="text" icon={<Download size={13} />} onClick={() => onDownload(image.url)} /></Tooltip>
                <Tooltip title="复制链接"><Button size="small" type="text" icon={<Link2 size={13} />} onClick={() => onCopyLink(image.url)} /></Tooltip>
                {canUseAsInput && <Tooltip title="作为输入图片"><Button size="small" type="text" icon={<Brush size={13} />} onClick={() => onUseAsInput(image.url)} /></Tooltip>}
                <Popconfirm title="删除这张图片?" onConfirm={() => onDeleteImage(image.id)}>
                  <Button size="small" type="text" danger icon={<Trash2 size={13} />} />
                </Popconfirm>
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  )
}

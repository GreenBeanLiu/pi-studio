/**
 * 计算图片插入正文的位置(位置表示图片前需要写入的文本块数量)。
 * 第一张图放在开头两段之后，其余图片均匀落在后续段落之间。
 */
export function imageInsertionPositions(blockCount: number, imageCount: number): number[] {
  if (imageCount <= 0) return []
  if (blockCount <= 0) return Array.from({ length: imageCount }, () => 0)
  if (imageCount === 1) return [Math.min(2, blockCount)]
  const positions: number[] = []
  let previous = 0
  for (let i = 0; i < imageCount; i += 1) {
    const ideal = Math.round(((i + 1) * blockCount) / (imageCount + 1))
    const position = Math.min(blockCount, Math.max(previous, ideal))
    positions.push(position)
    previous = position
  }
  return positions
}

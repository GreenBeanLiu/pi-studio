/**
 * 图生 3D 参考图预检与归一化(纯客户端,不花钱、不阻塞提交)。
 * 实测教训:透明底 PNG 会被 Tripo 压平成黑底,黑底再被当成实体重建
 * (模型背后多出一块黑色面片),所以透明图上传前必须压平到白底;
 * 深色/杂乱的不透明背景同样有被重建进模型的风险,给出警告。
 */

export type ReferenceAssessment = {
  level: 'ok' | 'warn'
  warnings: string[]
}

const SAMPLE = 64
/** 边缘环带宽度(采样图坐标系),用它近似"背景"区域。 */
const BORDER = 5
const MIN_EDGE_PX = 256
/** 全图透明像素占比超过该值视为透明底,跳过背景类警告。 */
const ALPHA_RATIO = 0.05
/** 边缘主色簇占比低于该值视为背景复杂。亮度方差不行:主体顶到画面边缘时
 *  白底也会双峰高方差;干净背景的判据是"存在一个占比很高的主色",与主体是否入镜无关。 */
const DOMINANT_MIN = 0.6
/** 像素与主色的 RGB 欧氏距离在该值内算同簇——柔和渐变背景(产品摄影常见)
 *  会跨多个量化桶,精确同桶会误报。 */
const CLUSTER_DIST = 48
/** 主色簇亮度低于该值视为深色底。 */
const DARK_LUMA = 64

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/** 带透明通道的图压平到白底(Tripo 会把透明压成黑底并重建成实体);不透明图原样返回。
 *  flattened=true 表示压平发生过——此时背景必然是纯白,背景类预检应跳过。 */
export async function normalizeReferenceImage(
  dataUrl: string,
): Promise<{ dataUrl: string; flattened: boolean }> {
  let img: HTMLImageElement
  try {
    img = await loadImage(dataUrl)
  } catch {
    return { dataUrl, flattened: false }
  }
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { dataUrl, flattened: false }
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let hasAlpha = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      hasAlpha = true
      break
    }
  }
  if (!hasAlpha) return { dataUrl, flattened: false }
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return { dataUrl: canvas.toDataURL('image/png'), flattened: true }
}

export async function assessReferenceImage(
  dataUrl: string,
  opts: { skipBackground?: boolean } = {},
): Promise<ReferenceAssessment> {
  const warnings: string[] = []
  let img: HTMLImageElement
  try {
    img = await loadImage(dataUrl)
  } catch {
    return { level: 'ok', warnings }
  }

  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_EDGE_PX)
    warnings.push(`图片分辨率较低(${img.naturalWidth}×${img.naturalHeight}),重建细节可能不足`)

  if (opts.skipBackground) return { level: warnings.length ? 'warn' : 'ok', warnings }

  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE
  canvas.height = SAMPLE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { level: warnings.length ? 'warn' : 'ok', warnings }
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
  const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE)

  let transparent = 0
  // 第一遍:收集边缘像素,并按 RGB 各 16 级量化找出现最多的主色桶
  const border: [number, number, number][] = []
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) {
      const i = (y * SAMPLE + x) * 4
      if (data[i + 3] < 128) transparent++
      const onBorder = x < BORDER || x >= SAMPLE - BORDER || y < BORDER || y >= SAMPLE - BORDER
      if (onBorder && data[i + 3] >= 128) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        border.push([r, g, b])
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const bucket = buckets.get(key)
        if (bucket) {
          bucket.count++
          bucket.r += r
          bucket.g += g
          bucket.b += b
        } else buckets.set(key, { count: 1, r, g, b })
      }
    }
  }

  const isTransparentBg = transparent / (SAMPLE * SAMPLE) > ALPHA_RATIO
  if (!isTransparentBg && border.length > 0) {
    let dominant = { count: 0, r: 0, g: 0, b: 0 }
    for (const b of buckets.values()) if (b.count > dominant.count) dominant = b
    const cr = dominant.r / dominant.count
    const cg = dominant.g / dominant.count
    const cb = dominant.b / dominant.count
    // 第二遍:主簇 = 与主色距离在阈值内的所有像素(容忍柔和渐变)
    const cluster = border.filter(
      ([r, g, b]) => (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2 <= CLUSTER_DIST ** 2,
    )
    if (cluster.length / border.length < DOMINANT_MIN) {
      warnings.push('背景较复杂:杂乱背景可能被当作物体的一部分重建,建议改用单一主体、干净背景的图片')
    } else {
      const luma = cluster.reduce((a, [r, g, b]) => a + 0.2126 * r + 0.7152 * g + 0.0722 * b, 0) / cluster.length
      if (luma < DARK_LUMA)
        warnings.push('深色背景可能被重建成模型后方的实体面片,建议改用白底或透明底图片')
    }
  }

  return { level: warnings.length ? 'warn' : 'ok', warnings }
}

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
/** 边缘亮度标准差超过该值视为背景复杂。 */
const BUSY_STD = 32
/** 不透明纯色背景的亮度均值低于该值视为深色底。 */
const DARK_LUMA = 64

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/** 带透明通道的图压平到白底(Tripo 会把透明压成黑底并重建成实体);不透明图原样返回。 */
export async function normalizeReferenceImage(dataUrl: string): Promise<string> {
  let img: HTMLImageElement
  try {
    img = await loadImage(dataUrl)
  } catch {
    return dataUrl
  }
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let hasAlpha = false
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      hasAlpha = true
      break
    }
  }
  if (!hasAlpha) return dataUrl
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export async function assessReferenceImage(dataUrl: string): Promise<ReferenceAssessment> {
  const warnings: string[] = []
  let img: HTMLImageElement
  try {
    img = await loadImage(dataUrl)
  } catch {
    return { level: 'ok', warnings }
  }

  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_EDGE_PX)
    warnings.push(`图片分辨率较低(${img.naturalWidth}×${img.naturalHeight}),重建细节可能不足`)

  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE
  canvas.height = SAMPLE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { level: warnings.length ? 'warn' : 'ok', warnings }
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
  const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE)

  let transparent = 0
  const borderLuma: number[] = []
  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) {
      const i = (y * SAMPLE + x) * 4
      if (data[i + 3] < 128) transparent++
      const onBorder = x < BORDER || x >= SAMPLE - BORDER || y < BORDER || y >= SAMPLE - BORDER
      if (onBorder && data[i + 3] >= 128)
        borderLuma.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
    }
  }

  const isTransparentBg = transparent / (SAMPLE * SAMPLE) > ALPHA_RATIO
  if (!isTransparentBg && borderLuma.length > 0) {
    const mean = borderLuma.reduce((a, b) => a + b, 0) / borderLuma.length
    const std = Math.sqrt(borderLuma.reduce((a, b) => a + (b - mean) ** 2, 0) / borderLuma.length)
    if (std > BUSY_STD) {
      warnings.push('背景较复杂:杂乱背景可能被当作物体的一部分重建,建议改用单一主体、干净背景的图片')
    } else if (mean < DARK_LUMA) {
      warnings.push('深色背景可能被重建成模型后方的实体面片,建议改用白底或透明底图片')
    }
  }

  return { level: warnings.length ? 'warn' : 'ok', warnings }
}

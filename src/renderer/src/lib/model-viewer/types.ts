// 抄自 sd-studio 的 model-viewer 类型(裁掉了 r3f 专用部分)
export interface ModelInfo {
  meshCount: number
  vertexCount: number
  materialCount: number
  textureCount: number
  triangleCount: number
  format: string
  hasTextures: boolean
}

export type EnvironmentKey = 'studio' | 'city' | 'warehouse' | 'sunset' | 'forest' | 'night'

export interface ViewerSettings {
  environment: EnvironmentKey
  wireframe: boolean
  whiteModel: boolean
  flatShading: boolean
  autoRotate: boolean
  autoRotateSpeed: number
  showGrid: boolean
  showAxes: boolean
  showBounds: boolean
  exposure: number
  background: string
  lightIntensity: number
}

import * as THREE from 'three'
import type { ModelInfo } from './types'

export function collectModelInfo(root: THREE.Object3D, format: string): ModelInfo {
  let meshCount = 0
  let vertexCount = 0
  let triangleCount = 0
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      meshCount += 1
      const geometry = obj.geometry as THREE.BufferGeometry
      const position = geometry.attributes.position
      if (position) vertexCount += position.count
      const index = geometry.index
      if (index) triangleCount += index.count / 3
      else if (position) triangleCount += position.count / 3

      const meshMaterials = Array.isArray(obj.material) ? obj.material : [obj.material]
      meshMaterials.forEach((material) => {
        if (!material) return
        materials.add(material)
        const standardLike = material as THREE.MeshStandardMaterial
        ;[
          standardLike.map,
          standardLike.normalMap,
          standardLike.roughnessMap,
          standardLike.metalnessMap,
          standardLike.emissiveMap,
          standardLike.aoMap,
          standardLike.alphaMap,
          standardLike.bumpMap,
        ].forEach((texture) => {
          if (texture) textures.add(texture)
        })
      })
    }
  })

  return {
    meshCount,
    vertexCount: Math.round(vertexCount),
    materialCount: materials.size,
    textureCount: textures.size,
    triangleCount: Math.round(triangleCount),
    format,
    hasTextures: textures.size > 0,
  }
}

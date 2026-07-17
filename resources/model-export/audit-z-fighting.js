/**
 * Detect distinct meshes whose axis-aligned outer faces occupy the same plane
 * and overlap in area. Both faces write the same depth values and therefore
 * flicker as the camera moves.
 *
 * The generated-model pipeline passes its bundled THREE namespace explicitly
 * so this resource has no runtime dependency of its own.
 */

function isAxisAligned(matrix, epsilon) {
  const e = matrix.elements
  const columns = [
    [e[0], e[1], e[2]],
    [e[4], e[5], e[6]],
    [e[8], e[9], e[10]],
  ]

  return columns.every((column) => {
    const length = Math.hypot(...column)
    if (length <= epsilon) return false
    const normalized = column.map((value) => Math.abs(value / length))
    return normalized.filter((value) => value > 1 - epsilon).length === 1
  })
}

function projectionOverlap(left, right, axis) {
  return ['x', 'y', 'z']
    .filter((candidate) => candidate !== axis)
    .reduce((area, projectedAxis) => {
      const overlap =
        Math.min(left.max[projectedAxis], right.max[projectedAxis]) -
        Math.max(left.min[projectedAxis], right.min[projectedAxis])
      return area * Math.max(0, overlap)
    }, 1)
}

export function findCoplanarOuterFaces(THREE, root, options = {}) {
  root.updateMatrixWorld(true)
  const meshes = []
  const modelBox = new THREE.Box3()

  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return
    object.geometry.computeBoundingBox()
    if (!object.geometry.boundingBox) return
    const box = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld)
    modelBox.union(box)
    meshes.push({ object, box })
  })

  const modelSize = modelBox.isEmpty() ? 1 : modelBox.getSize(new THREE.Vector3()).length()
  const planeEpsilon = options.planeEpsilon ?? Math.max(1e-8, modelSize * 1e-5)
  const overlapEpsilon = options.overlapEpsilon ?? Math.max(1e-12, modelSize * modelSize * 1e-8)
  const axisEpsilon = options.axisEpsilon ?? 1e-5
  const candidates = meshes.filter(({ object }) => isAxisAligned(object.matrixWorld, axisEpsilon))
  const conflicts = []

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex]
      const right = candidates[rightIndex]
      for (const axis of ['x', 'y', 'z']) {
        for (const side of ['min', 'max']) {
          const distance = Math.abs(left.box[side][axis] - right.box[side][axis])
          const overlapArea = projectionOverlap(left.box, right.box, axis)
          if (distance <= planeEpsilon && overlapArea > overlapEpsilon) {
            conflicts.push({
              left: left.object.name || left.object.uuid,
              right: right.object.name || right.object.uuid,
              face: `${side}${axis.toUpperCase()}`,
              coordinate: left.box[side][axis],
              overlapArea,
            })
          }
        }
      }
    }
  }

  return conflicts
}

export function assertNoCoplanarOuterFaces(THREE, root, options) {
  const conflicts = findCoplanarOuterFaces(THREE, root, options)
  if (conflicts.length === 0) return

  const details = conflicts
    .slice(0, 12)
    .map(
      (conflict) =>
        `${conflict.left} <> ${conflict.right} (${conflict.face}, overlap=${conflict.overlapArea.toFixed(5)})`,
    )
    .join('; ')
  const remaining = conflicts.length > 12 ? `; 另有 ${conflicts.length - 12} 处` : ''
  throw new Error(
    `MODEL_Z_FIGHTING: 检出 ${conflicts.length} 处同向共面重叠: ${details}${remaining}。` +
      '请缩小内层结构、把外层装饰明显抬高，或让两面错开；不要靠渲染深度设置掩盖。',
  )
}

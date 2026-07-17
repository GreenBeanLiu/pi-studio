import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as THREE from 'three'

const EPSILON = 1e-4

function parseGlb(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'glTF') throw new Error('Only binary .glb files are supported')
  let offset = 12
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    if (type === 0x4e4f534a) {
      return JSON.parse(buffer.toString('utf8', offset + 8, offset + 8 + length))
    }
    offset += 8 + length
  }
  throw new Error('GLB JSON chunk is missing')
}

function isAxisAligned(matrix) {
  const e = matrix.elements
  const columns = [
    [e[0], e[1], e[2]],
    [e[4], e[5], e[6]],
    [e[8], e[9], e[10]],
  ]

  return columns.every((column) => {
    const length = Math.hypot(...column)
    if (length <= EPSILON) return false
    const normalized = column.map((value) => Math.abs(value / length))
    return normalized.filter((value) => value > 1 - EPSILON).length === 1
  })
}

function projectionOverlap(a, b, axis) {
  const axes = ['x', 'y', 'z'].filter((candidate) => candidate !== axis)
  return axes.reduce((area, projectedAxis) => {
    const overlap = Math.min(a.max[projectedAxis], b.max[projectedAxis]) -
      Math.max(a.min[projectedAxis], b.min[projectedAxis])
    return area * Math.max(0, overlap)
  }, 1)
}

function nodeMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix)
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
    new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
  )
}

function meshBox(document, meshIndex) {
  const box = new THREE.Box3()
  let found = false
  for (const primitive of document.meshes?.[meshIndex]?.primitives ?? []) {
    const accessor = document.accessors?.[primitive.attributes?.POSITION]
    if (!accessor?.min || !accessor?.max) continue
    box.union(
      new THREE.Box3(
        new THREE.Vector3().fromArray(accessor.min),
        new THREE.Vector3().fromArray(accessor.max),
      ),
    )
    found = true
  }
  return found ? box : null
}

function findCoplanarOuterFaces(document) {
  const meshes = []
  const visit = (nodeIndex, parentMatrix) => {
    const node = document.nodes?.[nodeIndex]
    if (!node) return
    const worldMatrix = parentMatrix.clone().multiply(nodeMatrix(node))
    if (node.mesh !== undefined && isAxisAligned(worldMatrix)) {
      const box = meshBox(document, node.mesh)
      if (box) meshes.push({ name: node.name || `node_${nodeIndex}`, box: box.applyMatrix4(worldMatrix) })
    }
    for (const child of node.children ?? []) visit(child, worldMatrix)
  }
  for (const nodeIndex of document.scenes?.[document.scene ?? 0]?.nodes ?? []) {
    visit(nodeIndex, new THREE.Matrix4())
  }

  const conflicts = []
  for (let leftIndex = 0; leftIndex < meshes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < meshes.length; rightIndex += 1) {
      const left = meshes[leftIndex]
      const right = meshes[rightIndex]
      for (const axis of ['x', 'y', 'z']) {
        for (const side of ['min', 'max']) {
          const distance = Math.abs(left.box[side][axis] - right.box[side][axis])
          const overlapArea = projectionOverlap(left.box, right.box, axis)
          if (distance <= EPSILON && overlapArea > EPSILON) {
            conflicts.push({
              left: left.name,
              right: right.name,
              face: `${side}${axis.toUpperCase()}`,
              coordinate: left.box[side][axis],
              overlapArea,
            })
          }
        }
      }
    }
  }

  return { meshCount: meshes.length, conflicts }
}

const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/audit-z-fighting.mjs <model.glb>')
  process.exit(2)
}

const modelPath = resolve(input)
const document = parseGlb(await readFile(modelPath))
const report = findCoplanarOuterFaces(document)

console.log(`Audited ${report.meshCount} axis-aligned meshes in ${modelPath}`)
if (report.conflicts.length === 0) {
  console.log('Z_FIGHTING_AUDIT_OK')
  process.exit(0)
}

console.error(`Z_FIGHTING_AUDIT_FAILED: ${report.conflicts.length} coplanar outer-face overlaps`)
for (const conflict of report.conflicts.slice(0, 30)) {
  console.error(
    `- ${conflict.left} <> ${conflict.right}: ${conflict.face}=${conflict.coordinate.toFixed(5)}, overlap=${conflict.overlapArea.toFixed(5)}`,
  )
}
if (report.conflicts.length > 30) console.error(`- ... ${report.conflicts.length - 30} more`)
process.exit(1)

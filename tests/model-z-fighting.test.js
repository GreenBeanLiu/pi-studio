import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  assertNoCoplanarOuterFaces,
  findCoplanarOuterFaces,
} from '../resources/model-export/audit-z-fighting.js'

function mesh(size, position) {
  const value = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial())
  value.position.set(...position)
  return value
}

describe('generated-model z-fighting audit', () => {
  it('rejects overlapping parts that share the same visible outer plane', () => {
    const root = new THREE.Group()
    const wall = mesh([4.2, 1.35, 0.18], [0, 0.675, -1.085])
    wall.name = 'body_front_wall_core'
    const cornerPost = mesh([0.28, 1.45, 0.28], [-1.96, 0.675, -1.035])
    cornerPost.name = 'dark_corner_post_0'
    root.add(wall, cornerPost)

    const conflicts = findCoplanarOuterFaces(THREE, root)
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          left: 'body_front_wall_core',
          right: 'dark_corner_post_0',
          face: 'minZ',
        }),
      ]),
    )
    expect(() => assertNoCoplanarOuterFaces(THREE, root)).toThrow(/MODEL_Z_FIGHTING/)
  })

  it('accepts a detail that is visibly proud of its supporting surface', () => {
    const root = new THREE.Group()
    root.add(
      mesh([4.2, 1.35, 0.18], [0, 0.675, -1.085]),
      mesh([0.28, 1.0, 0.28], [-1.98, 0.675, -1.055]),
    )

    expect(findCoplanarOuterFaces(THREE, root)).toEqual([])
    expect(() => assertNoCoplanarOuterFaces(THREE, root)).not.toThrow()
  })
})

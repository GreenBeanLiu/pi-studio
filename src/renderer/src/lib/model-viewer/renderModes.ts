import * as THREE from 'three'

const WHITE = new THREE.Color('#f4f6f8')
const WIREFRAME_COLOR = new THREE.Color('#8ce3dc')

type MaterialWithUserData = THREE.Material & {
  userData: {
    originalColor?: string
    originalEmissive?: string
    originalFlatShading?: boolean
    originalWireframe?: boolean
    originalMap?: THREE.Texture | null
    wireframeHelper?: THREE.LineSegments
    [key: string]: unknown
  }
}

type MeshWithWireframe = THREE.Mesh & {
  userData: {
    originalVisible?: boolean
    [key: string]: unknown
  }
}

function eachMesh(root: THREE.Object3D, cb: (mesh: MeshWithWireframe) => void) {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      cb(obj as MeshWithWireframe)
    }
  })
}

function eachMeshMaterial(root: THREE.Object3D, cb: (material: MaterialWithUserData) => void) {
  eachMesh(root, (mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      if (material) cb(material as MaterialWithUserData)
    })
  })
}

function syncWireframeHelpers(root: THREE.Object3D, enabled: boolean) {
  eachMesh(root, (mesh) => {
    const helperKey = '__packviewWireframeHelper'
    const existingHelper = mesh.userData[helperKey] as THREE.LineSegments | undefined
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

    if (enabled) {
      // Overlay the wireframe on top of the surface (Tripo-style) instead of
      // replacing it: generated meshes run to hundreds of thousands of
      // triangles, and an exclusive wireframe at that density collapses into a
      // solid silhouette. Push the surface back a hair so the lines don't
      // z-fight with it.
      materials.forEach((m) => {
        if (!m) return
        m.polygonOffset = true
        m.polygonOffsetFactor = 1
        m.polygonOffsetUnits = 1
        m.needsUpdate = true
      })

      if (!existingHelper) {
        const geometry = new THREE.WireframeGeometry(mesh.geometry)
        const material = new THREE.LineBasicMaterial({
          color: WIREFRAME_COLOR,
          transparent: true,
          opacity: 0.35,
        })
        const helper = new THREE.LineSegments(geometry, material)
        helper.name = `${mesh.name || 'mesh'}-wireframe`
        helper.renderOrder = 2
        mesh.add(helper)
        mesh.userData[helperKey] = helper
      }
      ;(mesh.userData[helperKey] as THREE.LineSegments).visible = true
    } else {
      materials.forEach((m) => {
        if (!m) return
        m.polygonOffset = false
        m.needsUpdate = true
      })
      if (existingHelper) {
        mesh.remove(existingHelper)
        existingHelper.geometry.dispose()
        ;(existingHelper.material as THREE.Material).dispose()
        delete mesh.userData[helperKey]
      }
    }
  })
}

export function applyRenderModes(
  root: THREE.Object3D,
  options: { wireframe: boolean; whiteModel: boolean; flatShading: boolean },
) {
  syncWireframeHelpers(root, options.wireframe)

  eachMeshMaterial(root, (material) => {
    const standard = material as THREE.MeshStandardMaterial

    if (material.userData.originalWireframe === undefined) {
      material.userData.originalWireframe = standard.wireframe ?? false
    }
    if (material.userData.originalFlatShading === undefined) {
      material.userData.originalFlatShading = standard.flatShading ?? false
    }
    if ('color' in standard && standard.color && material.userData.originalColor === undefined) {
      material.userData.originalColor = `#${standard.color.getHexString()}`
    }
    if ('emissive' in standard && standard.emissive && material.userData.originalEmissive === undefined) {
      material.userData.originalEmissive = `#${standard.emissive.getHexString()}`
    }

    standard.wireframe = options.wireframe ? false : (material.userData.originalWireframe ?? false)
    standard.flatShading = options.flatShading

    // Tinting `color` alone isn't enough for textured models — the base color
    // multiplies with the albedo map, so the texture still shows. A real clay
    // render also detaches the color map (normal map stays for surface detail).
    if (!('originalMap' in material.userData)) {
      material.userData.originalMap = 'map' in standard ? (standard.map ?? null) : null
    }
    if ('map' in standard) {
      standard.map = options.whiteModel ? null : (material.userData.originalMap ?? null)
    }

    if ('color' in standard && standard.color) {
      if (options.whiteModel) {
        standard.color.copy(WHITE)
      } else if (material.userData.originalColor) {
        standard.color.set(material.userData.originalColor)
      }
    }

    if ('emissive' in standard && standard.emissive) {
      if (options.whiteModel) {
        standard.emissive.set('#000000')
      } else if (material.userData.originalEmissive) {
        standard.emissive.set(material.userData.originalEmissive)
      }
    }

    standard.needsUpdate = true
  })
}

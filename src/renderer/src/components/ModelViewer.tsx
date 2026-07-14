import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader, OrbitControls, RoomEnvironment } from 'three-stdlib'

type Props = {
  /** file:// or http(s) URL of a .glb model */
  url: string | null
  background?: string
}

/** Self-contained three.js GLB viewer: orbit controls + studio-ish IBL lighting. */
export default function ModelViewer({ url, background }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !url) return

    const width = mount.clientWidth || 1
    const height = mount.clientHeight || 1

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !background })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    if (background) scene.background = new THREE.Color(background)

    // Image-based lighting from a procedural room — no external HDR needed.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(RoomEnvironment(), 0.04).texture

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(5, 10, 7.5)
    scene.add(key)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000)
    camera.position.set(0, 0, 5)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.autoRotate = true
    controls.autoRotateSpeed = 1.2

    let raf = 0
    let disposed = false

    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (disposed) return
        const model = gltf.scene
        // Center + scale the model to a comfortable framing.
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        model.position.sub(center)
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const scale = 2.4 / maxDim
        model.scale.setScalar(scale)
        scene.add(model)

        // 缩放后模型底部 y,用于把地面网格贴到脚下
        const floorY = -(size.y * scale) / 2
        const grid = new THREE.GridHelper(6, 24, 0x888888, 0x555555)
        grid.position.y = floorY
        ;(grid.material as THREE.Material).transparent = true
        ;(grid.material as THREE.Material).opacity = 0.5
        scene.add(grid)
        scene.add(new THREE.AxesHelper(1.5)) // 坐标轴 R=X 绿=Y 蓝=Z
        scene.add(new THREE.BoxHelper(model, 0x3b82f6)) // 蓝色包围盒边界

        camera.position.set(0, 0.6, 4)
        controls.update()
      },
      undefined,
      (err) => console.error('[ModelViewer] load failed', err),
    )

    const animate = (): void => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = (): void => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      pmrem.dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [url, background])

  return <div ref={mountRef} style={{ width: '100%', height: '100%', minHeight: 0 }} />
}

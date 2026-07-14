import { useEffect, useRef, useState } from 'react'
import { createStyles } from 'antd-style'
import { Tooltip } from 'antd'
import {
  RefreshCw,
  Grid3x3,
  Palette,
  LayoutGrid,
  Axis3d,
  Scan,
  Maximize,
  Crosshair,
  SlidersHorizontal,
} from 'lucide-react'
import * as THREE from 'three'
import { GLTFLoader, OrbitControls, RGBELoader, RoomEnvironment } from 'three-stdlib'
import { applyRenderModes } from '../lib/model-viewer/renderModes'
import { collectModelInfo } from '../lib/model-viewer/meshInfo'
import type { EnvironmentKey, ModelInfo, ViewerSettings } from '../lib/model-viewer/types'

/**
 * 全功能 GLB 预览器,交互与功能抄自 sd-studio 的 ViewerShell/ModelViewer:
 * 线框(叠加式,避免高密度网格糊成剪影)、白模(摘掉贴图的 clay 渲染)、
 * 平滑/平直着色、地面网格/坐标轴/包围盒、六种 HDR 环境光(自宿主,见
 * public/hdri)、曝光/灯光/背景色、自动旋转、适配/重置视角、面数顶点统计。
 * renderModes/meshInfo 两个纯 three 模块原样照抄;UI 壳按 pi-studio 的
 * antd-style 重写(sd-studio 用的 tailwind + r3f/drei,这里保持裸 three)。
 */

// 与 sd-studio 相同的自宿主 HDR(drei 预设背后的同款文件);相对路径在
// dev(http)和打包(file://)下都相对 index.html 解析
const ENV_FILES: Record<EnvironmentKey, string> = {
  studio: 'studio_small_03_1k.hdr',
  city: 'potsdamer_platz_1k.hdr',
  warehouse: 'empty_warehouse_01_1k.hdr',
  sunset: 'venice_sunset_1k.hdr',
  forest: 'forest_slope_1k.hdr',
  night: 'dikhololo_night_1k.hdr',
}

const ENV_PRESETS: { key: EnvironmentKey; label: string; icon: string }[] = [
  { key: 'studio', label: 'Studio', icon: '🎬' },
  { key: 'city', label: 'Daylight', icon: '🌤' },
  { key: 'warehouse', label: 'Showroom', icon: '🏪' },
  { key: 'sunset', label: 'Sunset', icon: '🌅' },
  { key: 'forest', label: 'Natural', icon: '🌿' },
  { key: 'night', label: 'Night', icon: '🌙' },
]

const DEFAULT_SETTINGS: ViewerSettings = {
  environment: 'studio',
  wireframe: false,
  whiteModel: false,
  flatShading: false,
  autoRotate: true,
  autoRotateSpeed: 1.2,
  showGrid: true,
  showAxes: true,
  showBounds: false,
  exposure: 1.2,
  background: '#141414',
  lightIntensity: 1.2,
}

/** 每个 url 一套的 three 对象,集中放 ref 里供各 effect 就地修改。 */
type ViewerHandles = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  hemi: THREE.HemisphereLight
  key: THREE.DirectionalLight
  pmrem: THREE.PMREMGenerator
  envCache: Map<string, THREE.Texture>
  model?: THREE.Group
  grid?: THREE.GridHelper
  axes?: THREE.AxesHelper
  bounds?: THREE.BoxHelper
  initialCamera: { position: THREE.Vector3; target: THREE.Vector3 }
}

const useStyles = createStyles(({ css }) => ({
  root: css`
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
  `,
  stats: css`
    position: absolute;
    top: 44px;
    right: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    text-align: right;
    font-size: 11px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.65);
    pointer-events: none;
    span {
      font-family: monospace;
      color: rgba(255, 255, 255, 0.85);
    }
  `,
  sideBar: css`
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
  `,
  toolbar: css`
    position: absolute;
    bottom: 14px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    white-space: nowrap;
  `,
  toolBtn: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: all 0.15s;
    font-size: 14px;
    &:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
  `,
  toolBtnActive: css`
    background: rgba(255, 255, 255, 0.25) !important;
    color: #fff !important;
  `,
  divider: css`
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: rgba(255, 255, 255, 0.15);
  `,
  shadeGroup: css`
    display: flex;
    align-items: center;
    padding: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  `,
  shadeBtn: css`
    border: none;
    background: transparent;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    &:hover {
      color: #fff;
    }
  `,
  shadeBtnActive: css`
    background: rgba(255, 255, 255, 0.25);
    color: #fff;
  `,
  panel: css`
    position: absolute;
    bottom: 64px;
    left: 50%;
    transform: translateX(-50%);
    width: 256px;
    padding: 14px 16px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(6px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
    input[type='range'] {
      width: 100%;
      accent-color: #1677ff;
    }
  `,
  panelRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
}))

function relativeAssetUrl(path: string): string {
  return new URL(path, window.location.href).toString()
}

export default function ModelViewer({ url }: { url: string | null }) {
  const { styles, cx } = useStyles()
  const mountRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<ViewerHandles | null>(null)
  const settingsRef = useRef<ViewerSettings>(DEFAULT_SETTINGS)
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS)
  const [info, setInfo] = useState<ModelInfo | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  settingsRef.current = settings

  const patch = (p: Partial<ViewerSettings>): void => setSettings((s) => ({ ...s, ...p }))

  /** 依据当前 settings 就地更新 three 对象(灯光/曝光/背景/辅助线/渲染模式)。 */
  const applySettings = (h: ViewerHandles, s: ViewerSettings): void => {
    h.renderer.toneMappingExposure = s.exposure
    h.scene.background = new THREE.Color(s.background)
    h.hemi.intensity = s.lightIntensity * 0.5
    h.key.intensity = s.lightIntensity
    h.controls.autoRotate = s.autoRotate
    h.controls.autoRotateSpeed = s.autoRotateSpeed
    if (h.grid) h.grid.visible = s.showGrid
    if (h.axes) h.axes.visible = s.showAxes
    if (h.bounds) h.bounds.visible = s.showBounds
    if (h.model)
      applyRenderModes(h.model, {
        wireframe: s.wireframe,
        whiteModel: s.whiteModel,
        flatShading: s.flatShading,
      })
  }

  /** HDR 环境光,按 key 缓存 PMREM 产物;加载失败回退程序化 RoomEnvironment。 */
  const applyEnvironment = (h: ViewerHandles, key: EnvironmentKey): void => {
    const cached = h.envCache.get(key)
    if (cached) {
      h.scene.environment = cached
      return
    }
    new RGBELoader().load(
      relativeAssetUrl(`hdri/${ENV_FILES[key]}`),
      (texture) => {
        const env = h.pmrem.fromEquirectangular(texture).texture
        texture.dispose()
        h.envCache.set(key, env)
        // 加载期间用户可能又切了环境,只在仍选中时应用
        if (settingsRef.current.environment === key) h.scene.environment = env
      },
      undefined,
      () => {
        if (!h.envCache.has('__room')) {
          h.envCache.set('__room', h.pmrem.fromScene(RoomEnvironment(), 0.04).texture)
        }
        h.scene.environment = h.envCache.get('__room')!
      },
    )
  }

  const fitToModel = (reset = false): void => {
    const h = handlesRef.current
    if (!h) return
    if (reset) {
      h.camera.position.copy(h.initialCamera.position)
      h.controls.target.copy(h.initialCamera.target)
    } else if (h.model) {
      const box = new THREE.Box3().setFromObject(h.model)
      const size = box.getSize(new THREE.Vector3()).length()
      const center = box.getCenter(new THREE.Vector3())
      const dist = (size / 2 / Math.tan((h.camera.fov * Math.PI) / 360)) * 1.2
      const dir = h.camera.position.clone().sub(h.controls.target).normalize()
      h.controls.target.copy(center)
      h.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)))
    }
    h.controls.update()
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !url) return

    const width = mount.clientWidth || 1
    const height = mount.clientHeight || 1

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(5, 8, 5)
    scene.add(key)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000)
    camera.position.set(0, 0.6, 4)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const handles: ViewerHandles = {
      renderer,
      scene,
      camera,
      controls,
      hemi,
      key,
      pmrem,
      envCache: new Map(),
      initialCamera: { position: camera.position.clone(), target: controls.target.clone() },
    }
    handlesRef.current = handles
    applySettings(handles, settingsRef.current)
    applyEnvironment(handles, settingsRef.current.environment)

    let disposed = false
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (disposed) return
        const model = gltf.scene
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        model.position.sub(center)
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        model.scale.setScalar(2.4 / maxDim)
        scene.add(model)
        handles.model = model

        const floorY = -(size.y * (2.4 / maxDim)) / 2
        const grid = new THREE.GridHelper(6, 24, 0x888888, 0x555555)
        grid.position.y = floorY
        ;(grid.material as THREE.Material).transparent = true
        ;(grid.material as THREE.Material).opacity = 0.5
        scene.add(grid)
        handles.grid = grid
        const axes = new THREE.AxesHelper(1.5)
        scene.add(axes)
        handles.axes = axes
        const bounds = new THREE.BoxHelper(model, 0x3b82f6)
        scene.add(bounds)
        handles.bounds = bounds

        setInfo(collectModelInfo(model, 'glb'))
        applySettings(handles, settingsRef.current)
      },
      undefined,
      (err) => console.error('[ModelViewer] load failed', err),
    )

    let raf = 0
    const animate = (): void => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(mount)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      for (const tex of handles.envCache.values()) tex.dispose()
      pmrem.dispose()
      renderer.dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      handlesRef.current = null
      setInfo(null)
    }
  }, [url])

  // settings 变化就地应用(不重建场景)
  useEffect(() => {
    const h = handlesRef.current
    if (h) applySettings(h, settings)
  }, [settings])
  useEffect(() => {
    const h = handlesRef.current
    if (h) applyEnvironment(h, settings.environment)
  }, [settings.environment])

  if (!url) return null

  return (
    <div className={styles.root} ref={mountRef}>
      {info && (
        <div className={styles.stats}>
          <div>
            面 <span>{info.triangleCount.toLocaleString()}</span>
          </div>
          <div>
            顶点 <span>{info.vertexCount.toLocaleString()}</span>
          </div>
        </div>
      )}

      <div className={styles.sideBar}>
        <Tooltip title="适配模型" placement="left">
          <button type="button" className={styles.toolBtn} onClick={() => fitToModel(false)}>
            <Maximize size={15} />
          </button>
        </Tooltip>
        <Tooltip title="重置视角" placement="left">
          <button type="button" className={styles.toolBtn} onClick={() => fitToModel(true)}>
            <Crosshair size={15} />
          </button>
        </Tooltip>
      </div>

      {panelOpen && (
        <div className={styles.panel}>
          {settings.autoRotate && (
            <div>
              <div className={styles.panelRow}>
                <span>旋转速度</span>
                <span>{settings.autoRotateSpeed.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={5}
                step={0.1}
                value={settings.autoRotateSpeed}
                onChange={(e) => patch({ autoRotateSpeed: parseFloat(e.target.value) })}
              />
            </div>
          )}
          <div>
            <div className={styles.panelRow}>
              <span>亮度</span>
              <span>{settings.exposure.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0.3}
              max={3}
              step={0.1}
              value={settings.exposure}
              onChange={(e) => patch({ exposure: parseFloat(e.target.value) })}
            />
          </div>
          <div>
            <div className={styles.panelRow}>
              <span>灯光强度</span>
              <span>{settings.lightIntensity.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={settings.lightIntensity}
              onChange={(e) => patch({ lightIntensity: parseFloat(e.target.value) })}
            />
          </div>
          <div className={styles.panelRow}>
            <span>背景色</span>
            <input
              type="color"
              value={settings.background}
              onChange={(e) => patch({ background: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className={styles.toolbar}>
        <Tooltip title="自动旋转">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.autoRotate && styles.toolBtnActive)}
            onClick={() => patch({ autoRotate: !settings.autoRotate })}
          >
            <RefreshCw size={15} />
          </button>
        </Tooltip>
        <Tooltip title="线框">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.wireframe && styles.toolBtnActive)}
            onClick={() => patch({ wireframe: !settings.wireframe })}
          >
            <Grid3x3 size={15} />
          </button>
        </Tooltip>
        <Tooltip title="白模">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.whiteModel && styles.toolBtnActive)}
            onClick={() => patch({ whiteModel: !settings.whiteModel })}
          >
            <Palette size={15} />
          </button>
        </Tooltip>
        <Tooltip title="地面网格">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.showGrid && styles.toolBtnActive)}
            onClick={() => patch({ showGrid: !settings.showGrid })}
          >
            <LayoutGrid size={15} />
          </button>
        </Tooltip>
        <Tooltip title="坐标轴">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.showAxes && styles.toolBtnActive)}
            onClick={() => patch({ showAxes: !settings.showAxes })}
          >
            <Axis3d size={15} />
          </button>
        </Tooltip>
        <Tooltip title="包围盒">
          <button
            type="button"
            className={cx(styles.toolBtn, settings.showBounds && styles.toolBtnActive)}
            onClick={() => patch({ showBounds: !settings.showBounds })}
          >
            <Scan size={15} />
          </button>
        </Tooltip>

        <div className={styles.divider} />

        <div className={styles.shadeGroup}>
          <button
            type="button"
            className={cx(styles.shadeBtn, !settings.flatShading && styles.shadeBtnActive)}
            onClick={() => patch({ flatShading: false })}
          >
            平滑
          </button>
          <button
            type="button"
            className={cx(styles.shadeBtn, settings.flatShading && styles.shadeBtnActive)}
            onClick={() => patch({ flatShading: true })}
          >
            平直
          </button>
        </div>

        <div className={styles.divider} />

        {ENV_PRESETS.map(({ key, label, icon }) => (
          <Tooltip title={label} key={key}>
            <button
              type="button"
              className={cx(styles.toolBtn, settings.environment === key && styles.toolBtnActive)}
              onClick={() => patch({ environment: key })}
            >
              {icon}
            </button>
          </Tooltip>
        ))}

        <div className={styles.divider} />

        <Tooltip title="曝光与灯光">
          <button
            type="button"
            className={cx(styles.toolBtn, panelOpen && styles.toolBtnActive)}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <SlidersHorizontal size={15} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

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
  Download,
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
  // 场景轴线默认关(会贯穿模型,方位看左上角轴向仪就够);工具栏可手动开
  showAxes: false,
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
  /** 正在摆动的可动部件(uuid → 动画状态),rAF 循环里推进 */
  partAnims: Map<string, PartAnim>
}

/**
 * 代码建模/Blender 建模的产物里,可动部件的 Group 带 userData 语义
 * (glb extras 原样恢复):axis=局部转轴、pivot=铰位描述、animationRole 等。
 * Tripo 网格没有这些语义,部件面板自动隐藏。
 */
type MovablePart = {
  id: string
  /** 展示名:节点名去掉 _pivot/_hinge 之类的后缀 */
  label: string
  role?: string
}

type PartAnim = {
  obj: THREE.Object3D
  axis: THREE.Vector3
  baseQuat: THREE.Quaternion
  startedAt: number
}

/** ±35° 正弦摆动,周期 2.4s —— 方向未知(axis 正负语义由模型自定),对称摆最稳。 */
const PART_SWING_RAD = (35 * Math.PI) / 180
const PART_SWING_PERIOD_MS = 2400

function parsePartAxis(userData: Record<string, unknown>): THREE.Vector3 | null {
  const raw = userData.axis
  if (Array.isArray(raw) && raw.length === 3 && raw.every((n) => typeof n === 'number')) {
    const v = new THREE.Vector3(raw[0], raw[1], raw[2])
    return v.lengthSq() > 0 ? v.normalize() : null
  }
  if (raw === 'x' || raw === 'X') return new THREE.Vector3(1, 0, 0)
  if (raw === 'y' || raw === 'Y') return new THREE.Vector3(0, 1, 0)
  if (raw === 'z' || raw === 'Z') return new THREE.Vector3(0, 0, 1)
  return null
}

/** 收集带 axis 语义的可动部件(嵌套时只取最外层,避免父子同时摆打架)。 */
function collectMovableParts(model: THREE.Object3D): { part: MovablePart; obj: THREE.Object3D }[] {
  const found: { part: MovablePart; obj: THREE.Object3D }[] = []
  const walk = (obj: THREE.Object3D): void => {
    const axis = parsePartAxis(obj.userData ?? {})
    if (axis) {
      found.push({
        obj,
        part: {
          id: obj.uuid,
          label: (obj.name || '部件').replace(/[_-]?(pivot|hinge|group)$/i, '').replace(/_/g, ' '),
          role: typeof obj.userData.animationRole === 'string' ? obj.userData.animationRole : undefined,
        },
      })
      return // 不往下钻:子部件跟随父级摆动即可
    }
    for (const child of obj.children) walk(child)
  }
  walk(model)
  return found
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
    top: 10px;
    left: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    font-size: 11px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.55);
    pointer-events: none;
    span {
      font-family: monospace;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.88);
      margin-left: 10px;
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
  partsPanel: css`
    position: absolute;
    left: 10px;
    bottom: 14px;
    max-width: 240px;
    max-height: 42%;
    overflow-y: auto;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
  `,
  partsTitle: css`
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
    letter-spacing: 0.04em;
  `,
  partChip: css`
    border: none;
    border-radius: 8px;
    padding: 5px 10px;
    text-align: left;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.75);
    cursor: pointer;
    font-size: 12px;
    line-height: 1.4;
    transition: all 0.15s;
    &:hover {
      background: rgba(255, 255, 255, 0.16);
      color: #fff;
    }
  `,
  partChipActive: css`
    background: rgba(22, 119, 255, 0.55) !important;
    color: #fff !important;
  `,
}))

function relativeAssetUrl(path: string): string {
  return new URL(path, window.location.href).toString()
}

/** 左上角的相机方位轴向仪:把三个单位轴经相机旋转投到 2D,近端画彩色标签圆。 */
function drawAxisGizmo(canvas: HTMLCanvasElement, camera: THREE.Camera): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const s = canvas.width
  const c = s / 2
  const r = c - 9
  ctx.clearRect(0, 0, s, s)
  const rot = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse)
  const axes = [
    { v: new THREE.Vector3(1, 0, 0), color: '#ef4444', label: 'X' },
    { v: new THREE.Vector3(0, 1, 0), color: '#22c55e', label: 'Y' },
    { v: new THREE.Vector3(0, 0, 1), color: '#3b82f6', label: 'Z' },
  ].map((a) => {
    const p = a.v.clone().applyMatrix4(rot)
    return { ...a, x: c + p.x * r, y: c - p.y * r, nx: c - p.x * r, ny: c + p.y * r, z: p.z }
  })
  // 远的先画,近的盖在上面
  axes.sort((a, b) => a.z - b.z)
  for (const a of axes) {
    // 负方向:暗色小点
    ctx.beginPath()
    ctx.arc(a.nx, a.ny, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = `${a.color}55`
    ctx.fill()
    // 正方向:轴线 + 标签圆
    ctx.beginPath()
    ctx.moveTo(c, c)
    ctx.lineTo(a.x, a.y)
    ctx.strokeStyle = a.color
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(a.x, a.y, 6.5, 0, Math.PI * 2)
    ctx.fillStyle = a.color
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 8px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(a.label, a.x, a.y + 0.5)
  }
}

export default function ModelViewer({
  url,
  downloadUrl,
  onSnapshot,
}: {
  url: string | null
  downloadUrl?: string | null
  /** 模型稳定渲染后回传一帧干净截图(隐藏辅助线),用于生成缩略图;每个 url 只回调一次 */
  onSnapshot?: (dataUrl: string) => void
}) {
  const { styles, cx } = useStyles()
  const mountRef = useRef<HTMLDivElement>(null)
  const gizmoRef = useRef<HTMLCanvasElement>(null)
  const snapshotDoneRef = useRef<string | null>(null)
  const onSnapshotRef = useRef(onSnapshot)
  onSnapshotRef.current = onSnapshot
  const handlesRef = useRef<ViewerHandles | null>(null)
  const settingsRef = useRef<ViewerSettings>(DEFAULT_SETTINGS)
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS)
  const [info, setInfo] = useState<ModelInfo | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  // 可动部件(带 userData.axis 语义的 Group);Tripo 模型没有 → 面板不渲染
  const [parts, setParts] = useState<MovablePart[]>([])
  const [activeParts, setActiveParts] = useState<Set<string>>(new Set())
  const partObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map())
  settingsRef.current = settings

  const patch = (p: Partial<ViewerSettings>): void => setSettings((s) => ({ ...s, ...p }))

  /** 点击部件 chip:开始/停止绕 userData.axis 的对称摆动(停止时恢复原姿态)。 */
  const togglePart = (id: string): void => {
    const h = handlesRef.current
    const obj = partObjectsRef.current.get(id)
    if (!h || !obj) return
    const running = h.partAnims.get(id)
    if (running) {
      obj.quaternion.copy(running.baseQuat)
      h.partAnims.delete(id)
    } else {
      const axis = parsePartAxis(obj.userData ?? {})
      if (!axis) return
      h.partAnims.set(id, {
        obj,
        axis,
        baseQuat: obj.quaternion.clone(),
        startedAt: performance.now(),
      })
    }
    setActiveParts(new Set(h.partAnims.keys()))
  }

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
      partAnims: new Map(),
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
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const s = 2.4 / maxDim
        model.scale.setScalar(s)
        // 站在原点地面上:XZ 居中、底面贴 y=0(注意 group 平移不随 scale,偏移要乘 s)
        model.position.set(-center.x * s, -box.min.y * s, -center.z * s)
        scene.add(model)
        handles.model = model

        const grid = new THREE.GridHelper(6, 24, 0x888888, 0x555555)
        // 略微下沉,避免与贴地模型底面共面导致 z-fighting 闪烁(sd-studio 同款细节)
        grid.position.y = -0.002
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

        // 初始取景:看向模型中心,包围球算距离留 15% 余量,略高略偏的三分视角
        const height = size.y * s
        const radius = (size.length() * s) / 2
        const target = new THREE.Vector3(0, height / 2, 0)
        const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.15
        camera.position.copy(
          target.clone().add(new THREE.Vector3(0.5, 0.4, 1).normalize().multiplyScalar(dist)),
        )
        controls.target.copy(target)
        controls.update()
        handles.initialCamera = { position: camera.position.clone(), target: target.clone() }

        setInfo(collectModelInfo(model, 'glb'))
        applySettings(handles, settingsRef.current)

        // 可动部件面板:收集带 axis 语义的节点(代码/Blender 模型才有)
        const movable = collectMovableParts(model)
        partObjectsRef.current = new Map(movable.map((m) => [m.part.id, m.obj]))
        setParts(movable.map((m) => m.part))
        setActiveParts(new Set())

        // 稳定渲染后截一帧干净画面(隐辅助线,等 HDR/贴图落定)回传做缩略图
        if (onSnapshotRef.current && snapshotDoneRef.current !== url) {
          setTimeout(() => {
            if (disposed || !onSnapshotRef.current || snapshotDoneRef.current === url) return
            snapshotDoneRef.current = url
            const vis = [grid.visible, axes.visible, bounds.visible]
            grid.visible = axes.visible = bounds.visible = false
            renderer.render(scene, camera)
            const shot = document.createElement('canvas')
            const side = 512
            shot.width = side
            shot.height = side
            const src = renderer.domElement
            const s = Math.min(src.width, src.height)
            shot
              .getContext('2d')!
              .drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, side, side)
            ;[grid.visible, axes.visible, bounds.visible] = vis
            onSnapshotRef.current(shot.toDataURL('image/png'))
          }, 1500)
        }
      },
      undefined,
      (err) => console.error('[ModelViewer] load failed', err),
    )

    let raf = 0
    const swingQuat = new THREE.Quaternion()
    const animate = (): void => {
      raf = requestAnimationFrame(animate)
      controls.update()
      // 部件摆动:base 姿态 × 绕局部轴的正弦摆(±35°,2.4s 周期)
      if (handles.partAnims.size) {
        const now = performance.now()
        for (const anim of handles.partAnims.values()) {
          const phase = ((now - anim.startedAt) / PART_SWING_PERIOD_MS) * Math.PI * 2
          swingQuat.setFromAxisAngle(anim.axis, Math.sin(phase) * PART_SWING_RAD)
          anim.obj.quaternion.copy(anim.baseQuat).multiply(swingQuat)
        }
      }
      renderer.render(scene, camera)
      if (gizmoRef.current) drawAxisGizmo(gizmoRef.current, camera)
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
      partObjectsRef.current = new Map()
      setInfo(null)
      setParts([])
      setActiveParts(new Set())
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
            <div>
              拓扑 <span>Triangle</span>
            </div>
            <div>
              面 <span>{info.triangleCount.toLocaleString()}</span>
            </div>
            <div>
              顶点 <span>{info.vertexCount.toLocaleString()}</span>
            </div>
          </div>
          <canvas ref={gizmoRef} width={64} height={64} style={{ width: 64, height: 64 }} />
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
        {downloadUrl && (
          <Tooltip title="下载 glb 模型" placement="left">
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => window.open(downloadUrl, '_blank')}
            >
              <Download size={15} />
            </button>
          </Tooltip>
        )}
      </div>

      {parts.length > 0 && (
        <div className={styles.partsPanel}>
          <span className={styles.partsTitle}>可动部件 · 点击摆动预览</span>
          {parts.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cx(styles.partChip, activeParts.has(p.id) && styles.partChipActive)}
              title={p.role ? `animationRole: ${p.role}` : undefined}
              onClick={() => togglePart(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

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

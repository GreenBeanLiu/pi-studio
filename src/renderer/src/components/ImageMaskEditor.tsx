import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Slider, Tooltip } from 'antd'
import { Brush, Eraser, Redo2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'

type Snapshot = { paint: ImageData; mask: ImageData }

export type ImageMaskEditorProps = {
  open: boolean
  src: string
  onCancel: () => void
  onApply: (maskDataUrl: string) => void
}

export default function ImageMaskEditor({ open, src, onCancel, onApply }: ImageMaskEditorProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const paintRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const undoRef = useRef<Snapshot[]>([])
  const redoRef = useRef<Snapshot[]>([])
  const [brushSize, setBrushSize] = useState(16)
  const [mode, setMode] = useState<'paint' | 'erase'>('paint')
  const [ready, setReady] = useState(false)
  const [painted, setPainted] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  const [zoom, setZoom] = useState(1)

  function reset() {
    const image = imageRef.current
    const paint = paintRef.current
    const mask = maskRef.current
    if (!image || !paint || !mask || !image.naturalWidth || !image.naturalHeight) return
    paint.width = image.naturalWidth
    paint.height = image.naturalHeight
    mask.width = image.naturalWidth
    mask.height = image.naturalHeight
    paint.getContext('2d')?.clearRect(0, 0, paint.width, paint.height)
    const maskContext = mask.getContext('2d')
    if (!maskContext) return
    maskContext.globalCompositeOperation = 'source-over'
    maskContext.fillStyle = '#fff'
    maskContext.fillRect(0, 0, mask.width, mask.height)
    undoRef.current = []
    redoRef.current = []
    setUndoCount(0)
    setRedoCount(0)
    setPainted(false)
    setMode('paint')
    setZoom(1)
    setReady(true)
  }

  useEffect(() => {
    if (!open) return
    setReady(false)
    setBrushSize(16)
    if (imageRef.current?.complete) requestAnimationFrame(reset)
  }, [open, src])

  function snapshot(): Snapshot | null {
    const paint = paintRef.current
    const mask = maskRef.current
    const paintContext = paint?.getContext('2d')
    const maskContext = mask?.getContext('2d')
    if (!paint || !mask || !paintContext || !maskContext) return null
    return {
      paint: paintContext.getImageData(0, 0, paint.width, paint.height),
      mask: maskContext.getImageData(0, 0, mask.width, mask.height),
    }
  }

  function restore(value: Snapshot) {
    paintRef.current?.getContext('2d')?.putImageData(value.paint, 0, 0)
    maskRef.current?.getContext('2d')?.putImageData(value.mask, 0, 0)
  }

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = paintRef.current
    if (!canvas) return { x: 0, y: 0, width: brushSize }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
      width: brushSize * (canvas.width / rect.width),
    }
  }

  function drawSegment(event: React.PointerEvent<HTMLCanvasElement>, dot = false) {
    const paint = paintRef.current
    const mask = maskRef.current
    const paintContext = paint?.getContext('2d')
    const maskContext = mask?.getContext('2d')
    if (!paint || !mask || !paintContext || !maskContext) return
    const point = canvasPoint(event)
    const last = lastPointRef.current ?? point
    const contexts = [
      { context: paintContext, operation: mode === 'erase' ? 'destination-out' : 'source-over', color: 'rgba(255,64,64,.48)' },
      { context: maskContext, operation: mode === 'erase' ? 'source-over' : 'destination-out', color: '#fff' },
    ] as const
    for (const { context, operation, color } of contexts) {
      context.globalCompositeOperation = operation
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.lineWidth = point.width
      context.strokeStyle = color
      context.fillStyle = color
      if (dot) {
        context.beginPath()
        context.arc(point.x, point.y, point.width / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.beginPath()
        context.moveTo(last.x, last.y)
        context.lineTo(point.x, point.y)
        context.stroke()
      }
    }
    lastPointRef.current = point
    setPainted(true)
  }

  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return
    const before = snapshot()
    if (before) undoRef.current = [...undoRef.current.slice(-29), before]
    redoRef.current = []
    setUndoCount(undoRef.current.length)
    setRedoCount(0)
    drawingRef.current = true
    lastPointRef.current = null
    event.currentTarget.setPointerCapture(event.pointerId)
    drawSegment(event, true)
  }

  function undo() {
    const current = snapshot()
    const previous = undoRef.current.pop()
    if (!current || !previous) return
    redoRef.current = [...redoRef.current.slice(-29), current]
    restore(previous)
    setUndoCount(undoRef.current.length)
    setRedoCount(redoRef.current.length)
    setPainted(undoRef.current.length > 0)
  }

  function redo() {
    const current = snapshot()
    const next = redoRef.current.pop()
    if (!current || !next) return
    undoRef.current = [...undoRef.current.slice(-29), current]
    restore(next)
    setUndoCount(undoRef.current.length)
    setRedoCount(redoRef.current.length)
    setPainted(true)
  }

  function changeZoom(delta: number) {
    setZoom((value) => Math.min(3, Math.max(1, Math.round((value + delta) * 10) / 10)))
  }

  return (
    <Modal
      title="涂抹需要重绘的区域"
      open={open}
      width={820}
      destroyOnClose
      onCancel={onCancel}
      okText="使用蒙版"
      cancelText="取消"
      okButtonProps={{ disabled: !ready || !painted }}
      onOk={() => {
        if (maskRef.current && painted) onApply(maskRef.current.toDataURL('image/png'))
      }}
    >
      <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>红色区域会被重绘，未涂抹区域保留。</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Button size="small" type={mode === 'paint' ? 'primary' : 'default'} icon={<Brush size={13} />} onClick={() => setMode('paint')}>涂抹</Button>
        <Button size="small" type={mode === 'erase' ? 'primary' : 'default'} icon={<Eraser size={13} />} onClick={() => setMode('erase')}>橡皮擦</Button>
        <Tooltip title="撤销"><Button size="small" disabled={!undoCount} icon={<Undo2 size={13} />} onClick={undo} /></Tooltip>
        <Tooltip title="重做"><Button size="small" disabled={!redoCount} icon={<Redo2 size={13} />} onClick={redo} /></Tooltip>
      </div>
      <div
        style={{ overflow: 'auto', maxHeight: '60vh', minHeight: 260, padding: 12, background: '#181818', textAlign: 'center' }}
        onWheel={(event) => {
          event.preventDefault()
          changeZoom(event.deltaY < 0 ? 0.1 : -0.1)
        }}
      >
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
          <img ref={imageRef} src={src} alt="蒙版底图" onLoad={reset} style={{ display: 'block', maxWidth: '100%', maxHeight: '56vh', userSelect: 'none' }} />
          <canvas
            ref={paintRef}
            onPointerDown={begin}
            onPointerMove={(event) => { if (drawingRef.current) drawSegment(event) }}
            onPointerUp={(event) => {
              drawingRef.current = false
              lastPointRef.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => { drawingRef.current = false; lastPointRef.current = null }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
          />
          <canvas ref={maskRef} hidden />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <Button size="small" icon={<ZoomOut size={13} />} onClick={() => changeZoom(-0.1)} disabled={zoom <= 1} />
        <span>{Math.round(zoom * 100)}%</span>
        <Button size="small" icon={<ZoomIn size={13} />} onClick={() => changeZoom(0.1)} disabled={zoom >= 3} />
        <span style={{ fontSize: 12 }}>笔刷</span>
        <Slider min={4} max={72} value={brushSize} onChange={setBrushSize} style={{ flex: 1 }} />
        <span style={{ width: 42 }}>{brushSize}px</span>
      </div>
    </Modal>
  )
}

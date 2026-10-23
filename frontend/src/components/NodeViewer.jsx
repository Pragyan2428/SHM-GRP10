// Full-screen look at the 3D sensor node: turn it, zoom in and take it apart with a slider.
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Layers, Maximize2, RotateCcw, X } from 'lucide-react'
import ExplodedNode from './ExplodedNode'

const Node3D = lazy(() => import('./Node3D'))

export default function NodeViewer({ onClose }) {
  const [apart, setApart] = useState(100) // 0 = assembled, 100 = every part lifted out
  const closeRef = useRef(null)
  const viewRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    const key = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow }
  }, [onClose])

  return (
    <div className="nv" role="dialog" aria-modal="true" aria-labelledby="nv-title" data-testid="node-viewer">
      <header className="nv-head">
        <div>
          <h2 id="nv-title">Sensor node · 3D model</h2>
          <p>Drag to turn it · scroll or pinch to zoom</p>
        </div>
        <button type="button" ref={closeRef} className="nv-close" onClick={onClose} aria-label="Close the 3D model" data-testid="node-viewer-close"><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="nv-stage">
        <Suspense fallback={<ExplodedNode />}>
          <Node3D explode={apart / 100} viewRef={viewRef} fallback={<ExplodedNode />} />
        </Suspense>
      </div>
      <footer className="nv-controls">
        <button type="button" className="nv-btn" onClick={() => setApart(0)} aria-pressed={apart === 0} data-testid="node-viewer-assemble"><Maximize2 size={14} aria-hidden="true" /> Put together</button>
        <label className="nv-slider">
          <span className="sr-only">How far apart</span>
          <input type="range" min="0" max="100" value={apart} onChange={(e) => setApart(Number(e.target.value))} data-testid="node-viewer-slider" />
        </label>
        <button type="button" className="nv-btn" onClick={() => setApart(100)} aria-pressed={apart === 100} data-testid="node-viewer-explode"><Layers size={14} aria-hidden="true" /> Take apart</button>
        <button type="button" className="nv-btn nv-icon" onClick={() => viewRef.current?.reset()} aria-label="Reset the view" data-testid="node-viewer-reset"><RotateCcw size={14} aria-hidden="true" /></button>
      </footer>
    </div>
  )
}

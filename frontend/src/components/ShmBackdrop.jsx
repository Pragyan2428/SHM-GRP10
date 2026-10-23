// A quiet animated background on the project's theme: a wireframe skyline whose floors carry
// pulsing sensor nodes, and a vibration trace that scrolls across like a seismograph, with an
// occasional spike. Drawn on one canvas at ~30 fps, paused in background tabs, and a single
// still frame for people who prefer reduced motion.
import { useEffect, useRef } from 'react'

const FLOOR = 26
const BAY = 38

function rng(seed) {
  let s = seed
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
}

// Buildings along the bottom, plus a few sensor nodes on each one's floor/column crossings.
function layout(w, h) {
  const r = rng(7)
  const buildings = []
  const nodes = []
  let x = -20
  while (x < w + 20) {
    const bw = BAY * (2 + Math.floor(r() * 4))
    const floors = 4 + Math.floor(r() * (h > 700 ? 14 : 9))
    const top = h - floors * FLOOR
    buildings.push({ x, w: bw, top })
    const count = 1 + Math.floor(r() * 3)
    for (let i = 0; i < count; i++) {
      nodes.push({
        x: x + BAY * Math.floor(r() * (bw / BAY + 1)),
        y: h - FLOOR * (1 + Math.floor(r() * floors)),
        phase: r() * 4,
        warn: r() < 0.12,
      })
    }
    x += bw + 14 + Math.floor(r() * 40)
  }
  return { buildings, nodes }
}

export default function ShmBackdrop({ className = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas.getContext('2d')
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let w = 0
    let h = 0
    let scene = { buildings: [], nodes: [] }
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      scene = layout(w, h)
    }

    const draw = (t) => {
      ctx.clearRect(0, 0, w, h)

      // wireframe skyline: outlines, floor slabs and columns
      ctx.lineWidth = 1
      scene.buildings.forEach((b) => {
        ctx.strokeStyle = 'rgba(255,255,255,.07)'
        ctx.strokeRect(b.x + 0.5, b.top + 0.5, b.w, h - b.top)
        ctx.strokeStyle = 'rgba(255,255,255,.035)'
        ctx.beginPath()
        for (let y = b.top + FLOOR; y < h; y += FLOOR) { ctx.moveTo(b.x, y + 0.5); ctx.lineTo(b.x + b.w, y + 0.5) }
        for (let x = b.x + BAY; x < b.x + b.w; x += BAY) { ctx.moveTo(x + 0.5, b.top); ctx.lineTo(x + 0.5, h) }
        ctx.stroke()
      })

      // sensor nodes: a steady dot and a ring that keeps pinging outwards
      scene.nodes.forEach((n) => {
        const color = n.warn ? '255,122,26' : '74,222,128'
        const p = ((t / 1000 + n.phase) % 3) / 3
        ctx.beginPath()
        ctx.arc(n.x, n.y, 3 + p * 20, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${color},${(0.35 * (1 - p)).toFixed(3)})`
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(n.x, n.y, 2.4, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${color},.55)`
        ctx.fill()
      })

      // vibration trace across the upper half; every ~7 s an "event" spike travels along it
      const base = h * 0.3
      const s = t / 1000
      const burstX = ((s % 7) / 7) * (w + 400) - 200
      ctx.beginPath()
      for (let x = 0; x <= w; x += 4) {
        const d = x - burstX
        const burst = Math.exp(-(d * d) / 2600) * Math.sin(x * 0.45) * 26
        const y = base + Math.sin(x * 0.018 + s * 1.6) * 7 + Math.sin(x * 0.061 - s * 2.7) * 3.5 + burst
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(255,122,26,.08)'
      ctx.lineWidth = 6
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,122,26,.32)'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.lineWidth = 1
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    let raf = 0
    let last = 0
    const loop = (t) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden || t - last < 33) return
      last = t
      draw(t)
    }
    if (reduce) draw(2500)
    else raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])
  return <canvas ref={ref} className={`shm-backdrop ${className}`} aria-hidden="true" data-testid="shm-backdrop" />
}

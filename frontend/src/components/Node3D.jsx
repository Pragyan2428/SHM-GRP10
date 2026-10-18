// 3D model of one Smart SHM sensor node (three.js). It starts closed; as the page scrolls
// through `sectionRef`, the lid lifts off and each part rises out of the enclosure in turn,
// with its name appearing beside it. Loaded lazily, so three.js only ships with the About page.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

// Parts from top to bottom: the order they come apart in. `y0` sits inside the closed box,
// `y1` / `x1` is the exploded position, `anchor` is where the label line starts (local coords).
export const PARTS = [
  { key: 'lid', name: 'Enclosure lid', sub: 'weatherproof cover with status LED', y0: 1.1, y1: 8.1, x1: 0, anchor: [3.2, 0.45, 0] },
  { key: 'ds18b20', name: 'DS18B20', sub: 'digital temperature sensor · °C', y0: 0.9, y1: 6.8, x1: -0.6, anchor: [0.75, 0.45, 0] },
  { key: 'adxl345', name: 'ADXL345', sub: '3-axis accelerometer · vibration (g)', y0: 0.85, y1: 5.65, x1: 1.5, anchor: [0.9, 0.12, 0] },
  { key: 'hx711', name: 'HX711', sub: 'strain gauge amplifier · strain (με)', y0: 0.78, y1: 4.5, x1: -1.3, anchor: [1.15, 0.12, 0] },
  { key: 'esp32', name: 'ESP32', sub: 'dual-core MCU · Wi-Fi uplink', y0: 0.62, y1: 3.15, x1: 0, anchor: [2.55, 0.25, 0] },
  { key: 'battery', name: 'Li-ion battery', sub: 'rechargeable, power-managed', y0: 0.17, y1: 1.75, x1: 0, anchor: [2.0, 0.62, 0] },
  { key: 'base', name: 'Base enclosure', sub: 'mounts on the structure', y0: 0, y1: 0, x1: 0, anchor: [3.25, 1.1, 0] },
]

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }
const lerp = (a, b, t) => a + (b - a) * t

function mats() {
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...o })
  return {
    shell: std(0x2b3038, { roughness: 0.6 }),
    shellDark: std(0x15181c, { roughness: 0.7 }),
    pcbBlack: std(0x16191e, { roughness: 0.45 }),
    pcbGreen: std(0x1d7a49, { roughness: 0.45 }),
    pcbBlue: std(0x2f43c4, { roughness: 0.45 }),
    chip: std(0x0b0c0e, { roughness: 0.35 }),
    gold: std(0xd6a640, { metalness: 0.85, roughness: 0.3 }),
    silver: std(0xc9ced6, { metalness: 0.9, roughness: 0.25 }),
    cell: std(0x2f6fd0, { roughness: 0.35, metalness: 0.2 }),
    led: new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff7a1a, emissiveIntensity: 2.2 }),
    accent: std(0xff7a1a, { roughness: 0.4 }),
  }
}

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z)
const rbox = (w, h, d, r, mat, x, y, z) => mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat, x, y + h / 2, z)

function pins(g, m, n, x0, step, y, z) {
  const geo = new THREE.BoxGeometry(0.09, 0.16, 0.09)
  for (let i = 0; i < n; i += 1) g.add(mesh(geo, m.gold, x0 + i * step, y + 0.08, z))
}

function buildParts(m) {
  const parts = {}
  // base enclosure: an open tray (floor + four walls) with mounting ears
  const base = new THREE.Group()
  base.add(rbox(6.5, 0.18, 4.5, 0.08, m.shell, 0, 0, 0))
  base.add(rbox(6.5, 1.1, 0.2, 0.06, m.shell, 0, 0, 2.15))
  base.add(rbox(6.5, 1.1, 0.2, 0.06, m.shell, 0, 0, -2.15))
  base.add(rbox(0.2, 1.1, 4.5, 0.06, m.shell, 3.15, 0, 0))
  base.add(rbox(0.2, 1.1, 4.5, 0.06, m.shell, -3.15, 0, 0))
  base.add(box(6.1, 0.02, 4.1, m.shellDark, 0, 0.18, 0))
  ;[-1, 1].forEach((s) => base.add(rbox(0.7, 0.12, 1.2, 0.05, m.shell, s * 3.6, 0, 0)))
  parts.base = base

  // battery: two 18650 cells in a holder
  const bat = new THREE.Group()
  bat.add(box(4.4, 0.08, 1.7, m.shellDark, 0, 0, 0))
  ;[-0.42, 0.42].forEach((z) => {
    const cell = mesh(new THREE.CylinderGeometry(0.34, 0.34, 3.7, 32), m.cell, 0, 0.42, z)
    cell.rotation.z = Math.PI / 2
    bat.add(cell)
    const cap = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 24), m.silver, 1.89, 0.42, z)
    cap.rotation.z = Math.PI / 2
    bat.add(cap)
  })
  parts.battery = bat

  // ESP32 development board
  const esp = new THREE.Group()
  esp.add(box(5.0, 0.08, 2.2, m.pcbBlack, 0, 0, 0))
  esp.add(rbox(1.7, 0.2, 1.25, 0.03, m.silver, -1.25, 0.08, 0))
  esp.add(box(0.75, 0.02, 1.25, m.gold, -2.4, 0.08, 0))
  esp.add(box(0.5, 0.18, 0.7, m.silver, 2.35, 0.08, 0))
  esp.add(box(0.5, 0.12, 0.5, m.chip, 0.9, 0.08, 0))
  ;[[1.6, 0.6], [1.6, -0.6]].forEach(([x, z]) => esp.add(box(0.22, 0.1, 0.22, m.chip, x, 0.08, z)))
  pins(esp, m, 15, -2.1, 0.3, 0.08, 0.98)
  pins(esp, m, 15, -2.1, 0.3, 0.08, -0.98)
  parts.esp32 = esp

  // HX711 strain amplifier module (green)
  const hx = new THREE.Group()
  hx.add(box(2.3, 0.06, 1.4, m.pcbGreen, 0, 0, 0))
  hx.add(box(0.8, 0.12, 0.45, m.chip, 0.1, 0.06, 0))
  pins(hx, m, 4, -1.0, 0.25, 0.06, 0.55)
  pins(hx, m, 4, -1.0, 0.25, 0.06, -0.55)
  parts.hx711 = hx

  // ADXL345 accelerometer breakout (blue)
  const ad = new THREE.Group()
  ad.add(box(1.8, 0.06, 1.3, m.pcbBlue, 0, 0, 0))
  ad.add(box(0.45, 0.08, 0.45, m.chip, 0.15, 0.06, 0))
  pins(ad, m, 6, -0.75, 0.3, 0.06, 0.5)
  parts.adxl345 = ad

  // DS18B20 module with the TO-92 sensor package
  const ds = new THREE.Group()
  ds.add(box(1.5, 0.06, 0.95, m.pcbBlack, 0, 0, 0))
  const to92 = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.42, 24, 1, false, 0, Math.PI), m.chip, 0, 0.27, 0)
  to92.rotation.y = Math.PI / 2
  ds.add(to92)
  ;[-0.12, 0, 0.12].forEach((x) => ds.add(box(0.03, 0.25, 0.03, m.silver, x, 0.06, 0.05)))
  pins(ds, m, 3, -0.5, 0.25, 0.06, -0.35)
  parts.ds18b20 = ds

  // lid with an orange status LED strip
  const lid = new THREE.Group()
  lid.add(rbox(6.5, 0.45, 4.5, 0.12, m.shell, 0, 0, 0))
  lid.add(box(1.6, 0.03, 0.12, m.led, -1.9, 0.45, 1.6))
  lid.add(rbox(2.1, 0.03, 1.1, 0.03, m.shellDark, 1.6, 0.45, -1.0))
  lid.add(box(0.4, 0.04, 0.4, m.accent, 1.0, 0.46, -1.0))
  parts.lid = lid
  return parts
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')))
  } catch {
    return false
  }
}

export default function Node3D({ sectionRef, onReveal, fallback = null }) {
  const wrapRef = useRef(null)
  const labelRefs = useRef({})
  const lineRefs = useRef({})
  const onRevealRef = useRef(onReveal)
  onRevealRef.current = onReveal
  const [failed, setFailed] = useState(() => typeof window !== 'undefined' && !hasWebGL())

  useEffect(() => {
    if (failed) return undefined
    const wrap = wrapRef.current
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      setFailed(true)
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.domElement.setAttribute('aria-hidden', 'true')
    wrap.prepend(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x101114, 1.15))
    const key = new THREE.DirectionalLight(0xffffff, 3.0)
    key.position.set(6, 14, 8)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 12, bottom: -6, near: 1, far: 40 })
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xa9bbff, 1.3)
    rim.position.set(-8, 6, -6)
    scene.add(rim)
    const warm = new THREE.PointLight(0xff7a1a, 18, 14, 2) // small orange glow from below, for depth
    warm.position.set(-3, 0.5, 4)
    scene.add(warm)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.35 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.01
    ground.receiveShadow = true
    scene.add(ground)

    const m = mats()
    const parts = buildParts(m)
    const model = new THREE.Group()
    PARTS.forEach((p) => { parts[p.key].position.y = p.y0; model.add(parts[p.key]) })
    scene.add(model)

    const resize = () => {
      const w = wrap.clientWidth || 1
      const h = wrap.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    let visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
    io.observe(wrap)

    const target = new THREE.Vector3()
    const v = new THREE.Vector3()
    let smoothP = reduce ? 1 : 0
    let revealed = -1
    let raf = 0
    const start = performance.now()

    const progress = () => {
      if (reduce) return 1
      const el = sectionRef?.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      const total = r.height - window.innerHeight
      return total > 0 ? clamp01(-r.top / total) : 1
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (!visible) return
      const p = progress()
      smoothP += (p - smoothP) * 0.12
      const sp = smoothP
      const time = (performance.now() - start) / 1000

      // each part lifts out in turn: lid first, base never moves
      let shown = 0
      const reveal = {}
      PARTS.forEach((part, i) => {
        const t = part.key === 'base' ? 0 : smooth(0.04 + i * 0.1, 0.36 + i * 0.1, sp)
        const g = parts[part.key]
        g.position.y = lerp(part.y0, part.y1, t)
        g.position.x = lerp(0, part.x1, t)
        g.rotation.z = Math.sin(t * Math.PI) * 0.06 * (i % 2 ? 1 : -1)
        reveal[part.key] = part.key === 'base' ? smooth(0.82, 0.95, sp) : t
      })
      model.rotation.y = -0.45 + sp * 0.75 + (reduce ? 0 : Math.sin(time * 0.35) * 0.04)

      // camera pulls back and up as the stack grows, and pans so the model sits left of the labels
      const ease = smooth(0, 1, sp)
      const aspectBoost = camera.aspect < 1 ? Math.pow(1 / camera.aspect, 0.85) : 1
      const dist = lerp(14, 21, ease) * aspectBoost
      const elev = 0.5
      const az = 0.75
      const pan = dist * (camera.aspect >= 1 ? 0.12 : 0.07) * ease
      target.set(Math.cos(az) * pan, lerp(0.7, 4.0, ease), -Math.sin(az) * pan)
      camera.position.set(target.x + Math.sin(az) * Math.cos(elev) * dist, target.y + Math.sin(elev) * dist, target.z + Math.cos(az) * Math.cos(elev) * dist)
      camera.lookAt(target)
      renderer.render(scene, camera)

      // labels: a right-hand column, kept in part order without overlapping, each joined to
      // its part by a leader line; they fade in once the part has lifted out
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      model.updateMatrixWorld()
      const items = PARTS.map((part) => {
        v.set(...part.anchor)
        parts[part.key].localToWorld(v)
        v.project(camera)
        return { part, ax: (v.x + 1) * 0.5 * w, ay: (1 - v.y) * 0.5 * h, alpha: smooth(0.7, 0.95, reveal[part.key]) }
      }).sort((a, b) => a.ay - b.ay)
      let prev = -Infinity
      items.forEach((it) => {
        const label = labelRefs.current[it.part.key]
        const lh = label?.offsetHeight || 40
        it.y = Math.max(it.ay, prev + lh + 6)
        prev = it.y
        it.lh = lh
      })
      const overflow = prev + (items[items.length - 1]?.lh || 40) / 2 - (h - 6)
      items.forEach((it) => {
        const label = labelRefs.current[it.part.key]
        const line = lineRefs.current[it.part.key]
        if (!label) return
        const y = overflow > 0 ? it.y - overflow : it.y
        const lw = label.offsetWidth || 160
        const lx = Math.max(8, w - lw - 6)
        label.style.transform = `translate(${Math.round(lx)}px, ${Math.round(y - it.lh / 2)}px)`
        label.style.opacity = it.alpha.toFixed(3)
        if (line) {
          line.style.opacity = it.alpha.toFixed(3)
          const [ln, dot] = line.children
          ln.setAttribute('x1', it.ax.toFixed(1)); ln.setAttribute('y1', it.ay.toFixed(1))
          ln.setAttribute('x2', (lx - 4).toFixed(1)); ln.setAttribute('y2', y.toFixed(1))
          dot.setAttribute('cx', it.ax.toFixed(1)); dot.setAttribute('cy', it.ay.toFixed(1))
        }
        const on = it.alpha > 0.5
        if ((label.dataset.visible === 'true') !== on) label.dataset.visible = String(on)
        if (on) shown += 1
      })
      if (shown !== revealed) {
        revealed = shown
        onRevealRef.current?.(PARTS.filter((part) => labelRefs.current[part.key]?.dataset.visible === 'true').map((part) => part.key))
      }
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
      })
      Object.values(m).forEach((mat) => mat.dispose())
      ground.material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [failed, sectionRef])

  if (failed) return fallback
  return (
    <div className="n3d" ref={wrapRef} data-testid="node3d" role="img"
      aria-label="3D model of a sensor node that comes apart as you scroll: lid, DS18B20, ADXL345, HX711, ESP32, battery and base enclosure">
      <svg className="n3d-lines" aria-hidden="true">
        {PARTS.map((p) => (
          <g key={p.key} ref={(el) => { lineRefs.current[p.key] = el }} style={{ opacity: 0 }}>
            <line stroke="rgba(255,255,255,.5)" strokeWidth="1" />
            <circle r="4" fill="#ff7a1a" stroke="rgba(255,122,26,.3)" strokeWidth="6" />
          </g>
        ))}
      </svg>
      <div className="n3d-labels" aria-hidden="true">
        {PARTS.map((p) => (
          <div key={p.key} className="n3d-label" ref={(el) => { labelRefs.current[p.key] = el }} data-testid={`node3d-label-${p.key}`} data-visible="false">
            <span className="n3d-text"><strong>{p.name}</strong><span>{p.sub}</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

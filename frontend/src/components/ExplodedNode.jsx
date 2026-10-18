// Exploded isometric drawing of one Smart SHM sensor node: every layer of the hardware
// lifted apart and labelled, like a product exploded view.

const S = 25
const CX = 210
const CY = 300
const iso = (x, y, z) => [CX + (x - y) * 0.866 * S, CY + (x + y) * 0.5 * S - z * S]
const pts = (arr) => arr.map((p) => iso(...p).map((n) => n.toFixed(1)).join(',')).join(' ')

function Slab({ x0, y0, w, d, z, t, top, left, right, stroke = 'rgba(255,255,255,.18)' }) {
  const x1 = x0 + w
  const y1 = y0 + d
  return (
    <g>
      <polygon points={pts([[x0, y1, z], [x1, y1, z], [x1, y1, z + t], [x0, y1, z + t]])} fill={left} stroke={stroke} strokeWidth=".8" />
      <polygon points={pts([[x1, y0, z], [x1, y1, z], [x1, y1, z + t], [x1, y0, z + t]])} fill={right} stroke={stroke} strokeWidth=".8" />
      <polygon points={pts([[x0, y0, z + t], [x1, y0, z + t], [x1, y1, z + t], [x0, y1, z + t]])} fill={top} stroke={stroke} strokeWidth=".8" />
    </g>
  )
}

function Chip({ x, y, z, w = 0.8, d = 0.8, color = '#0b0c0e' }) {
  return <Slab x0={x} y0={y} w={w} d={d} z={z} t={0.12} top={color} left="#050506" right="#08090a" stroke="rgba(255,255,255,.12)" />
}

function Pins({ x0, y, z, n, step = 0.32 }) {
  return Array.from({ length: n }, (_, i) => (
    <polygon key={i} points={pts([[x0 + i * step, y, z], [x0 + i * step + 0.16, y, z], [x0 + i * step + 0.16, y + 0.16, z], [x0 + i * step, y + 0.16, z]])} fill="#d9a441" />
  ))
}

// Layer list: geometry plus the label shown on the right.
const LAYERS = [
  { key: 'lid', label: 'Enclosure lid', sub: 'weatherproof cover', z: 10.6 },
  { key: 'ds18b20', label: 'DS18B20', sub: 'temperature · °C', z: 9.2 },
  { key: 'adxl345', label: 'ADXL345', sub: 'vibration · 3-axis g', z: 7.8 },
  { key: 'hx711', label: 'HX711', sub: 'strain gauge amplifier · με', z: 6.4 },
  { key: 'esp32', label: 'ESP32', sub: 'dual-core MCU · Wi-Fi uplink', z: 4.6 },
  { key: 'battery', label: 'Li-ion battery', sub: 'rechargeable, power-managed', z: 2.6 },
  { key: 'base', label: 'Base enclosure', sub: 'mounts on the structure', z: 0 },
]

export default function ExplodedNode() {
  const labelX = 470
  return (
    <svg className="exploded" viewBox="0 0 640 500" role="img" aria-label="Exploded view of a sensor node: lid, DS18B20, ADXL345, HX711, ESP32, battery and base enclosure">
      <defs>
        <linearGradient id="ex-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7a1a" stopOpacity="0" /><stop offset=".5" stopColor="#ff7a1a" stopOpacity=".55" /><stop offset="1" stopColor="#ff7a1a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* assembly axis */}
      {[[0.4, 0.4], [5.6, 0.4], [0.4, 3.6], [5.6, 3.6]].map(([x, y]) => {
        const [ax, ay] = iso(x, y, 0.8)
        const [bx, by] = iso(x, y, 10.6)
        return <line key={`${x}${y}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="rgba(255,255,255,.14)" strokeDasharray="3 5" />
      })}
      {(() => { const [ax, ay] = iso(3, 2, 0.8); const [, by] = iso(3, 2, 10.6); return <rect x={ax - 1} y={by} width="2" height={ay - by} fill="url(#ex-glow)" /> })()}

      {/* base enclosure (tray) */}
      <Slab x0={0} y0={0} w={6} d={4} z={0} t={0.8} top="#2a2f36" left="#1b1e23" right="#121418" />
      <polygon points={pts([[0.3, 0.3, 0.81], [5.7, 0.3, 0.81], [5.7, 3.7, 0.81], [0.3, 3.7, 0.81]])} fill="#14171b" />
      {/* battery: two cells */}
      <Slab x0={0.7} y0={0.9} w={4.6} d={0.9} z={2.6} t={0.9} top="#3a7bd5" left="#2457a0" right="#1b4380" />
      <Slab x0={0.7} y0={2.1} w={4.6} d={0.9} z={2.6} t={0.9} top="#3a7bd5" left="#2457a0" right="#1b4380" />
      <polygon points={pts([[5.0, 0.9, 3.51], [5.3, 0.9, 3.51], [5.3, 3.0, 3.51], [5.0, 3.0, 3.51]])} fill="#c9ced6" />
      {/* ESP32 dev board */}
      <Slab x0={0.5} y0={0.8} w={5} d={2.4} z={4.6} t={0.22} top="#1d2228" left="#121418" right="#0e1013" />
      <Slab x0={1.0} y0={1.3} w={1.9} d={1.4} z={4.83} t={0.18} top="#c7ccd3" left="#8a9099" right="#6f7683" stroke="rgba(0,0,0,.3)" />
      <Chip x={3.6} y={1.4} z={4.83} w={0.9} d={0.9} />
      <Pins x0={0.8} y={0.9} z={4.83} n={14} />
      <Pins x0={0.8} y={2.95} z={4.83} n={14} />
      {/* HX711 (green PCB) */}
      <Slab x0={0.8} y0={1.0} w={2.6} d={1.6} z={6.4} t={0.18} top="#1f7a4a" left="#145533" right="#0f4128" />
      <Chip x={1.5} y={1.4} z={6.59} />
      <Pins x0={1.0} y={1.1} z={6.59} n={6} />
      {/* ADXL345 (blue PCB) */}
      <Slab x0={3.2} y0={1.4} w={2.0} d={1.5} z={7.8} t={0.18} top="#3346c9" left="#22308f" right="#1a2570" />
      <Chip x={3.9} y={1.9} z={7.99} w={0.6} d={0.6} />
      <Pins x0={3.35} y={1.5} z={7.99} n={5} />
      {/* DS18B20 probe module */}
      <Slab x0={1.2} y0={1.6} w={1.6} d={1.0} z={9.2} t={0.18} top="#2b3037" left="#1b1e23" right="#121418" />
      <Slab x0={1.65} y0={1.85} w={0.5} d={0.5} z={9.39} t={0.45} top="#0b0c0e" left="#050506" right="#08090a" />
      {/* lid (translucent) */}
      <Slab x0={0} y0={0} w={6} d={4} z={10.6} t={0.45} top="rgba(220,226,235,.16)" left="rgba(220,226,235,.08)" right="rgba(220,226,235,.05)" stroke="rgba(255,255,255,.35)" />

      {/* labels */}
      {LAYERS.map((l, i) => {
        const [x, y] = iso(6, 0, l.z + 0.2)
        const ly = 70 + i * 66
        return (
          <g key={l.key} data-testid={`exploded-label-${l.key}`}>
            <polyline points={`${(x + 6).toFixed(1)},${y.toFixed(1)} ${labelX - 40},${ly} ${labelX - 8},${ly}`} fill="none" stroke="rgba(255,255,255,.35)" />
            <circle cx={x + 6} cy={y} r="2.5" fill="#ff7a1a" />
            <text x={labelX} y={ly - 2} fill="#fff" fontSize="15" fontWeight="700" fontFamily="Manrope, Inter, sans-serif">{l.label}</text>
            <text x={labelX} y={ly + 15} fill="#8b929c" fontSize="11.5" fontFamily="Inter, sans-serif">{l.sub}</text>
          </g>
        )
      })}
    </svg>
  )
}

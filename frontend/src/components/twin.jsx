// Overview building blocks: the isometric "digital twin" of the building, the radial
// gauge metric cards and the sensor-health hexagon grid.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Building2, ChevronDown, Gauge, MapPin, Radio } from 'lucide-react'
import { PARAMS, PARAM_SHORT, SENSOR, UNITS, fmtAgo, fmtNum, fmtTime, fmtValue } from '../lib/format'
import { PARAM_ICON, Sparkline, TrendIcon } from './monitoring'
import { Badge } from './ui'

const STATUS_COLOR = { nominal: '#2fd17a', warning: '#f5a524', critical: '#ff4d4f', offline: '#6f7683' }

/* ------------------------------------------------------------ isometric maths */
// The building is drawn from the nodes that report: as many storeys as their floors need,
// each node pinned on its own floor. A node's floor comes from the API (sent by the device
// or read from its location text); nodes without one stand beside the building.
const S = 34 // px per metre-ish unit
const CX = 271
const CY = 272
const W = 6 // building width (3 bays of 2)
const D = 4 // building depth
const P = 1.2 // platform margin
const MAX_H = 6.6 // height budget: taller buildings get thinner storeys
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export const floorName = (f) => (f === 'roof' ? 'Roof' : f === 0 ? 'GF' : f < 0 ? `B${-f}` : `${f}F`)
const floorKey = (f) => (f == null ? null : String(f))

function geometry(layout) {
  const cy = CY - ((MAX_H - layout.H) * S) / 2 // keep short buildings vertically centred
  const iso = (x, y, z) => [CX + (x - y) * 0.866 * S, cy + (x + y) * 0.5 * S - z * S]
  const pts = (arr) => arr.map((p) => iso(...p).map((n) => n.toFixed(1)).join(',')).join(' ')
  return {
    iso,
    pts,
    faceL: (y, x0, x1, z0, z1) => pts([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]), // plane y = const
    faceR: (x, y0, y1, z0, z1) => pts([[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]]), // plane x = const
    faceT: (z, x0, x1, y0, y1) => pts([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]]), // plane z = const
  }
}

function buildLayout(nodes) {
  const nums = nodes.map((n) => n.floor).filter((f) => typeof f === 'number')
  const low = Math.min(0, ...nums)
  const high = Math.max(0, ...nums)
  const storeys = high - low + 1
  const storey = Math.min(1.5, MAX_H / storeys)
  const floors = [...new Set(nums)].sort((a, b) => a - b)
  if (nodes.some((n) => n.floor === 'roof')) floors.push('roof')
  return { low, high, storeys, storey, H: storeys * storey, floors, known: floors.length > 0 }
}

// Positions for every node on the drawing, plus the building layout they imply.
export function placeNodes(nodes) {
  const layout = buildLayout(nodes)
  const g = geometry(layout)
  const groups = new Map()
  nodes.forEach((n) => {
    const k = floorKey(n.floor)
    if (k != null) groups.set(k, [...(groups.get(k) || []), n])
  })
  let other = 0
  const placed = Object.fromEntries(nodes.map((n) => {
    if (n.floor == null) {
      const i = other++
      const col = Math.floor(i / 6)
      return [n.node_id, { other: true, floor: null, xy: g.iso(W + 0.6 + col * 0.9, -0.7 + (i % 6) * 1.05, 0) }]
    }
    const group = groups.get(floorKey(n.floor))
    const i = group.indexOf(n)
    const k = group.length
    const step = typeof n.floor === 'number' ? n.floor - layout.low : 0
    // spread the floor's nodes along the facade; stagger floor by floor so pins on
    // neighbouring floors don't sit on top of each other
    const x = k === 1 ? [3, 1.3, 4.7][step % 3] : clamp((W * (i + 1)) / (k + 1) + (step % 2 ? 0.25 : -0.25) * (W / (k + 1)), 0.4, W - 0.4)
    const half = Math.min(1, W / (k + 1) / 2)
    const span = { x0: clamp(x - half, 0, W), x1: clamp(x + half, 0, W) }
    if (n.floor === 'roof') return [n.node_id, { other: false, roof: true, floor: 'roof', x, ...span, xy: g.iso(x, D / 2, layout.H) }]
    const level = n.floor - layout.low
    return [n.node_id, { other: false, floor: n.floor, level, x, ...span, xy: g.iso(x, D, (level + 0.5) * layout.storey) }]
  }))
  return { placed, layout }
}

export function describeFloors(layout) {
  if (!layout.known) return 'Not given by the nodes'
  const nums = layout.floors.filter((f) => f !== 'roof')
  const range = nums.length ? (layout.low === layout.high ? floorName(layout.low) : `${floorName(layout.low)}–${floorName(layout.high)}`) : ''
  return [range, layout.floors.includes('roof') ? 'roof' : ''].filter(Boolean).join(' + ')
}

function criticalParams(n, params) {
  return params.filter((p) => n.latest?.[p.parameter]?.status === 'critical').map((p) => PARAM_SHORT[p.parameter])
}

/* ------------------------------------------------------------ the drawing */
export function IsoBuilding({ nodes, params, view, selectedId, floor, onSelect }) {
  const { placed, layout } = view
  const { iso, pts, faceL, faceR, faceT } = geometry(layout)
  const { storeys, storey, H, low } = layout
  const grid = []
  for (let i = Math.ceil(-P); i <= W + P; i += 1) grid.push(pts([[i, -P, 0], [i, D + P, 0]]))
  for (let j = Math.ceil(-P); j <= D + P; j += 1) grid.push(pts([[-P, j, 0], [W + P, j, 0]]))
  const ground = -low // storey index of the ground floor
  const windowsL = []
  const windowsR = []
  if (storey >= 0.6) {
    for (let k = 0; k < storeys; k += 1) {
      const z0 = k * storey + storey * 0.28
      const z1 = k * storey + storey * 0.75
      for (let b = 0; b < 3; b += 1) {
        if (!(k === ground && b === 1)) windowsL.push({ key: `${k}${b}`, lit: (k * 3 + b) % 4 === 1, poly: faceL(D, b * 2 + 0.4, b * 2 + 1.6, z0, z1) })
      }
      for (let b = 0; b < 2; b += 1) {
        windowsR.push({ key: `${k}${b}`, lit: (k + b) % 3 === 2, poly: faceR(W, b * 2 + 0.4, b * 2 + 1.6, z0, z1) })
      }
    }
  }
  const slabStep = Math.max(1, Math.ceil(storeys / 30))
  const slabs = []
  for (let k = slabStep; k < storeys; k += slabStep) slabs.push(k)
  const labelled = layout.floors.filter((f) => f !== 'roof')
  const fkey = floorKey(floor)
  const alerts = nodes.filter((n) => n.online && (n.condition === 'critical' || n.condition === 'warning') && !placed[n.node_id].other)
  const band = (pl) => (pl.roof
    ? faceT(H + 0.01, pl.x0, pl.x1, 0.3, D - 0.3)
    : faceL(D, pl.x0, pl.x1, pl.level * storey, (pl.level + 1) * storey))
  const otherLabel = iso(W + 0.6, -1.6, 0)
  const centre = iso(W / 2, D / 2, H / 2)

  return (
    <svg className="twin-svg" viewBox="0 0 600 520" role="group" aria-label="Building digital twin with sensor locations">
      <defs>
        <linearGradient id="tw-left" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a2f36" /><stop offset="1" stopColor="#1b1e23" /></linearGradient>
        <linearGradient id="tw-right" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1c1f24" /><stop offset="1" stopColor="#121418" /></linearGradient>
        <filter id="tw-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" /></filter>
      </defs>

      {/* platform */}
      <polygon points={faceT(0, -P, W + P, -P, D + P)} fill="#15181c" stroke="rgba(255,255,255,.08)" />
      {grid.map((g) => <polyline key={g} points={g} stroke="rgba(255,255,255,.045)" fill="none" />)}
      <polygon points={faceL(D + P, -P, W + P, -0.45, 0)} fill="#0f1114" stroke="rgba(255,255,255,.06)" />
      <polygon points={faceR(W + P, -P, D + P, -0.45, 0)} fill="#0b0c0e" stroke="rgba(255,255,255,.06)" />

      {/* building: one storey per floor the nodes report */}
      <polygon points={faceR(W, 0, D, 0, H)} fill="url(#tw-right)" stroke="#3a4048" />
      <polygon points={faceL(D, 0, W, 0, H)} fill="url(#tw-left)" stroke="#444b54" />
      {windowsR.map((w) => <polygon key={`r${w.key}`} points={w.poly} fill={w.lit ? 'rgba(255,170,90,.16)' : '#0c0e11'} stroke="#2a3037" />)}
      {windowsL.map((w) => <polygon key={`l${w.key}`} points={w.poly} fill={w.lit ? 'rgba(255,170,90,.2)' : '#0c0e11'} stroke="#323840" />)}
      <polygon points={faceL(D, 2.62, 3.38, ground * storey, ground * storey + Math.min(1.05, storey * 0.7))} fill="#08090b" stroke="#323840" />
      {[0, 2, 4, 6].map((x) => <polygon key={`cl${x}`} points={faceL(D, x - 0.06, x + 0.06, 0, H)} fill="#3b4149" />)}
      {[0, 2, 4].map((y) => <polygon key={`cr${y}`} points={faceR(W, y - 0.06, y + 0.06, 0, H)} fill="#2b3037" />)}
      {slabs.map((k) => (
        <g key={`fl${k}`}>
          <polygon points={faceL(D, 0, W, k * storey - 0.05, k * storey + 0.05)} fill="#454c56" />
          <polygon points={faceR(W, 0, D, k * storey - 0.05, k * storey + 0.05)} fill="#30353d" />
        </g>
      ))}
      <polygon points={faceT(H, 0, W, 0, D)} fill="#2b3037" stroke="#4d545e" />
      <polygon points={faceT(H + 0.01, 0.2, W - 0.2, 0.2, D - 0.2)} fill="none" stroke="rgba(255,255,255,.08)" />

      {/* floor names for the floors that have sensors, painted along their band of the facade */}
      {labelled.map((f) => {
        const [x, y] = iso(0.08, D, (f - low + 0.5) * storey)
        const size = Math.max(7, Math.min(9.5, storey * S * 0.5))
        return (
          <text key={`lbl${f}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(30)`} dy={size * 0.35} fill="#8a919c" fontSize={size}
            fontWeight="600" fontFamily="JetBrains Mono, monospace" pointerEvents="none" data-testid={`twin-floor-label-${floorName(f).toLowerCase()}`}>
            {floorName(f)}
          </text>
        )
      })}

      {/* floor filter highlight */}
      {fkey != null && fkey !== 'roof' ? (
        <g pointerEvents="none">
          <polygon points={faceL(D, 0, W, (floor - low) * storey, (floor - low + 1) * storey)} fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.35)" />
          <polygon points={faceR(W, 0, D, (floor - low) * storey, (floor - low + 1) * storey)} fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.25)" />
        </g>
      ) : fkey === 'roof' ? (
        <polygon points={faceT(H + 0.01, 0, W, 0, D)} fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.35)" pointerEvents="none" />
      ) : null}

      {/* problem areas: the part of the floor around each warning or critical node glows */}
      {alerts.map((n) => {
        const pl = placed[n.node_id]
        const crit = n.condition === 'critical'
        const color = crit ? '#ff4d4f' : '#f5a524'
        const poly = band(pl)
        return (
          <g key={`hl${n.node_id}`} pointerEvents="none" data-testid={`twin-highlight-${n.node_id.toLowerCase()}`}>
            <polygon points={poly} fill={color} opacity={crit ? 0.45 : 0.25} filter="url(#tw-glow)" />
            <polygon points={poly} fill={color} fillOpacity={crit ? 0.32 : 0.16} stroke={color} strokeWidth="1.5" />
          </g>
        )
      })}

      {/* pins */}
      {nodes.map((n, i) => {
        const pl = placed[n.node_id]
        const [x, y] = pl.xy
        const cond = n.online ? n.condition : 'offline'
        const color = STATUS_COLOR[cond] || STATUS_COLOR.nominal
        const isSel = selectedId === n.node_id
        const dim = fkey != null && floorKey(pl.floor) !== fkey
        return (
          <g key={n.node_id} className="map-pin" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} role="button" tabIndex={0}
            opacity={dim ? 0.25 : 1}
            aria-label={`Sensor ${i + 1}, ${n.node_id}, ${n.location}, status ${cond}`} aria-pressed={isSel}
            data-testid={`map-pin-${n.node_id.toLowerCase()}`} data-status={cond} data-floor={floorKey(pl.floor) ?? 'unknown'}
            onClick={() => onSelect(n.node_id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.node_id) } }}>
            <title>{`${n.node_id} — ${n.location}`}</title>
            <g className="pin-body">
              {cond === 'critical' ? <circle className="pin-pulse" r="13" fill={color} /> : null}
              <circle className="pin-ring" r="13" fill="#0a0b0d" stroke={isSel ? '#fff' : color} strokeWidth={isSel ? 3 : 2} />
              <circle r="9" fill={color} fillOpacity=".25" />
              <text textAnchor="middle" dy="4.2" fill={isSel ? '#fff' : color} fontSize="11.5" fontWeight="700" fontFamily="JetBrains Mono, monospace">{i + 1}</text>
            </g>
          </g>
        )
      })}
      {nodes.some((n) => placed[n.node_id].other) ? (
        <text x={otherLabel[0]} y={otherLabel[1]} textAnchor="middle" fill="#6f7683" fontSize="11" fontFamily="Inter, sans-serif" data-testid="twin-unplaced-label">Floor not given</text>
      ) : null}
      {nodes.length === 0 ? (
        <text x={centre[0]} y={centre[1]} textAnchor="middle" fill="#a7adb7" fontSize="13" fontFamily="Inter, sans-serif" data-testid="twin-empty">
          No sensor nodes connected yet
        </text>
      ) : null}

      {/* WARNING tags for limit breaches, like a callout on the drawing */}
      {alerts.filter((n) => n.condition === 'critical').map((n) => {
        const [x, y] = placed[n.node_id].xy
        const what = criticalParams(n, params)
        const tx = clamp(x, 70, 530)
        const ty = Math.max(30, y - 62)
        return (
          <g key={`tag${n.node_id}`} pointerEvents="none" data-testid={`twin-warning-${n.node_id.toLowerCase()}`}>
            <line x1={x} y1={y - 14} x2={tx} y2={ty + 18} stroke="#ff4d4f" strokeWidth="1.5" />
            <rect x={tx - 66} y={ty - 16} width="132" height="34" rx="7" fill="#e5484d" />
            <text x={tx} y={ty - 1} textAnchor="middle" fill="#fff" fontSize="10.5" fontWeight="800" fontFamily="Inter, sans-serif" letterSpacing=".08em">⚠ WARNING</text>
            <text x={tx} y={ty + 12} textAnchor="middle" fill="#fff" fontSize="9.5" fontWeight="600" fontFamily="Inter, sans-serif">
              {(what.length ? what.join(' + ') : 'Limit').slice(0, 24)} over limit
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* ------------------------------------------------------------ side panels */
function GlassPanel({ title, icon: Icon, children, testid }) {
  return (
    <section className="glass" data-testid={testid}>
      <div className="glass-head"><span>{Icon ? <Icon size={13} aria-hidden="true" /> : null}{title}</span><ChevronDown size={14} aria-hidden="true" /></div>
      {children}
    </section>
  )
}

function Row({ k, children, testid }) {
  return <div className="glass-row" data-testid={testid}><span className="k">{k}</span><span className="v">{children}</span></div>
}

function ReadingSlider({ p, reading, online }) {
  const crit = p.critical_threshold || p.safe_threshold * 1.25
  const pct = reading ? clamp(reading.value / crit, 0, 1) : 0
  const safePct = clamp(p.safe_threshold / crit, 0, 1)
  const status = online && reading ? reading.status : 'offline'
  return (
    <div className="slider" data-testid={`map-pin-reading-${p.parameter}`}>
      <div className="slider-top">
        <span>{PARAM_SHORT[p.parameter]} <span className="dim">({p.unit})</span></span>
        <span className={`mono c-${status === 'offline' ? 'muted' : status}`}>{reading ? fmtValue(p.parameter, reading.value) : '—'}</span>
      </div>
      <div className={`slider-track ${status}`}>
        <span className="fill" style={{ width: `${pct * 100}%` }} />
        <span className="limit" style={{ left: `${safePct * 100}%` }} title={`Safe limit ${p.safe_threshold} ${p.unit}`} />
        <span className="thumb" style={{ left: `${pct * 100}%` }} />
      </div>
    </div>
  )
}

export function DigitalTwin({ t }) {
  const [selected, setSelected] = useState(null)
  const [floor, setFloor] = useState(null)
  const nodes = useMemo(() => [...(t.nodes || [])].sort((a, b) => a.node_id.localeCompare(b.node_id)), [t.nodes])
  const view = useMemo(() => placeNodes(nodes), [nodes])
  const fallback = nodes.find((n) => n.online && n.condition === 'critical') || nodes.find((n) => n.online && n.condition === 'warning') || nodes[0]
  const sel = nodes.find((n) => n.node_id === selected) || fallback
  const sys = t.system_status || 'nominal'
  const score = t.overall_anomaly_score ?? 0

  return (
    <section className="twin" aria-labelledby="twin-title" data-testid="digital-twin">
      <div className="twin-top">
        <div>
          <h2 id="twin-title">Digital twin</h2>
          <p className="small muted">{t.structure_name} · {t.total_nodes} sensor node{t.total_nodes === 1 ? '' : 's'} · tap a sensor for its readings</p>
        </div>
        <div className="pill-tabs" role="group" aria-label="Show floor">
          {[null, ...view.layout.floors].map((f) => (
            <button key={f ?? 'all'} type="button" className="pill-tab" aria-pressed={floor === f} onClick={() => setFloor(f)}
              data-testid={`twin-floor-${f == null ? 'all' : floorName(f).toLowerCase()}`}>
              {f == null ? 'All floors' : floorName(f)}
            </button>
          ))}
        </div>
      </div>

      <div className="twin-body">
        <div className="twin-side">
          <GlassPanel title="Building data" icon={Building2} testid="twin-building-data">
            <Row k="Building">{t.structure_name}</Row>
            <Row k="Floors with sensors" testid="twin-floors">{describeFloors(view.layout)}</Row>
            <Row k="Sensor nodes" testid="status-active-nodes">
              <span className={t.active_nodes < t.total_nodes ? 'c-warning' : ''}>{t.active_nodes}/{t.total_nodes} online</span>
            </Row>
            <Row k="Sensors / node">3 · HX711 · ADXL345 · DS18B20</Row>
          </GlassPanel>
          <GlassPanel title="Status" icon={Gauge} testid="status-strip">
            <Row k="System" testid="status-system"><Badge value={sys} label={sys} /></Row>
            <Row k="Last sync" testid="status-last-sync"><span className="mono">{t.last_reading_at ? fmtTime(t.last_reading_at) : '—'}</span></Row>
            <Row k="Open alerts" testid="status-open-alerts"><span className={`mono ${t.open_alerts ? 'c-critical' : 'c-nominal'}`}>{t.open_alerts}</span></Row>
            <Row k="Early warnings"><span className={`mono ${t.open_early_warnings ? 'c-info' : ''}`}>{t.open_early_warnings}</span></Row>
            <Row k="Anomaly score" testid="status-anomaly-score">
              <span className={`mono c-${score >= 90 ? 'critical' : score >= 40 ? 'warning' : 'nominal'}`}>{fmtNum(score, 0)}/100</span>
            </Row>
          </GlassPanel>
        </div>

        <div className="twin-stage" data-testid="structural-map">
          <IsoBuilding nodes={nodes} params={t.parameters} view={view} selectedId={sel?.node_id} floor={floor} onSelect={setSelected} />
          <div className="map-legend twin-legend" aria-hidden="true">
            <span><span className="dot nominal" />Nominal</span>
            <span><span className="dot warning" />Warning</span>
            <span><span className="dot critical" />Critical</span>
            <span><span className="dot" />Offline</span>
          </div>
        </div>

        <div className="twin-side">
          {sel ? (
            <GlassPanel title="Selected sensor node" icon={Radio} testid="map-pin-detail">
              <div className="glass-body">
                <label className="sr-only" htmlFor="twin-node-select">Sensor node</label>
                <select id="twin-node-select" value={sel.node_id} onChange={(e) => setSelected(e.target.value)} data-testid="twin-node-select">
                  {nodes.map((n, i) => <option key={n.node_id} value={n.node_id}>#{i + 1} {n.node_id}</option>)}
                </select>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Badge value={sel.online ? sel.condition : 'offline'} />
                  <span className="xs dim">seen {fmtAgo(sel.last_seen)}</span>
                </div>
                <div className="row small twin-loc" data-testid="map-pin-location">
                  <MapPin size={13} aria-hidden="true" /> <span className="break">{sel.location}</span>
                </div>
                {t.parameters.map((p) => <ReadingSlider key={p.parameter} p={p} reading={sel.latest?.[p.parameter]} online={sel.online} />)}
                <div className="glass-row"><span className="k">Battery</span><span className="v mono">{fmtNum(sel.battery, 0)}%</span></div>
                <div className="glass-row"><span className="k">Wi-Fi RSSI</span><span className="v mono">{sel.rssi ?? '—'} dBm</span></div>
                <Link to={`/nodes/${sel.node_id}`} className="btn btn-primary btn-sm" data-testid="map-pin-open-node-link">
                  Open node page <ArrowUpRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </GlassPanel>
          ) : null}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ gauges */
// Dotted 270° gauge from 0 to the critical level; dots past warning go amber, past the safe limit red.
export function RadialGauge({ p, value, light = false, size = 150 }) {
  const N = 34
  const crit = p.critical_threshold || p.safe_threshold * 1.25
  const frac = value == null ? 0 : clamp(value / crit, 0, 1)
  const warnF = (p.warning_threshold || p.safe_threshold * 0.8) / crit
  const safeF = p.safe_threshold / crit
  const r = 62
  const dots = Array.from({ length: N }, (_, i) => {
    const f = i / (N - 1)
    const a = ((135 + f * 270) * Math.PI) / 180
    const on = value != null && f <= frac + 1e-9
    const color = f >= safeF ? STATUS_COLOR.critical : f >= warnF ? STATUS_COLOR.warning : STATUS_COLOR.nominal
    return { key: i, cx: 80 + r * Math.cos(a), cy: 80 + r * Math.sin(a), on, color, op: 0.35 + 0.65 * f }
  })
  const sa = ((135 + safeF * 270) * Math.PI) / 180
  return (
    <svg className="gauge" width={size} height={size} viewBox="0 0 160 160" aria-hidden="true">
      {dots.map((d) => (
        <circle key={d.key} cx={d.cx} cy={d.cy} r={d.on ? 3.6 : 3} fill={d.on ? d.color : (light ? '#d9dce1' : '#2a2f36')} opacity={d.on ? d.op : 1} />
      ))}
      <line x1={80 + 52 * Math.cos(sa)} y1={80 + 52 * Math.sin(sa)} x2={80 + 72 * Math.cos(sa)} y2={80 + 72 * Math.sin(sa)}
        stroke={light ? '#0b0c0e' : '#fff'} strokeWidth="2" strokeLinecap="round" />
      <circle cx="80" cy="80" r="40" fill={light ? '#fff' : '#0e1013'} stroke={light ? '#e3e6ea' : '#2f343b'} strokeWidth="5" />
    </svg>
  )
}

export function MetricCard({ p, light = false }) {
  const cur = p.current
  const Icon = PARAM_ICON[p.parameter]
  const status = !p.enabled ? 'disabled' : cur && !cur.online ? 'offline' : cur?.status || 'nominal'
  const a = p.anomaly
  return (
    <article className={`metric-card gauge-card ${status} ${light ? 'light' : ''}`} data-testid={`telemetry-${p.parameter}-card`} aria-label={`${p.label} reading`}>
      <div className="metric-top">
        <span className="metric-name"><Icon size={15} aria-hidden="true" />{PARAM_SHORT[p.parameter]}</span>
        <Badge value={status} testid={`telemetry-${p.parameter}-status`} />
      </div>
      <div className="xs dim" data-testid={`telemetry-${p.parameter}-sensor`}>{p.sensor || SENSOR[p.parameter]}</div>
      <div className="gauge-wrap">
        <RadialGauge p={p} value={cur?.value} light={light} />
        <div className="gauge-center">
          <div className={`gauge-value ${status === 'critical' ? 'c-critical' : status === 'warning' ? 'c-warning' : ''}`} data-testid={`telemetry-${p.parameter}-value`}>
            {cur ? fmtValue(p.parameter, cur.value) : '—'}
          </div>
          <div className="gauge-unit">{p.unit || UNITS[p.parameter]}</div>
        </div>
      </div>
      <div className="metric-meta">
        <div><div className="k">Safe limit</div><div className="v" data-testid={`telemetry-${p.parameter}-limit`}>{p.safe_threshold} {p.unit}</div></div>
        <div><div className="k">Anomaly</div>
          <div className={`v c-${a?.level === 'critical' ? 'critical' : a?.level === 'warning' || a?.level === 'watch' ? 'warning' : 'nominal'}`}
            data-testid={`telemetry-${p.parameter}-anomaly-score`}>{a ? fmtNum(a.score, 0) : '—'} <span className="dim">{a?.level || ''}</span></div></div>
        <div><div className="k">Trend</div><div className="v row" style={{ gap: 4 }} data-testid={`telemetry-${p.parameter}-trend`}>
          <TrendIcon trend={a?.trend} />{a?.trend || '—'}</div></div>
        <div><div className="k">Node</div><div className="v">{cur?.node_id || '—'}</div></div>
      </div>
      <Sparkline data={p.series} threshold={p.safe_threshold} status={status} height={40} testid={`telemetry-${p.parameter}-sparkline`} />
      <div className="metric-loc" data-testid={`telemetry-${p.parameter}-location`} title={cur?.location}>
        <MapPin size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{cur?.location || 'No sensor reporting'}</span>
      </div>
    </article>
  )
}

/* ------------------------------------------------------------ health hexagons */
function hexPoints(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30)
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')
}

export function SensorHealth({ t }) {
  const nodes = [...(t.nodes || [])].sort((a, b) => a.node_id.localeCompare(b.node_id))
  const cells = nodes.flatMap((n) => PARAMS.map((p) => {
    const r = n.latest?.[p]
    const status = !n.online || !r ? 'offline' : r.status
    return { key: `${n.node_id}-${p}`, node: n.node_id, p, status, value: r?.value }
  }))
  const normal = cells.filter((c) => c.status === 'nominal').length
  const pct = cells.length ? Math.round((normal / cells.length) * 100) : 0
  const R = 13
  const colW = R * Math.sqrt(3)
  return (
    <section className="panel health-card" aria-labelledby="health-title" data-testid="sensor-health">
      <div className="panel-head"><h2 id="health-title">Sensor health</h2><span className="dim small">{cells.length} sensors</span></div>
      <div className="health-body">
        <div>
          <div className="health-pct" data-testid="sensor-health-percent">{pct}%</div>
          <div className="small muted">of sensors reading normal</div>
          <div className="map-legend" style={{ marginTop: 12, flexDirection: 'column', gap: 6 }} aria-hidden="true">
            <span><span className="dot nominal" />Normal</span>
            <span><span className="dot warning" />Near limit</span>
            <span><span className="dot critical" />Over limit</span>
            <span><span className="dot" />Offline / no data</span>
          </div>
        </div>
        <svg className="hex-grid" viewBox={`0 0 ${Math.max(1, nodes.length) * colW + colW / 2 + 8} ${3 * R * 1.5 + R + 8}`} role="img"
          aria-label={`${normal} of ${cells.length} sensors normal`}>
          {cells.map((c, idx) => {
            const col = Math.floor(idx / 3)
            const row = idx % 3
            const cx = 4 + colW / 2 + col * colW + (row % 2 ? colW / 2 : 0)
            const cy = 4 + R + row * R * 1.5
            return (
              <polygon key={c.key} points={hexPoints(cx, cy, R - 1.2)} fill={STATUS_COLOR[c.status] || STATUS_COLOR.offline}
                fillOpacity={c.status === 'offline' ? 0.35 : 0.85} stroke="#0b0c0e" strokeWidth="1.5" data-testid={`hex-${c.key.toLowerCase()}`}>
                <title>{`${c.node} · ${PARAM_SHORT[c.p]}: ${c.value != null ? fmtValue(c.p, c.value) : 'no data'} (${c.status})`}</title>
              </polygon>
            )
          })}
        </svg>
      </div>
      <div className="xs dim" style={{ padding: '0 16px 14px' }}>Each column is a node (strain, vibration, temperature from top).</div>
    </section>
  )
}

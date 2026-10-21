// Top-view floor plans: one plan per floor on a structural grid, each sensor node a dot at its
// spot on that floor. A node's spot is plan_x / plan_y (% of the floor from the left / top), set by
// an administrator on the Nodes page; nodes without a spot wait along the bottom edge (dashed ring).
import { useState } from 'react'
import { floorName } from '../lib/format'

const STATUS_COLOR = { nominal: '#2fd17a', warning: '#f5a524', critical: '#ff4d4f', offline: '#6f7683' }
const BOX = { x0: 46, y0: 36, x1: 584, y1: 362 } // the floor slab inside the 600 x 380 drawing
const COLS = 6
const ROWS = 4

const floorKey = (f) => (f == null ? 'none' : String(f))
const toXY = (px, py) => [BOX.x0 + (px / 100) * (BOX.x1 - BOX.x0), BOX.y0 + (py / 100) * (BOX.y1 - BOX.y0)]

/** Floor keys that have nodes, bottom to top, then the roof, then nodes with no floor. */
export function planFloors(nodes) {
  const keys = new Set(nodes.map((n) => floorKey(n.floor)))
  const nums = [...keys].filter((k) => k !== 'roof' && k !== 'none').map(Number).sort((a, b) => a - b)
  return [...nums.map(String), ...(keys.has('roof') ? ['roof'] : []), ...(keys.has('none') ? ['none'] : [])]
}

export const planName = (k) => (k === 'none' ? 'No floor' : floorName(k === 'roof' ? 'roof' : Number(k)))
const keySlug = (k) => planName(k).toLowerCase().replace(/\s+/g, '-')

function spots(nodes) {
  const waiting = nodes.filter((n) => n.plan_x == null || n.plan_y == null)
  return Object.fromEntries(nodes.map((n) => {
    if (n.plan_x != null && n.plan_y != null) return [n.node_id, { x: n.plan_x, y: n.plan_y, placed: true }]
    const i = waiting.indexOf(n)
    return [n.node_id, { x: ((i + 1) / (waiting.length + 1)) * 100, y: 90, placed: false }]
  }))
}

export function FloorPlan({ nodes, label, selectedId, onSelect, compact = false, pickAt, onPick, testid }) {
  const at = spots(nodes)
  const click = (e) => {
    if (!onPick) return
    const svg = e.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM().inverse())
    const x = ((p.x - BOX.x0) / (BOX.x1 - BOX.x0)) * 100
    const y = ((p.y - BOX.y0) / (BOX.y1 - BOX.y0)) * 100
    if (x < 0 || x > 100 || y < 0 || y > 100) return
    onPick({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
  }
  const colX = Array.from({ length: COLS + 1 }, (_, i) => BOX.x0 + (i * (BOX.x1 - BOX.x0)) / COLS)
  const rowY = Array.from({ length: ROWS + 1 }, (_, j) => BOX.y0 + (j * (BOX.y1 - BOX.y0)) / ROWS)
  const pick = pickAt && pickAt.x != null && pickAt.y != null ? toXY(pickAt.x, pickAt.y) : null

  return (
    <svg className={`plan-svg ${onPick ? 'pickable' : ''} ${compact ? 'compact' : ''}`} viewBox="0 0 600 380" role="group"
      aria-label={`Floor plan of ${label}`} data-testid={testid} onClick={click}>
      {/* slab and structural grid (columns A, B, C ... across, 1, 2, 3 ... down) */}
      <rect x={BOX.x0} y={BOX.y0} width={BOX.x1 - BOX.x0} height={BOX.y1 - BOX.y0} rx="6" className="plan-slab" />
      {colX.map((x, i) => (
        <g key={`c${i}`}>
          <line x1={x} y1={BOX.y0 - 10} x2={x} y2={BOX.y1} className="plan-axis" />
          {!compact ? <><circle cx={x} cy={BOX.y0 - 20} r="9" className="plan-bubble" />
            <text x={x} y={BOX.y0 - 16.5} className="plan-bubble-text">{String.fromCharCode(65 + i)}</text></> : null}
        </g>
      ))}
      {rowY.map((y, j) => (
        <g key={`r${j}`}>
          <line x1={BOX.x0 - 10} y1={y} x2={BOX.x1} y2={y} className="plan-axis" />
          {!compact ? <><circle cx={BOX.x0 - 24} cy={y} r="9" className="plan-bubble" />
            <text x={BOX.x0 - 24} y={y + 3.5} className="plan-bubble-text">{j + 1}</text></> : null}
        </g>
      ))}
      {colX.flatMap((x) => rowY.map((y) => <rect key={`k${x}-${y}`} x={x - 4} y={y - 4} width="8" height="8" className="plan-column" />))}
      {nodes.some((n) => !at[n.node_id].placed) ? (
        <text x={BOX.x0 + 8} y={toXY(0, 90)[1] - 16} className="plan-note">Spot not set</text>
      ) : null}

      {nodes.map((n) => {
        const s = at[n.node_id]
        const [x, y] = toXY(s.x, s.y)
        const cond = n.online ? n.condition : 'offline'
        const color = STATUS_COLOR[cond] || STATUS_COLOR.nominal
        const sel = selectedId === n.node_id
        return (
          <g key={n.node_id} className="map-pin" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined} aria-label={`${n.node_id}, ${n.location || ''}, status ${cond}`} aria-pressed={onSelect ? sel : undefined}
            data-testid={`map-pin-${n.node_id.toLowerCase()}`} data-status={cond} data-floor={floorKey(n.floor) === 'none' ? 'unknown' : floorKey(n.floor)}
            data-placed={s.placed ? 'true' : 'false'}
            onClick={(e) => { e.stopPropagation(); onSelect?.(n.node_id) }}
            onKeyDown={(e) => { if (onSelect && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(n.node_id) } }}>
            <title>{`${n.node_id} — ${n.location || ''}`}</title>
            {cond === 'critical' ? <circle className="pin-pulse" r={compact ? 14 : 12} fill={color} /> : null}
            <circle r={compact ? 14 : 11} fill="#0a0b0d" stroke={sel ? '#fff' : color} strokeWidth={sel ? 3 : 2}
              strokeDasharray={s.placed ? undefined : '3 3'} />
            <circle r={compact ? 8 : 6} fill={color} />
            {!compact ? <text y="26" className="plan-pin-label">{n.node_id}</text> : null}
          </g>
        )
      })}

      {pick ? (
        <g className="plan-pick" transform={`translate(${pick[0].toFixed(1)} ${pick[1].toFixed(1)})`} data-testid="plan-pick-marker" pointerEvents="none">
          <circle r="13" />
          <line x1="-20" y1="0" x2="20" y2="0" />
          <line x1="0" y1="-20" x2="0" y2="20" />
        </g>
      ) : null}
      {nodes.length === 0 && !onPick ? <text x="315" y="204" className="plan-empty">No sensor nodes on this floor</text> : null}
    </svg>
  )
}

/** Tabs per floor: "All floors" shows every plan side by side; a floor shows its plan large. */
export function FloorPlans({ nodes, selectedId, onSelect, testid }) {
  const floors = planFloors(nodes)
  const [floor, setFloor] = useState('all')
  const current = floor !== 'all' && floors.includes(floor) ? floor : 'all'
  const of = (k) => nodes.filter((n) => floorKey(n.floor) === k)
  return (
    <div className="plans" data-testid={testid}>
      <div className="pill-tabs plans-tabs" role="group" aria-label="Floor plan">
        <button type="button" className="pill-tab" aria-pressed={current === 'all'} onClick={() => setFloor('all')} data-testid="plan-tab-all">All floors</button>
        {floors.map((k) => (
          <button key={k} type="button" className="pill-tab" aria-pressed={current === k} onClick={() => setFloor(k)} data-testid={`plan-tab-${keySlug(k)}`}>
            {planName(k)}
          </button>
        ))}
      </div>
      {nodes.length === 0 ? (
        <div className="plans-empty" data-testid="plans-empty">No sensor nodes connected yet</div>
      ) : current === 'all' ? (
        <div className="plans-grid">
          {floors.map((k) => (
            <figure key={k} className="plan-card" data-testid={`plan-card-${keySlug(k)}`}>
              <figcaption>
                <button type="button" onClick={() => setFloor(k)}>{planName(k)}</button>
                <span>{of(k).length} node{of(k).length === 1 ? '' : 's'}</span>
              </figcaption>
              <FloorPlan nodes={of(k)} label={planName(k)} selectedId={selectedId} onSelect={onSelect} compact />
            </figure>
          ))}
        </div>
      ) : (
        <FloorPlan nodes={of(current)} label={planName(current)} selectedId={selectedId} onSelect={onSelect} testid={`plan-${keySlug(current)}`} />
      )}
    </div>
  )
}

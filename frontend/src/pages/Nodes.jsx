import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowLeft, Battery, BatteryLow, Cpu, MapPin, Pencil, Plus, Trash2, Wifi, WifiOff } from 'lucide-react'
import { FloorPlan } from '../components/FloorPlan'
import { AlertStream, PARAM_ICON, TrendIcon } from '../components/monitoring'
import { Badge, Dialog, EmptyState, ErrorState, Loading } from '../components/ui'
import { api } from '../lib/api'
import { useFetch, useLive, useToast } from '../lib/context'
import { PARAMS, PARAM_SHORT, SENSOR, floorName, fmtAgo, fmtDateTime, fmtNum, fmtTime, fmtValue } from '../lib/format'
import { chartTooltipStyle } from './LiveTelemetry'

const STATUS_COLOR = { nominal: '#2fd17a', warning: '#f5a524', critical: '#ff4d4f', muted: '#6f7683' }

// Half-circle gauge from 0 to the critical level, with a tick at the safe limit.
function SemiGauge({ value, th, status }) {
  const crit = th.critical_threshold || th.safe_threshold * 1.25
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / crit) * 100))
  const safeA = Math.PI * (1 - th.safe_threshold / crit)
  const color = STATUS_COLOR[status] || STATUS_COLOR.muted
  return (
    <svg className="semi-gauge" viewBox="0 0 120 68" aria-hidden="true">
      <defs>
        <linearGradient id={`sg-${th.parameter}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={color} stopOpacity=".35" /><stop offset="1" stopColor={color} />
        </linearGradient>
      </defs>
      <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="11" strokeLinecap="round" />
      <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke={`url(#sg-${th.parameter})`} strokeWidth="11" strokeLinecap="round"
        pathLength="100" strokeDasharray={`${pct} 100`} />
      <line x1={60 + 40 * Math.cos(safeA)} y1={60 - 40 * Math.sin(safeA)} x2={60 + 60 * Math.cos(safeA)} y2={60 - 60 * Math.sin(safeA)}
        stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function BatteryCell({ value }) {
  const low = value != null && value < 20
  const Icon = low ? BatteryLow : Battery
  return <span className={`battery ${low ? 'c-critical' : ''}`}><Icon size={14} aria-hidden="true" />{fmtNum(value, 0)}%</span>
}

const FLOOR_OPTIONS = [
  ['', 'From the location text'], ['-3', 'B3 · basement 3'], ['-2', 'B2 · basement 2'], ['-1', 'B1 · basement'],
  ['0', 'GF · ground floor'], ...Array.from({ length: 40 }, (_, i) => [String(i + 1), `${i + 1}F · floor ${i + 1}`]), ['roof', 'Roof'],
]

// Register a node before it reports, or change where an existing node is and whose it is.
function NodeForm({ initial, nodes, onClose, onSaved }) {
  const editing = !!initial
  const users = useFetch('/api/users')
  const [form, setForm] = useState({
    node_id: initial?.node_id || '', location: initial?.location || '',
    floor: initial?.floor == null ? '' : String(initial.floor), owner_id: initial?.owner_id || '',
    plan_x: initial?.plan_x ?? null, plan_y: initial?.plan_y ?? null,
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const floorValue = form.floor === '' ? null : form.floor === 'roof' ? 'roof' : Number(form.floor)
  const others = nodes.filter((n) => n.node_id !== initial?.node_id && floorValue != null && String(n.floor) === String(floorValue))
  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!editing && !/^[A-Za-z0-9_-]{1,32}$/.test(form.node_id.trim())) { setError('Node ID: letters, digits, - or _ (up to 32)'); return }
    setBusy(true)
    const body = { location: form.location, floor: floorValue, owner_id: form.owner_id || null, plan_x: form.plan_x, plan_y: form.plan_y }
    try {
      if (editing) await api(`/api/nodes/${encodeURIComponent(initial.node_id)}`, { method: 'PATCH', body })
      else await api('/api/nodes', { method: 'POST', body: { ...body, node_id: form.node_id.trim() } })
      onSaved(editing ? `${initial.node_id} updated` : `${form.node_id.trim().toUpperCase()} added`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={editing ? `Edit ${initial.node_id}` : 'Add sensor node'} onClose={onClose} testid="node-form-dialog">
      <form onSubmit={submit} className="stack node-form" noValidate>
        {!editing ? (
          <label className="field"><span className="field-label">Node ID (the NODE_ID in the ESP32 sketch)</span>
            <input value={form.node_id} onChange={set('node_id')} className="mono" placeholder="ESP32-08" data-testid="node-form-id-input" />
          </label>
        ) : null}
        <label className="field"><span className="field-label">Location</span>
          <input value={form.location} onChange={set('location')} placeholder="Column C2, east face" data-testid="node-form-location-input" />
        </label>
        <div className="grid grid-2">
          <label className="field"><span className="field-label">Floor</span>
            <select value={form.floor} onChange={set('floor')} data-testid="node-form-floor-select">
              {FLOOR_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">Belongs to</span>
            <select value={form.owner_id} onChange={set('owner_id')} data-testid="node-form-owner-select">
              <option value="">The site (admin devices)</option>
              {(users.data?.items || []).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
            </select>
          </label>
        </div>
        <div className="field">
          <span className="field-label">
            Spot on the {floorValue == null ? 'floor' : floorName(floorValue)} plan: click to place
            {form.plan_x != null ? <span className="mono dim"> ({form.plan_x}% across, {form.plan_y}% down)</span> : null}
          </span>
          <FloorPlan nodes={others} label={floorValue == null ? 'the floor' : floorName(floorValue)}
            pickAt={{ x: form.plan_x, y: form.plan_y }} onPick={(pt) => setForm((f) => ({ ...f, plan_x: pt.x, plan_y: pt.y }))} testid="node-form-plan" />
          {form.plan_x != null ? (
            <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm((f) => ({ ...f, plan_x: null, plan_y: null }))}
              data-testid="node-form-clear-spot">Clear spot</button>
          ) : null}
        </div>
        {error ? <p className="field-error" role="alert" data-testid="node-form-error">{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} data-testid="node-form-cancel-button">Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="node-form-submit-button">{busy ? 'Saving…' : editing ? 'Save' : 'Add node'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function NodeCard({ n, onEdit, onDelete }) {
  const id = n.node_id.toLowerCase()
  const cond = n.online ? n.condition : 'offline'
  return (
    <article className={`node-card ${cond}`} data-testid={`sensor-node-card-${id}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row"><Cpu size={16} className="c-info" aria-hidden="true" /><strong className="mono" data-testid={`sensor-node-id-${id}`}>{n.node_id}</strong></div>
        <Badge value={n.online ? 'online' : 'offline'} testid={`sensor-node-status-${id}`} />
      </div>
      <div className="row small" style={{ alignItems: 'flex-start' }}>
        <MapPin size={13} aria-hidden="true" style={{ marginTop: 3, flexShrink: 0 }} /><span className="break" data-testid={`sensor-node-location-${id}`}>{n.location}</span>
      </div>
      <div className="kv">
        <div><div className="k">Last seen</div><div className="v" title={n.last_seen}>{fmtAgo(n.last_seen)}</div></div>
        <div><div className="k">Condition</div><div className="v"><Badge value={cond} /></div></div>
        <div><div className="k">Battery</div><div className="v" data-testid={`sensor-node-battery-${id}`}><BatteryCell value={n.battery} /></div></div>
        <div><div className="k">Wi-Fi RSSI</div><div className="v row" style={{ gap: 4 }} data-testid={`sensor-node-rssi-${id}`}>
          {n.online ? <Wifi size={13} aria-hidden="true" /> : <WifiOff size={13} aria-hidden="true" />}{n.rssi ?? '—'} dBm</div></div>
        <div><div className="k">Firmware</div><div className="v">{n.firmware}</div></div>
        <div><div className="k">Data source</div><div className="v">{n.data_source ? <Badge value={n.data_source} /> : '—'}</div></div>
        <div><div className="k">Calibration</div><div className="v"><Badge value={n.calibration_status} /></div></div>
        <div><div className="k">Error status</div><div className={`v ${n.error ? 'c-critical' : 'c-nominal'}`} data-testid={`sensor-node-error-${id}`}>{n.error || 'None'}</div></div>
        <div><div className="k">Floor</div><div className="v" data-testid={`sensor-node-floor-${id}`}>{n.floor == null ? '—' : floorName(n.floor)}</div></div>
        <div><div className="k">Belongs to</div><div className="v break" data-testid={`sensor-node-owner-${id}`}>{n.owner_email || 'The site'}</div></div>
      </div>
      <div>
        <div className="field-label dim" style={{ marginBottom: 4 }}>Last reading {n.last_reading_at ? `· ${fmtTime(n.last_reading_at)}` : ''}</div>
        <div className="readings-mini" style={{ marginTop: 0 }}>
          {PARAMS.map((p) => {
            const r = n.latest?.[p]
            return (
              <div key={p}><div className="k">{PARAM_SHORT[p]}</div>
                <div className={`v c-${n.online ? r?.status || 'muted' : 'muted'}`} style={{ fontSize: 12 }}>{r ? fmtValue(p, r.value) : '—'}</div></div>
            )
          })}
        </div>
      </div>
      <div className="row node-card-actions">
        <Link to={`/nodes/${n.node_id}`} className="btn btn-sm" data-testid={`sensor-node-detail-link-${id}`}>View history & charts →</Link>
        <button type="button" className="btn btn-sm" onClick={() => onEdit(n)} data-testid={`sensor-node-edit-${id}`} aria-label={`Edit ${n.node_id}`}>
          <Pencil size={13} aria-hidden="true" /> Edit
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(n)} data-testid={`sensor-node-delete-${id}`} aria-label={`Delete ${n.node_id}`}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

export function NodesPage() {
  const { telemetry } = useLive()
  const { push } = useToast()
  const { data, error, loading, reload } = useFetch('/api/nodes', null, [telemetry?.last_reading_at])
  const [editing, setEditing] = useState(undefined) // undefined = closed, null = new node, object = edit
  const [confirm, setConfirm] = useState(null)
  const remove = async () => {
    try {
      await api(`/api/nodes/${encodeURIComponent(confirm.node_id)}`, { method: 'DELETE' })
      push({ kind: 'success', title: `${confirm.node_id} deleted`, testid: 'node-delete-success-toast' })
      reload()
    } catch (e) {
      push({ kind: 'error', title: 'Could not delete the node', body: e.message })
    } finally {
      setConfirm(null)
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Sensor nodes</h1>
          <p>ESP32 field devices · offline after {30}s without data · add a node here before it reports, or edit where it is</p>
        </div>
        <div className="page-actions">
          {data ? (
            <>
              <Badge value="online" label={`${data.items.filter((n) => n.online).length} online`} testid="nodes-online-count" />
              <Badge value="offline" label={`${data.items.filter((n) => !n.online).length} offline`} testid="nodes-offline-count" />
            </>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)} data-testid="node-add-button">
            <Plus size={14} aria-hidden="true" /> Add node
          </button>
        </div>
      </div>
      {error ? <div className="panel"><ErrorState error={error} onRetry={reload} testid="nodes-error-state" /></div>
        : !data ? <Loading label="Loading nodes…" testid="nodes-loading-state" />
          : data.items.length === 0 ? <div className="panel"><EmptyState title="No sensor nodes" message="Nodes register automatically when they first send data, or add one with Add node." testid="nodes-empty-state" /></div>
            : <div className="node-grid" data-testid="node-grid" aria-busy={loading}>{data.items.map((n) => <NodeCard key={n.node_id} n={n} onEdit={setEditing} onDelete={setConfirm} />)}</div>}
      {editing !== undefined ? (
        <NodeForm initial={editing} nodes={data?.items || []} onClose={() => setEditing(undefined)}
          onSaved={(msg) => { setEditing(undefined); push({ kind: 'success', title: msg, testid: 'node-save-success-toast' }); reload() }} />
      ) : null}
      {confirm ? (
        <Dialog title={`Delete ${confirm.node_id}?`} onClose={() => setConfirm(null)} testid="node-delete-dialog">
          <p>Remove <span className="mono">{confirm.node_id}</span> from the site? Its past readings and alerts stay in the history. If the device sends data again, it comes back as a new node.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setConfirm(null)} data-testid="node-delete-cancel-button">Cancel</button>
            <button type="button" className="btn btn-danger" onClick={remove} data-testid="node-delete-confirm-button">Delete node</button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

function NodeChart({ param, series, th }) {
  if (!series?.length) return <EmptyState title="No data" testid={`node-chart-empty-${param}`} />
  const Icon = PARAM_ICON[param]
  return (
    <div className="panel" data-testid={`node-chart-${param}`}>
      <div className="panel-head">
        <h3><Icon size={14} aria-hidden="true" /> {th.label}</h3>
        <span className="mono small">{fmtValue(param, series[series.length - 1].v)} {th.unit}</span>
      </div>
      <div className="chart-box" style={{ padding: '8px 4px 4px 0' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 6, right: 10, bottom: 0, left: -10 }}>
            <defs>
              <linearGradient id={`nc-${param}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ff7a1a" stopOpacity=".38" /><stop offset="1" stopColor="#ff7a1a" stopOpacity="0" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,.06)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmtTime} stroke="#6f7683" fontSize={10} minTickGap={50} tickLine={false} axisLine={false} />
            <YAxis stroke="#6f7683" fontSize={10} domain={['auto', 'auto']} width={50} tickLine={false} axisLine={false} />
            <Tooltip {...chartTooltipStyle} labelFormatter={fmtDateTime} formatter={(v) => [`${fmtValue(param, v)} ${th.unit}`, PARAM_SHORT[param]]} />
            <ReferenceLine y={th.safe_threshold} stroke="#ff4d4f" strokeDasharray="5 4" ifOverflow="extendDomain" />
            <ReferenceLine y={th.warning_threshold} stroke="#f5a524" strokeDasharray="2 4" ifOverflow="hidden" />
            <Area dataKey="v" type="monotone" stroke="#ff7a1a" strokeWidth={2} fill={`url(#nc-${param})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function NodeDetailPage() {
  const { nodeId } = useParams()
  const { telemetry } = useLive()
  const { data, error, reload } = useFetch(`/api/nodes/${encodeURIComponent(nodeId)}`, { points: 120 }, [telemetry?.last_reading_at])
  if (error) {
    return (
      <div className="panel">
        {error.status === 404 ? <EmptyState title="Sensor node not found" message={`No node with ID ${nodeId} has reported.`} testid="node-not-found-state" />
          : <ErrorState error={error} onRetry={reload} testid="node-detail-error-state" />}
      </div>
    )
  }
  if (!data) return <Loading label="Loading node…" testid="node-detail-loading-state" />
  const n = data.node
  return (
    <>
      <section className="node-hero">
        <div className="node-hero-main">
          <Link to="/nodes" className="small row" style={{ gap: 4 }} data-testid="node-detail-back-link"><ArrowLeft size={13} aria-hidden="true" /> All nodes</Link>
          <div className="node-hero-eyebrow">Sensor node · 3 sensors</div>
          <h1 data-testid="page-title" className="row node-hero-title">{n.node_id} <Badge value={n.online ? 'online' : 'offline'} testid="node-detail-status" /></h1>
          <p className="row node-hero-loc"><MapPin size={14} aria-hidden="true" /> <span data-testid="node-detail-location">{n.location}</span></p>
          <div className="node-chips" data-testid="node-detail-summary">
            <div><span className="k">Last seen</span><span className="v">{fmtDateTime(n.last_seen)}</span></div>
            <div><span className="k">Battery</span><span className="v"><BatteryCell value={n.battery} /></span></div>
            <div><span className="k">Wi-Fi RSSI</span><span className="v">{n.rssi ?? '—'} dBm</span></div>
            <div><span className="k">Firmware</span><span className="v">{n.firmware}</span></div>
            <div><span className="k">Data source</span><span className="v">{n.data_source || '—'}</span></div>
            <div><span className="k">Calibration</span><span className="v">{n.calibration_status} · {fmtDateTime(n.calibrated_at).split(' ').slice(0, 3).join(' ')}</span></div>
            <div><span className="k">Error status</span><span className={`v ${n.error ? 'c-critical' : 'c-nominal'}`}>{n.error || 'None'}</span></div>
          </div>
        </div>
        <div className="node-gauges" data-testid="node-gauges">
          {PARAMS.map((p) => {
            const r = n.latest?.[p]
            const th = data.thresholds[p]
            const status = n.online && r ? r.status : 'muted'
            const Icon = PARAM_ICON[p]
            return (
              <article key={p} className={`gauge-tile ${status}`} data-testid={`node-gauge-${p}`}>
                <div className="gauge-tile-head">
                  <span><Icon size={14} aria-hidden="true" /> {PARAM_SHORT[p]}</span>
                  <span className="xs dim">{SENSOR[p]}</span>
                </div>
                <div className="gauge-tile-body">
                  <div>
                    <div className="gauge-tile-pct">{r ? `${fmtNum((r.value / th.safe_threshold) * 100, 0)}%` : '—'}</div>
                    <div className="xs dim">of safe limit</div>
                    <div className={`mono small c-${status}`} style={{ marginTop: 6 }}>{r ? `${fmtValue(p, r.value)} ${th.unit}` : 'No data'}</div>
                  </div>
                  <SemiGauge value={r?.value} th={{ ...th, parameter: p }} status={status} />
                </div>
              </article>
            )
          })}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Latest reading & anomaly</h2></div>
        <div className="table-wrap">
          <table className="data responsive" data-testid="node-latest-table">
            <thead><tr><th>Parameter</th><th>Value</th><th>Safe limit</th><th>Status</th><th>Rolling avg</th><th>Trend</th><th>Score</th><th>Reason</th></tr></thead>
            <tbody>
              {PARAMS.map((p) => {
                const r = n.latest?.[p]; const a = data.anomaly?.[p]; const th = data.thresholds[p]
                return (
                  <tr key={p} data-testid={`node-latest-row-${p}`}>
                    <td data-label="Parameter">{th.label}</td>
                    <td data-label="Value" className={`num c-${r?.status}`}>{r ? `${fmtValue(p, r.value)} ${th.unit}` : '—'}</td>
                    <td data-label="Safe limit" className="num">{th.safe_threshold} {th.unit}</td>
                    <td data-label="Status">{r ? <Badge value={r.status} /> : '—'}</td>
                    <td data-label="Rolling avg" className="num">{a ? fmtValue(p, a.rolling_avg) : '—'}</td>
                    <td data-label="Trend"><span className="row" style={{ gap: 4 }}><TrendIcon trend={a?.trend} />{a?.trend || '—'}</span></td>
                    <td data-label="Score" className="num">{a ? `${fmtNum(a.score, 0)} · ${a.confidence}%` : '—'}</td>
                    <td data-label="Reason" className="small">{a?.reason || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid grid-2" data-testid="node-detail-charts">
        {PARAMS.map((p) => <NodeChart key={p} param={p} series={data.series[p]} th={data.thresholds[p]} />)}
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Recent alerts for this node</h2></div>
        <AlertStream alerts={data.alerts} />
      </section>
    </>
  )
}

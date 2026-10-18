import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { BarChart3, Brain, Table2 } from 'lucide-react'
import { PARAM_ICON, TrendIcon } from '../components/monitoring'
import SimulatorToggle from '../components/SimulatorToggle'
import { Badge, EmptyState, ErrorState, Loading } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useLive } from '../lib/context'
import { PARAMS, PARAM_SHORT, SENSOR, fmtAgo, fmtNum, fmtTime, fmtValue } from '../lib/format'

const STATUS_COLOR = { nominal: '#2fd17a', warning: '#f5a524', critical: '#ff4d4f', muted: '#6f7683' }

export const chartTooltipStyle = {
  contentStyle: { background: '#1a1d22', border: '1px solid rgba(255,255,255,.13)', borderRadius: 10, fontSize: 12 },
  labelStyle: { color: '#a7adb7', fontFamily: 'JetBrains Mono, monospace' },
  cursor: { fill: 'rgba(255,255,255,.04)' },
}

const statusOf = (v, p) => (v >= p.safe_threshold ? 'critical' : v >= p.warning_threshold ? 'warning' : 'nominal')

// Keeps the last few readings of every node and sensor from the 5-second live updates,
// so each table row can show a small trend line without extra requests.
export function useRollingHistory(t, size = 24) {
  const ref = useRef({ stamp: null, data: {} })
  if (t && t.last_reading_at !== ref.current.stamp) {
    ref.current.stamp = t.last_reading_at
    t.nodes.forEach((n) => PARAMS.forEach((p) => {
      const r = n.latest?.[p]
      if (!r) return
      const key = `${n.node_id}:${p}`
      const arr = ref.current.data[key] || (ref.current.data[key] = [])
      if (!arr.length || arr[arr.length - 1].t !== r.timestamp) {
        arr.push({ t: r.timestamp, v: r.value })
        if (arr.length > size) arr.shift()
      }
    }))
  }
  return ref.current.data
}

export function MiniLine({ data, color, testid }) {
  if (!data || data.length < 2) return <span className="xs dim" data-testid={testid}>collecting…</span>
  const vs = data.map((d) => d.v)
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const span = hi - lo || 1
  const points = vs.map((v, i) => `${((i / (vs.length - 1)) * 96 + 2).toFixed(1)},${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join(' ')
  return (
    <svg className="mini-line" viewBox="0 0 100 30" width="100" height="30" aria-hidden="true" data-testid={testid}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function MiniBars({ series, p, light }) {
  const vs = (series || []).slice(-14).map((s) => s.v)
  if (!vs.length) return null
  const hi = Math.max(...vs, p.safe_threshold * 0.6)
  return (
    <svg className="mini-bars" viewBox="0 0 98 34" aria-hidden="true">
      {vs.map((v, i) => {
        const h = Math.max(3, (v / hi) * 32)
        const last = i === vs.length - 1
        const st = statusOf(v, p)
        const fill = st !== 'nominal' ? STATUS_COLOR[st] : last ? (light ? '#0b0c0e' : '#f4f5f7') : (light ? '#c9cdd3' : '#3a4048')
        return <rect key={i} x={i * 7} y={34 - h} width="5" height={h} rx="1.5" fill={fill} />
      })}
    </svg>
  )
}

function KpiCard({ p, selected, onSelect }) {
  const Icon = PARAM_ICON[p.parameter]
  const cur = p.current
  const a = p.anomaly
  const status = cur ? (cur.online ? cur.status : 'offline') : 'nominal'
  const delta = cur && a?.rolling_avg ? ((cur.value - a.rolling_avg) / a.rolling_avg) * 100 : null
  const pct = cur ? (cur.value / p.safe_threshold) * 100 : 0
  return (
    <button type="button" role="tab" aria-selected={selected} className={`kpi-card ${selected ? 'selected' : ''} ${status}`}
      onClick={onSelect} data-testid={`telemetry-tab-${p.parameter}`}>
      <span className="kpi-label"><Icon size={14} aria-hidden="true" /> {PARAM_SHORT[p.parameter]} <span className="kpi-sensor">{p.sensor || SENSOR[p.parameter]}</span></span>
      <span className="kpi-main">
        <span className={`kpi-value ${status === 'critical' ? 'c-critical' : status === 'warning' ? 'c-warning' : ''}`}>
          {cur ? fmtValue(p.parameter, cur.value) : '—'}<span className="kpi-unit">{p.unit}</span>
        </span>
        <MiniBars series={p.series} p={p} light={selected} />
      </span>
      <span className="kpi-foot">
        {delta != null ? <span className={delta >= 0 ? 'c-warning' : 'c-nominal'}>{delta >= 0 ? '↗' : '↘'} {fmtNum(Math.abs(delta), 1)}%</span> : <span>—</span>}
        <span> vs rolling avg · {fmtNum(pct, 0)}% of limit · {cur?.node_id || '—'}</span>
      </span>
    </button>
  )
}

function FocusBarChart({ p }) {
  const series = p.series || []
  if (!series.length) return <EmptyState title="No readings yet" message="Waiting for the first readings for this sensor." testid="telemetry-chart-empty" />
  const data = series.map((s, i) => ({ ...s, i }))
  const last = data.length - 1
  return (
    <div className="chart-box" style={{ height: 300 }} data-testid={`telemetry-chart-${p.parameter}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -8 }} barCategoryGap="22%">
          <CartesianGrid stroke="rgba(255,255,255,.06)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtTime} stroke="#6f7683" fontSize={11} minTickGap={40} tickLine={false} axisLine={false} />
          <YAxis stroke="#6f7683" fontSize={11} domain={[0, 'auto']} width={52} tickLine={false} axisLine={false} />
          <Tooltip {...chartTooltipStyle} labelFormatter={fmtTime} formatter={(v) => [`${fmtValue(p.parameter, v)} ${p.unit}`, PARAM_SHORT[p.parameter]]} />
          <ReferenceLine y={p.safe_threshold} stroke="#ff4d4f" strokeDasharray="5 4" ifOverflow="extendDomain"
            label={{ value: `Safe ${p.safe_threshold}`, fill: '#ff4d4f', fontSize: 10, position: 'insideTopRight' }} />
          <ReferenceLine y={p.warning_threshold} stroke="#f5a524" strokeDasharray="2 4" ifOverflow="hidden" />
          <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => {
              const st = statusOf(d.v, p)
              return <Cell key={d.i} fill={st !== 'nominal' ? STATUS_COLOR[st] : d.i === last ? '#f4f5f7' : '#3a4048'} />
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function AnomalyPanel({ p }) {
  const a = p.anomaly
  if (!a) return <EmptyState title="No anomaly data" message="Scores appear after the first readings." testid="anomaly-panel-empty" />
  const level = a.level
  return (
    <div className={a.early_warning ? 'ew-card' : ''} style={a.early_warning ? {} : { padding: 0 }} data-testid={`anomaly-panel-${p.parameter}`}>
      {a.early_warning ? <div className="ew-label" style={{ marginBottom: 8 }}>Early warning active</div> : null}
      <div className="kv">
        <div><div className="k">Current value</div><div className="v">{fmtValue(p.parameter, p.current?.value)} {p.unit}</div></div>
        <div><div className="k">Rolling average</div><div className="v" data-testid="anomaly-rolling-avg">{fmtValue(p.parameter, a.rolling_avg)} {p.unit}</div></div>
        <div><div className="k">Trend direction</div><div className="v row" style={{ gap: 4 }}><TrendIcon trend={a.trend} />{a.trend}</div></div>
        <div><div className="k">Anomaly score</div><div className="v" data-testid="anomaly-score"><Badge value={level === 'normal' ? 'nominal' : level === 'watch' ? 'warning' : level} label={`${fmtNum(a.score, 0)} · ${level}`} /></div></div>
        <div><div className="k">Confidence</div><div className="v" data-testid="anomaly-confidence">{a.confidence}%</div></div>
        <div><div className="k">% of safe limit</div><div className="v">{fmtNum((a.ratio || 0) * 100, 0)}%</div></div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="field-label dim">Reason</div>
        <p className="small" style={{ marginTop: 3 }} data-testid="anomaly-reason">{a.reason}</p>
        {a.reasons?.length > 1 ? (
          <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {a.reasons.slice(1).map((r) => <li key={r}>{r}</li>)}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

function AdminAnomalyTable({ stamp }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    api('/api/anomaly-summary').then((d) => { setData(d); setError(null) }).catch(setError)
  }, [stamp])
  if (error) return <ErrorState error={error} testid="anomaly-summary-error" />
  if (!data) return <Loading rows={3} testid="anomaly-summary-loading" />
  return (
    <div data-testid="anomaly-summary">
      <div className="row" style={{ padding: '12px 16px', gap: 6 }}>
        {Object.entries(data.levels).map(([k, v]) => <Badge key={k} value={k === 'normal' ? 'nominal' : k === 'watch' ? 'warning' : k} label={`${k} ${v}`} testid={`anomaly-level-count-${k}`} />)}
        <span className="spacer" />
        <span className="xs dim">Bands: 0–39 normal · 40–69 watch · 70–89 warning · 90–100 critical</span>
      </div>
      <table className="data responsive">
        <thead><tr><th>Sensor</th><th>Parameter</th><th>Score</th><th>Trend</th><th>Rolling avg</th><th>Conf.</th><th>Reason</th></tr></thead>
        <tbody>
          {data.top.map((s) => (
            <tr key={`${s.node_id}-${s.parameter}`} data-testid={`anomaly-row-${s.node_id.toLowerCase()}-${s.parameter}`}>
              <td data-label="Sensor" className="num">{s.node_id}</td>
              <td data-label="Parameter">{PARAM_SHORT[s.parameter]}</td>
              <td data-label="Score" className="num"><span className={`c-${s.level === 'normal' ? 'nominal' : s.level === 'critical' ? 'critical' : 'warning'}`}>{fmtNum(s.score, 0)}</span> <span className="dim">{s.level}</span></td>
              <td data-label="Trend"><span className="row" style={{ gap: 4 }}><TrendIcon trend={s.trend} />{s.trend}</span></td>
              <td data-label="Rolling avg" className="num">{fmtValue(s.parameter, s.rolling_avg)} {s.unit}</td>
              <td data-label="Conf." className="num">{s.confidence}%</td>
              <td data-label="Reason" className="small">{s.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function LiveTelemetry() {
  const { telemetry: t, error, refresh } = useLive()
  const { isAdmin } = useAuth()
  const [param, setParam] = useState('strain')
  const history = useRollingHistory(t)
  if (!t && error) return <div className="panel"><ErrorState error={{ message: error }} onRetry={refresh} testid="telemetry-error-state" /></div>
  if (!t) return <Loading label="Loading live telemetry…" testid="telemetry-loading-state" />
  const p = t.parameters.find((x) => x.parameter === param)
  const stamp = t.last_reading_at

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Live telemetry</h1>
          <p>Latest update <span className="mono">{fmtTime(t.last_reading_at)}</span> ({fmtAgo(t.last_reading_at)}) · connection <span data-testid="telemetry-connection-state">{t.connection}</span></p>
        </div>
        <div className="page-actions"><SimulatorToggle /></div>
      </div>

      <div className="kpi-grid" role="tablist" aria-label="Sensor">
        {t.parameters.map((x) => <KpiCard key={x.parameter} p={x} selected={param === x.parameter} onSelect={() => setParam(x.parameter)} />)}
      </div>

      <section className="panel" aria-labelledby="chart-title">
        <div className="panel-head">
          <h2 id="chart-title"><BarChart3 size={16} aria-hidden="true" /> {PARAM_SHORT[param]} · last {p.series?.length || 0} readings</h2>
          <span className="dim small">Highest-loaded node <span className="mono">{p.current?.node_id || '—'}</span> · latest bar in white</span>
        </div>
        <div className="grid split" style={{ padding: 16 }} id="telemetry-chart-grid">
          <FocusBarChart p={p} />
          <div>
            <h3 className="row" style={{ marginBottom: 10 }}><Brain size={15} aria-hidden="true" /> Anomaly analysis</h3>
            <AnomalyPanel p={p} />
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="matrix-title">
        <div className="panel-head">
          <h2 id="matrix-title"><Table2 size={16} aria-hidden="true" /> Current readings by node</h2>
          <span className="dim small">Trend column shows {PARAM_SHORT[param].toLowerCase()} since you opened this page</span>
        </div>
        <div className="table-wrap">
          <table className="data responsive" data-testid="telemetry-matrix">
            <thead>
              <tr>
                <th>Node</th>
                {PARAMS.map((k) => <th key={k}>{PARAM_SHORT[k]}</th>)}
                <th>Trend</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {t.nodes.map((n) => {
                const cond = n.online ? n.condition : 'offline'
                return (
                  <tr key={n.node_id} data-testid={`telemetry-row-${n.node_id.toLowerCase()}`}>
                    <td data-label="Node">
                      <span className="node-cell">
                        <span className={`node-avatar ${cond}`} aria-hidden="true">{n.node_id.replace(/^ESP32-/, '').slice(0, 3)}</span>
                        <span style={{ minWidth: 0 }}>
                          <Link to={`/nodes/${n.node_id}`} className="mono" data-testid={`telemetry-node-link-${n.node_id.toLowerCase()}`}>{n.node_id}</Link>
                          <span className="xs dim break" style={{ display: 'block' }}>{n.location}</span>
                        </span>
                      </span>
                    </td>
                    {PARAMS.map((k) => {
                      const r = n.latest?.[k]
                      return (
                        <td key={k} data-label={PARAM_SHORT[k]} className="num">
                          <span className={`value-chip ${n.online ? r?.status || '' : 'muted'}`}>{r ? fmtValue(k, r.value) : '—'}<span className="dim xs"> {r?.unit}</span></span>
                        </td>
                      )
                    })}
                    <td data-label="Trend">
                      <MiniLine data={history[`${n.node_id}:${param}`]} color={STATUS_COLOR[n.online ? n.latest?.[param]?.status || 'nominal' : 'muted']}
                        testid={`telemetry-trend-${n.node_id.toLowerCase()}`} />
                    </td>
                    <td data-label="Last seen" className="num">
                      <Badge value={n.online ? 'online' : 'offline'} /> <span className="xs dim">{fmtAgo(n.last_seen)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin ? (
        <section className="panel" aria-labelledby="anomaly-title">
          <div className="panel-head">
            <h2 id="anomaly-title"><Brain size={16} aria-hidden="true" /> Anomaly scores — top sensors</h2>
          </div>
          <AdminAnomalyTable stamp={stamp} />
        </section>
      ) : null}
    </>
  )
}

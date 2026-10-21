// The user (viewer) dashboard: a dark sidebar with navigation and the signed-in account,
// and a light main area with KPI cards, a bar chart, a summary card, the node table and the
// building map. It shows the same live readings as before, laid out as a dashboard.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Building2, CheckCircle2, Gauge, Info, LayoutDashboard, Map as MapIcon, Search, Table2 } from 'lucide-react'
import { BrandMark } from '../components/Layout'
import { PARAM_ICON } from '../components/monitoring'
import ProfileMenu, { Avatar } from '../components/ProfileMenu'
import ConnectDevice from '../components/ConnectDevice'
import { IsoBuilding, floorName, placeNodes } from '../components/twin'
import { Banner, EmptyState, Loading } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/context'
import { PARAMS, PARAM_SHORT, SENSOR, UNITS, fmtAgo, fmtNum, fmtTime, fmtValue } from '../lib/format'
import { MiniLine, useRollingHistory } from './LiveTelemetry'

const POLL_MS = 5000
const STATUS_COLOR = { nominal: '#16a35a', warning: '#d48806', critical: '#e5484d', muted: '#9aa1ab' }
const STATUS_TEXT = { nominal: 'Normal', warning: 'Near limit', critical: 'Over limit', muted: 'No data' }

// Shortcuts in a user's profile card.
const USER_LINKS = [
  { to: '/user', label: 'Live readings', icon: Gauge },
  { to: '/about', label: 'About the project', icon: Info },
]

const statusOf = (v, p) => (v >= p.safe_threshold ? 'critical' : v >= p.warning_threshold ? 'warning' : 'nominal')

function KpiBars({ series, p, dark }) {
  const vs = (series || []).slice(-8).map((s) => s.v)
  if (!vs.length) return null
  const hi = Math.max(...vs, p.safe_threshold * 0.6)
  return (
    <svg className="ud-kpi-bars" viewBox="0 0 64 40" aria-hidden="true">
      {vs.map((v, i) => {
        const h = Math.max(4, (v / hi) * 38)
        const st = statusOf(v, p)
        const fill = st !== 'nominal' ? STATUS_COLOR[st] : i === vs.length - 1 ? '#ff7a1a' : (dark ? 'rgba(255,255,255,.28)' : '#d6dae0')
        return <rect key={i} x={i * 8} y={40 - h} width="5" height={h} rx="1.5" fill={fill} />
      })}
    </svg>
  )
}

function KpiCard({ p, dark }) {
  const cur = p.current
  const a = p.anomaly
  const Icon = PARAM_ICON[p.parameter]
  const delta = cur && a?.rolling_avg ? ((cur.value - a.rolling_avg) / a.rolling_avg) * 100 : null
  const status = cur ? (cur.online ? cur.status : 'muted') : 'muted'
  return (
    <article className={`ud-kpi ${dark ? 'dark' : ''} ${status}`} data-testid={`ud-kpi-${p.parameter}`}>
      <div className="ud-kpi-label"><Icon size={14} aria-hidden="true" /> Highest {PARAM_SHORT[p.parameter].toLowerCase()} <span>{p.sensor || SENSOR[p.parameter]}</span></div>
      <div className="ud-kpi-row">
        <div className="ud-kpi-value">{cur ? fmtValue(p.parameter, cur.value) : '—'}<span>{p.unit}</span></div>
        <KpiBars series={p.series} p={p} dark={dark} />
      </div>
      <div className="ud-kpi-foot">
        {delta != null ? (
          <span className={delta >= 0 ? 'up' : 'down'}>
            {delta >= 0 ? <ArrowUpRight size={12} aria-hidden="true" /> : <ArrowDownRight size={12} aria-hidden="true" />}{fmtNum(Math.abs(delta), 1)}%
          </span>
        ) : null}
        <span> than rolling average · {cur?.node_id || 'no node'}</span>
      </div>
    </article>
  )
}

function TrendChart({ p }) {
  const data = (p.series || []).map((s, i) => ({ ...s, i }))
  if (!data.length) return <EmptyState title="No readings yet" message="Waiting for the first readings." testid="ud-chart-empty" />
  const last = data.length - 1
  const label = ({ x, y, width, index, value }) => {
    if (index !== last) return null
    const text = `${fmtValue(p.parameter, value)} ${p.unit}`
    const w = text.length * 6.6 + 16
    return (
      <g>
        <rect x={x + width / 2 - w / 2} y={y - 30} width={w} height={22} rx={6} fill="#111315" />
        <text x={x + width / 2} y={y - 15} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={700} fontFamily="Inter, sans-serif">{text}</text>
      </g>
    )
  }
  return (
    <div className="ud-chart" data-testid={`ud-chart-${p.parameter}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 34, right: 8, bottom: 0, left: -12 }} barCategoryGap="28%">
          <CartesianGrid stroke="rgba(0,0,0,.06)" vertical={false} />
          <XAxis dataKey="t" tickFormatter={fmtTime} stroke="#8a9099" fontSize={11} minTickGap={50} tickLine={false} axisLine={false} />
          <YAxis stroke="#8a9099" fontSize={11} width={48} tickLine={false} axisLine={false} domain={[0, 'auto']} />
          <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} contentStyle={{ borderRadius: 10, border: '1px solid #e3e6ea', fontSize: 12 }}
            labelFormatter={fmtTime} formatter={(v) => [`${fmtValue(p.parameter, v)} ${p.unit}`, PARAM_SHORT[p.parameter]]} />
          <ReferenceLine y={p.safe_threshold} stroke="#e5484d" strokeDasharray="5 4" ifOverflow="extendDomain"
            label={{ value: `Safe limit ${p.safe_threshold}`, fill: '#e5484d', fontSize: 10, position: 'insideTopRight' }} />
          <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false} label={label}>
            {data.map((d) => {
              const st = statusOf(d.v, p)
              return <Cell key={d.i} fill={st !== 'nominal' ? STATUS_COLOR[st] : d.i === last ? '#111315' : '#cfd4da'} />
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function UserReadings() {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [param, setParam] = useState('strain')
  const [query, setQuery] = useState('')
  const [show, setShow] = useState('all')
  const [selected, setSelected] = useState(null)
  const [floor, setFloor] = useState(null)
  const [, setTick] = useState(0)
  const history = useRollingHistory(data)

  const load = useCallback(async () => {
    try {
      setData(await api('/api/telemetry', { query: { points: 36 } }))
      setError(null)
    } catch (e) {
      if (e.status !== 401) setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, POLL_MS)
    const clock = setInterval(() => setTick((t) => t + 1), 1000) // keeps "x s ago" current
    return () => { clearInterval(poll); clearInterval(clock) }
  }, [load])

  const nodes = useMemo(() => [...(data?.nodes || [])].sort((a, b) => (b.online - a.online) || a.node_id.localeCompare(b.node_id)), [data])
  const byId = useMemo(() => [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id)), [nodes])
  const view = useMemo(() => placeNodes(byId), [byId])

  const counts = { nominal: 0, warning: 0, critical: 0 }
  nodes.filter((n) => n.online).forEach((n) => PARAMS.forEach((p) => {
    const s = n.latest?.[p]?.status
    if (s in counts) counts[s] += 1
  }))
  const totalReadings = counts.nominal + counts.warning + counts.critical
  const normalPct = totalReadings ? Math.round((counts.nominal / totalReadings) * 100) : 0

  const q = query.trim().toLowerCase()
  const shown = nodes.filter((n) => {
    if (q && !`${n.node_id} ${n.location}`.toLowerCase().includes(q)) return false
    if (show === 'attention') return n.online && (n.condition === 'warning' || n.condition === 'critical')
    if (show === 'offline') return !n.online
    return true
  })
  const p = data?.parameters.find((x) => x.parameter === param)
  const loadOf = (n) => Math.max(0, ...(data?.parameters || []).map((x) => (n.latest?.[x.parameter]?.value || 0) / x.safe_threshold))
  const focus = byId.find((n) => n.node_id === selected) || [...byId].filter((n) => n.online).sort((a, b) => loadOf(b) - loadOf(a))[0]

  return (
    <div className="ud" data-testid="user-page">
      <aside className="ud-side" aria-label="Sidebar">
        <div className="ud-brand"><BrandMark /><span className="brand-name">Smart <span>SHM</span></span></div>
        <div className="ud-workspace">
          <span className="ud-ws-icon"><Building2 size={16} aria-hidden="true" /></span>
          <span style={{ minWidth: 0 }}>
            <span className="ud-ws-k">Monitored structure</span>
            <span className="ud-ws-v">{data?.structure_name || 'Loading…'}</span>
          </span>
        </div>
        <label className="ud-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Search nodes</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search nodes…" data-testid="ud-search" />
        </label>
        <div className="ud-nav-label">Navigation</div>
        <nav className="ud-nav" aria-label="Dashboard sections">
          <a href="#ud-top" className="active"><LayoutDashboard size={16} aria-hidden="true" /> Dashboard</a>
          <a href="#ud-trend"><Gauge size={16} aria-hidden="true" /> Trends</a>
          <a href="#ud-nodes"><Table2 size={16} aria-hidden="true" /> Sensor nodes <span className="ud-count">{data?.total_nodes ?? 0}</span></a>
          <a href="#ud-map"><MapIcon size={16} aria-hidden="true" /> Building map</a>
          <Link to="/about"><Info size={16} aria-hidden="true" /> About the project</Link>
        </nav>
        <span className="spacer" />
        <div className="ud-nav-label">User account</div>
        <div className="ud-account" data-testid="ud-account">
          <Avatar user={user} size={40} />
          <span style={{ minWidth: 0 }}>
            <span className="ud-acc-name">{user?.name || user?.email}</span>
            <span className="ud-acc-mail">{user?.email}</span>
          </span>
        </div>
      </aside>

      <main className="ud-main" id="ud-top">
        <header className="ud-head">
          <div>
            <h1 data-testid="page-title">Dashboard</h1>
            <p data-testid="user-last-update">
              {data
                ? <>Updated <span className="mono">{fmtTime(data.last_reading_at)}</span> ({fmtAgo(data.last_reading_at)}) · {data.active_nodes} of {data.total_nodes} nodes online · refreshes every 5 s</>
                : 'Loading…'}
            </p>
          </div>
          <div className="ud-head-actions">
            <Link to="/about" className="ud-pill" data-testid="user-about-link">About</Link>
            <ProfileMenu links={USER_LINKS} nameTestid="user-current-user" logoutTestid="user-logout-button" />
          </div>
        </header>

        {error ? <Banner kind="offline" testid="user-connection-error"><strong>Connection problem:</strong> {error} Retrying…</Banner> : null}

        {!data ? <Loading label="Loading readings…" testid="user-loading-state" /> : data.total_nodes === 0 ? (
          <div className="ud-empty-start" data-testid="user-no-nodes">
            <ConnectDevice user={user} open />
          </div>
        ) : (
          <>
            <section className="ud-kpis" aria-label="Highest readings">
              {data.parameters.map((x, i) => <KpiCard key={x.parameter} p={x} dark={i === 0} />)}
            </section>

            <section className="ud-grid">
              <article className="ud-card ud-span" id="ud-trend" aria-labelledby="ud-trend-title">
                <div className="ud-card-head">
                  <h2 id="ud-trend-title">{PARAM_SHORT[param]} trend</h2>
                  <div className="ud-seg" role="tablist" aria-label="Sensor">
                    {PARAMS.map((k) => (
                      <button key={k} type="button" role="tab" aria-selected={param === k} onClick={() => setParam(k)} data-testid={`ud-chart-tab-${k}`}>{PARAM_SHORT[k]}</button>
                    ))}
                  </div>
                </div>
                <p className="ud-sub">Last {p?.series?.length || 0} readings from the most loaded node, <span className="mono">{p?.current?.node_id || '—'}</span></p>
                {p ? <TrendChart p={p} /> : null}
              </article>

              <article className="ud-card ud-big" data-testid="user-summary" aria-label="Summary">
                <div className="ud-big-value">{data.active_nodes}<span>/{data.total_nodes} nodes</span></div>
                <div className="ud-big-sub"><ArrowUpRight size={14} aria-hidden="true" /> <strong>{normalPct}%</strong> of readings normal</div>
                <div className="ud-big-row">
                  <span className="ud-big-icon ok"><CheckCircle2 size={18} aria-hidden="true" /></span>
                  <span><strong>Normal</strong><span>{counts.nominal} readings</span></span>
                </div>
                <div className="ud-big-row">
                  <span className="ud-big-icon warn"><Gauge size={18} aria-hidden="true" /></span>
                  <span><strong>Near limit</strong><span>{counts.warning} readings</span></span>
                </div>
                <div className="ud-big-row">
                  <span className="ud-big-icon crit"><AlertTriangle size={18} aria-hidden="true" /></span>
                  <span><strong>Over limit</strong><span>{counts.critical} readings</span></span>
                </div>
              </article>

              <article className="ud-card ud-span" id="ud-nodes" aria-labelledby="ud-nodes-title">
                <div className="ud-card-head">
                  <h2 id="ud-nodes-title">Readings by node</h2>
                  <select value={show} onChange={(e) => setShow(e.target.value)} className="ud-select" aria-label="Show" data-testid="ud-filter">
                    <option value="all">All nodes</option>
                    <option value="attention">Needs attention</option>
                    <option value="offline">Offline</option>
                  </select>
                </div>
                {shown.length === 0 ? <EmptyState title="No matching nodes" message="Change the search or the filter." testid="user-empty-state" /> : (
                  <table className="data responsive ud-table">
                    <thead>
                      <tr><th>Node</th>{PARAMS.map((k) => <th key={k}>{PARAM_SHORT[k]}</th>)}<th>{PARAM_SHORT[param]} trend</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {shown.map((n) => {
                        const cond = n.online ? n.condition : 'offline'
                        return (
                          <tr key={n.node_id} data-testid={`user-node-card-${n.node_id}`} onClick={() => setSelected(n.node_id)}>
                            <td data-label="Node">
                              <span className="node-cell">
                                <span className={`node-avatar ${cond}`} aria-hidden="true">{n.node_id.replace(/^ESP32-/, '').slice(0, 3)}</span>
                                <span style={{ minWidth: 0 }}>
                                  <strong className="mono">{n.node_id}</strong>
                                  <span className="xs ud-dim break" style={{ display: 'block' }}>{n.location}</span>
                                </span>
                              </span>
                            </td>
                            {PARAMS.map((k) => {
                              const r = n.latest?.[k]
                              const st = n.online && r ? r.status : 'muted'
                              return (
                                <td key={k} data-label={PARAM_SHORT[k]} className="num" data-testid={`user-reading-${n.node_id}-${k}`} data-status={st}
                                  title={STATUS_TEXT[st]}>
                                  <span className={`ud-val ${st}`}>{r ? fmtValue(k, r.value) : '—'}</span> <span className="xs ud-dim">{UNITS[k]}</span>
                                </td>
                              )
                            })}
                            <td data-label="Trend">
                              <MiniLine data={history[`${n.node_id}:${param}`]} color={STATUS_COLOR[n.online ? n.latest?.[param]?.status || 'nominal' : 'muted']}
                                testid={`user-trend-${n.node_id}`} />
                            </td>
                            <td data-label="Status">
                              <span className={`ud-chip ${n.online ? 'online' : 'offline'}`} data-testid={`user-node-status-${n.node_id}`}>{n.online ? 'Online' : 'Offline'}</span>
                              <span className="xs ud-dim" style={{ display: 'block', marginTop: 3 }}>{fmtAgo(n.last_seen)}</span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </article>

              <article className="ud-card ud-map" id="ud-map" aria-labelledby="ud-map-title" data-testid="ud-map">
                <div className="ud-card-head">
                  <h2 id="ud-map-title">Building map</h2>
                  <select value={floor ?? ''} onChange={(e) => setFloor(e.target.value === '' ? null : e.target.value === 'roof' ? 'roof' : Number(e.target.value))}
                    className="ud-select dark" aria-label="Floor" data-testid="ud-floor-select">
                    <option value="">All floors</option>
                    {view.layout.floors.map((f) => <option key={f} value={f}>{floorName(f)}</option>)}
                  </select>
                </div>
                {focus ? (
                  <div className="ud-map-bubble" data-testid="ud-map-bubble">
                    <strong className="mono">{focus.node_id}</strong>
                    <span>{fmtNum(loadOf(focus) * 100, 0)}% of limit <ArrowUpRight size={12} aria-hidden="true" /></span>
                    <span className="ud-map-loc">{focus.location}</span>
                  </div>
                ) : null}
                <div className="ud-map-art">
                  <IsoBuilding nodes={byId} params={data.parameters} view={view} selectedId={focus?.node_id} floor={floor} onSelect={setSelected} />
                </div>
              </article>
            </section>

            <ConnectDevice user={user} open={false} />
          </>
        )}
      </main>
    </div>
  )
}

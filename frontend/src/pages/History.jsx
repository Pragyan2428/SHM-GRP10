import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownUp, Download, FileSpreadsheet, Lock, Search, X } from 'lucide-react'
import { AckButton } from '../components/monitoring'
import { Badge, EmptyState, ErrorState, Loading, Pagination, SeverityBadge } from '../components/ui'
import { downloadCsv } from '../lib/api'
import { useAuth, useFetch, useLive, useToast } from '../lib/context'
import { PARAMS, PARAM_SHORT, fmtDateTime, fmtNum, fmtValue } from '../lib/format'

const EMPTY = { q: '', parameter: '', node_id: '', severity: '', status: '', notification_status: '', type: '', date_from: '', date_to: '', sort: 'newest' }

function toIso(local, end = false) {
  if (!local) return undefined
  const d = new Date(`${local}T${end ? '23:59:59' : '00:00:00'}`)
  return d.toISOString()
}

export default function History() {
  const { isAdmin } = useAuth()
  const { telemetry } = useLive()
  const { push } = useToast()
  const [tab, setTab] = useState('alerts')
  const [filters, setFilters] = useState(EMPTY)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  useEffect(() => { const id = setTimeout(() => setFilters((f) => ({ ...f, q })), 350); return () => clearTimeout(id) }, [q])
  useEffect(() => { setPage(1) }, [filters, tab])

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }))
  const common = {
    q: filters.q, parameter: filters.parameter, node_id: filters.node_id, sort: filters.sort, page, page_size: 20,
    date_from: toIso(filters.date_from), date_to: toIso(filters.date_to, true),
  }
  const query = tab === 'alerts'
    ? { ...common, severity: filters.severity, status: filters.status, notification_status: filters.notification_status, type: filters.type }
    : { ...common, status: filters.severity }
  const path = tab === 'alerts' ? '/api/events' : '/api/telemetry/history'
  const { data, error, loading, reload } = useFetch(path, query, [telemetry?.last_reading_at && page === 1 ? telemetry.last_reading_at : null])

  const nodes = telemetry?.nodes?.map((n) => n.node_id) || []
  const active = Object.entries(filters).some(([k, v]) => k !== 'sort' && v)

  const exportCsv = async () => {
    setExporting(true)
    try {
      const body = { dataset: tab === 'alerts' ? 'alerts' : 'telemetry', sort: filters.sort }
      ;['parameter', 'node_id', 'q'].forEach((k) => { if (filters[k]) body[k] = filters[k] })
      if (tab === 'alerts') { if (filters.severity) body.severity = filters.severity; if (filters.status) body.status = filters.status }
      else if (filters.severity) body.status = filters.severity
      if (filters.date_from) body.date_from = toIso(filters.date_from)
      if (filters.date_to) body.date_to = toIso(filters.date_to, true)
      const r = await downloadCsv(body)
      push({ kind: 'success', title: 'CSV exported', body: `${r.rows} rows · ${r.name}`, testid: 'csv-export-success-toast' })
    } catch (e) {
      push({ kind: 'error', title: 'Export failed', body: e.message, testid: 'csv-export-error-toast' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Historical alerts</h1>
          <p>Threshold violations, early warnings and every stored telemetry reading</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={exportCsv} disabled={!isAdmin || exporting}
            title={isAdmin ? 'Download the filtered records as CSV' : 'Administrator only'} data-testid="csv-export-button">
            {isAdmin ? <Download size={15} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          {isAdmin ? (
            <Link className="btn" to="/google-sheets" data-testid="history-google-sheets-link"><FileSpreadsheet size={15} aria-hidden="true" /> Google Sheets</Link>
          ) : null}
        </div>
      </div>

      <section className="panel">
        <div className="tabs" role="tablist" aria-label="Dataset">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'alerts'} onClick={() => setTab('alerts')} data-testid="history-tab-alerts">Alert events</button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'telemetry'} onClick={() => setTab('telemetry')} data-testid="history-tab-telemetry">All telemetry</button>
        </div>
        <div className="filters" role="search" aria-label="Filter records">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field-label">Search</span>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-3)' }} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Location, node, alert ID…" style={{ paddingLeft: 30 }}
                data-testid="history-search-input" />
            </div>
          </label>
          <label className="field"><span className="field-label">Parameter</span>
            <select value={filters.parameter} onChange={set('parameter')} data-testid="history-parameter-filter">
              <option value="">All parameters</option>
              {PARAMS.map((p) => <option key={p} value={p}>{PARAM_SHORT[p]}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">Node</span>
            <select value={filters.node_id} onChange={set('node_id')} data-testid="history-node-filter">
              <option value="">All nodes</option>
              {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">{tab === 'alerts' ? 'Severity' : 'Status'}</span>
            <select value={filters.severity} onChange={set('severity')} data-testid="history-severity-filter">
              <option value="">All</option>
              {tab === 'alerts' ? (
                <><option value="critical">Critical</option><option value="major">Major</option><option value="early_warning">Early warning</option></>
              ) : (
                <><option value="critical">Critical</option><option value="warning">Warning</option><option value="nominal">Nominal</option><option value="critical,warning">Violations only</option></>
              )}
            </select>
          </label>
          {tab === 'alerts' ? (
            <>
              <label className="field"><span className="field-label">Acknowledgement</span>
                <select value={filters.status} onChange={set('status')} data-testid="history-ack-filter">
                  <option value="">All</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option>
                </select>
              </label>
              <label className="field"><span className="field-label">Notification</span>
                <select value={filters.notification_status} onChange={set('notification_status')} data-testid="history-notification-filter">
                  <option value="">All</option><option value="sent">Sent</option><option value="failed">Failed</option>
                  <option value="pending">Pending</option><option value="disabled">Disabled</option>
                </select>
              </label>
              <label className="field"><span className="field-label">Type</span>
                <select value={filters.type} onChange={set('type')} data-testid="history-type-filter">
                  <option value="">All</option><option value="threshold">Threshold violation</option><option value="early_warning">Early warning</option>
                </select>
              </label>
            </>
          ) : null}
          <label className="field"><span className="field-label">From</span>
            <input type="date" value={filters.date_from} onChange={set('date_from')} data-testid="history-date-from-input" />
          </label>
          <label className="field"><span className="field-label">To</span>
            <input type="date" value={filters.date_to} onChange={set('date_to')} data-testid="history-date-to-input" />
          </label>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <div className="row">
              <button type="button" className="btn" onClick={() => setFilters((f) => ({ ...f, sort: f.sort === 'newest' ? 'oldest' : 'newest' }))}
                data-testid="history-sort-button" aria-label={`Sort: ${filters.sort} first`}>
                <ArrowDownUp size={14} aria-hidden="true" /> {filters.sort === 'newest' ? 'Newest' : 'Oldest'}
              </button>
              {active ? (
                <button type="button" className="btn btn-ghost" onClick={() => { setFilters(EMPTY); setQ('') }} data-testid="history-clear-filters-button">
                  <X size={14} aria-hidden="true" /> Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {error ? <ErrorState error={error} onRetry={reload} testid="history-error-state" />
          : !data ? <Loading rows={6} testid="history-loading-state" />
            : data.items.length === 0 ? (
              <EmptyState title={active ? 'No matching records' : 'No records yet'} testid="history-empty-state"
                message={active ? 'Try widening the filters or clearing the search.' : 'Records appear here as soon as sensors report.'} />
            ) : tab === 'alerts' ? (
              <div className="table-wrap" aria-busy={loading}>
                <table className="data responsive" data-testid="history-alerts-table">
                  <thead><tr>
                    <th>Time</th><th>Alert</th><th>Severity</th><th>Value / limit</th><th>Node · location</th><th>Score</th><th>Notification</th><th>Acknowledgement</th>
                  </tr></thead>
                  <tbody>
                    {data.items.map((a) => (
                      <tr key={a.id} data-testid={`history-alert-row-${a.id}`}>
                        <td data-label="Time" className="num">{fmtDateTime(a.created_at)}</td>
                        <td data-label="Alert"><span className="mono">{a.id}</span><div className="small">{a.label}</div>
                          {a.type === 'early_warning' ? <div className="xs c-info">{a.reason}</div> : null}</td>
                        <td data-label="Severity"><SeverityBadge severity={a.severity} /></td>
                        <td data-label="Value / limit" className="num">{fmtValue(a.parameter, a.value)} / {a.threshold} {a.unit}
                          {a.peak_value > a.value ? <div className="xs dim">peak {fmtValue(a.parameter, a.peak_value)}</div> : null}</td>
                        <td data-label="Node · location"><span className="mono">{a.node_id}</span><div className="xs muted break">{a.location}</div></td>
                        <td data-label="Score" className="num">{fmtNum(a.anomaly_score, 0)}</td>
                        <td data-label="Notification">
                          <Badge value={a.notification_status} testid={`history-notification-status-${a.id}`} />
                          {a.notification_status === 'failed' ? (
                            <div className="xs c-critical break" style={{ marginTop: 3 }}>
                              {['email', 'sms', 'whatsapp'].filter((c) => a.notifications?.[c]?.status === 'failed').map((c) => `${c}: ${a.notifications[c].error}`).join(' · ')}
                            </div>
                          ) : null}
                        </td>
                        <td data-label="Acknowledgement">
                          <AckButton alert={a} onDone={reload} />
                          {a.acknowledged_by ? <div className="xs dim" style={{ marginTop: 3 }}>{a.acknowledged_by}<br />{fmtDateTime(a.acknowledged_at)}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="table-wrap" aria-busy={loading}>
                <table className="data responsive" data-testid="history-telemetry-table">
                  <thead><tr>
                    <th>Timestamp</th><th>Parameter</th><th>Value</th><th>Threshold</th><th>Node · location</th><th>Status</th><th>Score</th><th>Source</th>
                  </tr></thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr key={r.id} data-testid={`history-reading-row-${r.id}`}>
                        <td data-label="Timestamp" className="num">{fmtDateTime(r.timestamp)}</td>
                        <td data-label="Parameter">{r.label}</td>
                        <td data-label="Value" className={`num c-${r.status}`}>{fmtValue(r.parameter, r.value)} {r.unit}</td>
                        <td data-label="Threshold" className="num">{r.safe_threshold} {r.unit}</td>
                        <td data-label="Node · location"><span className="mono">{r.node_id}</span><div className="xs muted break">{r.location}</div></td>
                        <td data-label="Status"><Badge value={r.status} /></td>
                        <td data-label="Score" className="num">{fmtNum(r.anomaly_score, 0)}</td>
                        <td data-label="Source"><Badge value={r.source} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        {data && data.total > 0 ? <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} testid="history-pagination" /> : null}
      </section>
    </>
  )
}

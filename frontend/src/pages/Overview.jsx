import { Link } from 'react-router-dom'
import { AlertOctagon, Bell, TrendingUp } from 'lucide-react'
import { AlertStream } from '../components/monitoring'
import SimulatorToggle from '../components/SimulatorToggle'
import { DigitalTwin, MetricCard, SensorHealth } from '../components/twin'
import { ErrorState, Loading } from '../components/ui'
import { useLive } from '../lib/context'
import { fmtNum, fmtTime, fmtValue } from '../lib/format'

export default function Overview() {
  const { telemetry: t, recent, error, refresh } = useLive()
  if (!t && error) return <div className="panel"><ErrorState error={{ message: error }} onRetry={refresh} testid="overview-error-state" /></div>
  if (!t) return <Loading label="Connecting to sensor network…" testid="overview-loading-state" />

  const activeBreaches = recent.filter((a) => a.type === 'threshold' && a.status === 'open')
  const earlyWarnings = recent.filter((a) => a.type === 'early_warning' && a.active && a.status === 'open')
  const top = activeBreaches[0]

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Overview</h1>
          <p>Real-time structural condition · updates every 5 seconds</p>
        </div>
        <div className="page-actions"><SimulatorToggle compact /></div>
      </div>

      {top ? (
        <div className="crit-banner" role="alert" data-testid="critical-alert-banner">
          <AlertOctagon size={22} className="c-critical" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{activeBreaches.length} open threshold alert{activeBreaches.length > 1 ? 's' : ''}</strong>
            <div className="small break">
              Latest: {top.label} <span className="mono">{fmtValue(top.parameter, top.value)} {top.unit}</span> (limit {top.threshold} {top.unit}) at <span className="mono">{top.node_id}</span> — {top.location} · {fmtTime(top.created_at)}
            </div>
          </div>
          <Link to="/history" className="btn btn-sm btn-danger" data-testid="critical-alert-banner-view-link">Review alerts</Link>
        </div>
      ) : null}

      <DigitalTwin t={t} plan />

      <section className="metric-grid" aria-label="Sensor parameters" data-testid="metric-cards">
        {t.parameters.map((p, i) => <MetricCard key={p.parameter} p={p} light={i === 1} />)}
      </section>

      {earlyWarnings.length ? (
        <section className="grid grid-2" aria-label="Early warnings" data-testid="early-warning-section">
          {earlyWarnings.slice(0, 2).map((a) => (
            <div className="ew-card" key={a.id} data-testid={`early-warning-card-${a.id}`}>
              <div className="ew-label"><TrendingUp size={14} aria-hidden="true" /> Early warning · predictive · not a limit breach</div>
              <div className="row" style={{ marginTop: 6, justifyContent: 'space-between' }}>
                <strong>{a.label} · <span className="mono">{a.node_id}</span></strong>
                <span className="mono small">score {fmtNum(a.anomaly_score, 0)} · {a.confidence}% conf.</span>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>{a.location}</div>
              <div className="small" style={{ marginTop: 6 }}>{a.reason}</div>
              <div className="mono xs dim" style={{ marginTop: 6 }}>
                value {fmtValue(a.parameter, a.value)} {a.unit} · rolling avg {fmtValue(a.parameter, a.rolling_avg)} · trend {a.trend} · limit {a.threshold} {a.unit}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="overview-grid">
        <SensorHealth t={t} />
        <section className="panel" aria-labelledby="stream-title" data-testid="alert-stream">
          <div className="panel-head">
            <h2 id="stream-title"><Bell size={16} aria-hidden="true" /> Alert stream</h2>
            <Link to="/history" className="small" data-testid="alert-stream-view-all-link">History →</Link>
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <AlertStream alerts={recent.slice(0, 12)} />
          </div>
        </section>
      </div>
    </>
  )
}

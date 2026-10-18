import { useState } from 'react'
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from 'recharts'
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, Check, MapPin, Thermometer, Activity, Waves,
} from 'lucide-react'
import { api } from '../lib/api'
import { useAuth, useLive, useToast } from '../lib/context'
import { fmtNum, fmtTime, fmtValue } from '../lib/format'
import { Badge, EmptyState, SeverityBadge } from './ui'

export const PARAM_ICON = { strain: Waves, vibration: Activity, temperature: Thermometer }
const STATUS_COLOR = { nominal: '#2fd17a', warning: '#f5a524', critical: '#ff4d4f', offline: '#6f7782' }

export function TrendIcon({ trend, size = 14 }) {
  if (trend === 'rising') return <ArrowUpRight size={size} className="c-warning" aria-label="Rising" />
  if (trend === 'falling') return <ArrowDownRight size={size} className="c-info" aria-label="Falling" />
  return <ArrowRight size={size} className="c-muted" aria-label="Stable" />
}

export function Sparkline({ data, threshold, status, height = 46, testid }) {
  if (!data?.length) return <div className="spark" data-testid={testid} />
  const color = STATUS_COLOR[status] || STATUS_COLOR.nominal
  return (
    <div className="spark" style={{ height }} data-testid={testid} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={['auto', 'auto']} />
          <ReferenceLine y={threshold} stroke="#ff4d4f" strokeDasharray="3 3" ifOverflow="hidden" />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ---------------------------------------------------------- alert stream */
export function AckButton({ alert, onDone, size = 'btn-sm' }) {
  const { isAdmin } = useAuth()
  const { push } = useToast()
  const { refresh } = useLive()
  const [busy, setBusy] = useState(false)
  if (alert.status === 'acknowledged') {
    return <Badge value="acknowledged" label="Acknowledged" testid={`alert-acknowledged-${alert.id}`} />
  }
  if (!isAdmin) return <Badge value="open" label="Open" testid={`alert-open-${alert.id}`} />
  const ack = async () => {
    setBusy(true)
    try {
      await api(`/api/events/${alert.id}/acknowledge`, { method: 'POST', body: {} })
      push({ kind: 'success', title: 'Alert acknowledged', body: `${alert.id} · ${alert.label} at ${alert.node_id}`, testid: 'ack-success-toast' })
      refresh()
      onDone?.()
    } catch (e) {
      push({ kind: 'error', title: 'Could not acknowledge', body: e.message, testid: 'ack-error-toast' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={`btn ${size}`} onClick={ack} disabled={busy}
      data-testid={`alert-acknowledge-button-${alert.id}`} aria-label={`Acknowledge alert ${alert.id}`}>
      {busy ? <span className="spinner" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Acknowledge
    </button>
  )
}

export function AlertStream({ alerts, loading }) {
  if (!loading && !alerts.length) {
    return <EmptyState title="No alerts" message="All sensors are within their configured safe thresholds." testid="alert-stream-empty" />
  }
  return (
    <ul className="alert-list" data-testid="alert-stream-list">
      {alerts.map((a) => (
        <li key={a.id} className={`alert-item ${a.severity} ${a.status}`} data-testid={`alert-stream-item-${a.id}`}>
          <span className="bar" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div className="alert-title">
              <SeverityBadge severity={a.severity} testid={`alert-severity-${a.id}`} />
              <span>{a.label}</span>
              {a.active && a.type === 'threshold' ? <span className="badge b-critical">Active</span> : null}
            </div>
            <div className="alert-sub">
              <span className="mono" style={{ color: 'var(--text)' }}>{fmtValue(a.parameter, a.value)} {a.unit}</span>
              {a.type === 'threshold' ? <> / limit <span className="mono">{a.threshold} {a.unit}</span></> : <> · score <span className="mono">{fmtNum(a.anomaly_score, 0)}</span></>}
            </div>
            <div className="alert-sub row" style={{ gap: 4 }}>
              <MapPin size={11} aria-hidden="true" /> <span className="mono">{a.node_id}</span> · <span data-testid={`alert-location-${a.id}`}>{a.location}</span>
            </div>
            {a.type === 'early_warning' ? <div className="alert-reason">{a.reason}</div> : null}
          </div>
          <div className="alert-side">
            <span className="mono xs dim" title={a.created_at}>{fmtTime(a.created_at)}</span>
            <Badge value={a.notification_status} label={`Notify: ${a.notification_status}`} testid={`alert-notification-status-${a.id}`} />
            <AckButton alert={a} />
          </div>
        </li>
      ))}
    </ul>
  )
}

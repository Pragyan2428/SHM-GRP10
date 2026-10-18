import { useEffect, useRef } from 'react'
import {
  AlertOctagon, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Inbox, Info, Lock, RefreshCw, TrendingUp, WifiOff, X,
} from 'lucide-react'
import { useToast } from '../lib/context'

const LABELS = {
  early_warning: 'Early warning', no_data: 'No data', acknowledged: 'Acknowledged',
}

export function Badge({ value, label, testid, icon: Icon }) {
  const v = String(value || 'unknown')
  return (
    <span className={`badge b-${v}`} data-testid={testid}>
      {Icon ? <Icon size={11} aria-hidden="true" /> : null}
      {label || LABELS[v] || v.replace(/_/g, ' ')}
    </span>
  )
}

export function SeverityBadge({ severity, testid }) {
  const icon = severity === 'early_warning' ? TrendingUp : severity === 'critical' ? AlertOctagon : AlertTriangle
  return <Badge value={severity} icon={icon} testid={testid} />
}

export function Loading({ label = 'Loading…', testid = 'loading-state', rows = 0 }) {
  if (rows) {
    return (
      <div className="stack" style={{ padding: 14 }} data-testid={testid} aria-busy="true" aria-label={label}>
        {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height: 38 }} />)}
      </div>
    )
  }
  return (
    <div className="state" role="status" data-testid={testid}>
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export function EmptyState({ title = 'Nothing here yet', message, testid = 'empty-state', icon: Icon = Inbox, children }) {
  return (
    <div className="state" data-testid={testid}>
      <Icon size={28} aria-hidden="true" />
      <h3>{title}</h3>
      {message ? <p className="small">{message}</p> : null}
      {children}
    </div>
  )
}

export function ErrorState({ error, onRetry, testid = 'error-state', title = 'Something went wrong' }) {
  const offline = error?.status === 0
  return (
    <div className="state error" role="alert" data-testid={testid}>
      {offline ? <WifiOff size={28} aria-hidden="true" /> : <AlertTriangle size={28} aria-hidden="true" />}
      <h3>{offline ? 'Server unreachable' : title}</h3>
      <p className="small">{error?.message || String(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry} data-testid={`${testid}-retry-button`}>
          <RefreshCw size={14} aria-hidden="true" /> Retry
        </button>
      ) : null}
    </div>
  )
}

export function PermissionDenied({ what = 'this page', testid = 'permission-denied-state' }) {
  return (
    <div className="panel">
      <div className="state denied" data-testid={testid}>
        <Lock size={28} aria-hidden="true" />
        <h3>Administrator access required</h3>
        <p className="small">Your viewer role can monitor telemetry but cannot access {what}. Ask an administrator if you need changes made.</p>
      </div>
    </div>
  )
}

export function Banner({ kind = 'info', children, testid }) {
  const Icon = kind === 'offline' ? WifiOff : kind === 'ok' ? CheckCircle2 : kind === 'warn' ? AlertTriangle : Info
  return (
    <div className={`banner ${kind}`} role={kind === 'offline' ? 'alert' : 'status'} data-testid={testid}>
      <Icon size={16} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled, testid, id }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={!!checked} disabled={disabled}
        aria-checked={!!checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  )
}

export function Pagination({ page, pages, total, onPage, testid = 'pagination' }) {
  return (
    <div className="pagination" data-testid={testid}>
      <span data-testid={`${testid}-summary`}>{total} record{total === 1 ? '' : 's'} · page {page} of {pages}</span>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}
          data-testid={`${testid}-prev-button`} aria-label="Previous page">
          <ChevronLeft size={14} aria-hidden="true" /> Prev
        </button>
        <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}
          data-testid={`${testid}-next-button`} aria-label="Next page">
          Next <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts, dismiss } = useToast()
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions" data-testid="toast-region">
      {toasts.map((t) => {
        const Icon = t.kind === 'early_warning' ? TrendingUp
          : ['critical', 'major', 'error'].includes(t.kind) ? AlertOctagon : t.kind === 'info' ? Info : CheckCircle2
        const color = t.kind === 'early_warning' ? 'c-info'
          : ['critical', 'major', 'error'].includes(t.kind) ? 'c-critical' : t.kind === 'info' ? 'c-info' : 'c-nominal'
        return (
          <div key={t.id} className={`toast ${t.kind}`} role={['critical', 'major', 'error'].includes(t.kind) ? 'alert' : 'status'}
            data-testid={t.testid || `toast-${t.kind}`}>
            <Icon size={18} className={color} aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <div className="t-title">{t.title}</div>
              {t.body ? <div className="t-body">{t.body}</div> : null}
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" style={{ width: 28 }} onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification" data-testid="toast-dismiss-button">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Dialog({ title, onClose, children, testid }) {
  const ref = useRef(null)
  useEffect(() => {
    const prev = document.activeElement
    const el = ref.current
    el?.querySelector('input, select, textarea, button')?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && el) {
        const f = el.querySelectorAll('button, input, select, textarea, a[href]')
        if (!f.length) return
        const first = f[0]; const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [onClose])
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref} data-testid={testid}>
        <div className="panel-head">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog" data-testid={`${testid}-close-button`}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </>
  )
}

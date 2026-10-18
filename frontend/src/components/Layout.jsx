import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity, Bell, BellRing, Cpu, FileSpreadsheet, Gauge, History, Info, LayoutDashboard, Lock, Menu, Radio,
  Settings, SlidersHorizontal, Users, X,
} from 'lucide-react'
import { useAuth, useLive } from '../lib/context'
import { fmtAgo, fmtTime, fmtValue } from '../lib/format'
import ProfileMenu from './ProfileMenu'
import { Badge, Banner, SeverityBadge, Toasts } from './ui'

// Shortcuts in the admin's profile card.
const ADMIN_LINKS = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/users', label: 'Manage users', icon: Users },
  { to: '/notifications', label: 'Notification settings', icon: Bell },
  { to: '/system', label: 'System settings', icon: Settings },
  { to: '/about', label: 'About the project', icon: Info },
]

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, id: 'overview', end: true },
  { to: '/telemetry', label: 'Live telemetry', icon: Activity, id: 'telemetry' },
  { to: '/history', label: 'Historical alerts', icon: History, id: 'history' },
  { to: '/nodes', label: 'Sensor nodes', icon: Cpu, id: 'nodes' },
  { section: 'Configuration' },
  { to: '/thresholds', label: 'Threshold settings', icon: SlidersHorizontal, id: 'thresholds' },
  { to: '/notifications', label: 'Notifications', icon: Bell, id: 'notifications', admin: true },
  { to: '/google-sheets', label: 'Google Sheets', icon: FileSpreadsheet, id: 'google-sheets', admin: true },
  { to: '/users', label: 'Users', icon: Users, id: 'users', admin: true },
  { to: '/system', label: 'System settings', icon: Settings, id: 'system' },
  { section: 'Project' },
  { to: '/about', label: 'About the project', icon: Info, id: 'about' },
]

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 21V4h14v17M3 21h18M9 8h2M13 8h2M9 12h2M13 12h2M10 21v-4h4v4" />
      </svg>
    </div>
  )
}

function ConnectionIndicator({ testid = 'live-connection-indicator' }) {
  const { telemetry, error, online } = useLive()
  let state = telemetry?.connection || 'no_data'
  let label = { healthy: 'Live', degraded: 'Delayed', stale: 'Stale', no_data: 'No data' }[state] || state
  if (!online || error) { state = 'offline-conn'; label = 'Offline' }
  const cls = state === 'healthy' ? 'healthy' : state === 'degraded' ? 'degraded' : 'critical'
  return (
    <span className="row nowrap" style={{ gap: 7 }} data-testid={testid} data-state={state}
      title={error || 'Telemetry connection status'}>
      <span className={`dot ${cls} ${state === 'healthy' ? 'pulse' : ''}`} aria-hidden="true" />
      <span className="mono small" style={{ fontWeight: 600 }}>{label.toUpperCase()}</span>
    </span>
  )
}

function NotificationMenu() {
  const { recent, permission, requestPermission } = useLive()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const openAlerts = recent.filter((a) => a.status === 'open' && a.type === 'threshold')
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className={`btn btn-icon ${openAlerts.length ? 'btn-danger' : ''} alert-indicator`}
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true"
        aria-label={`Notifications, ${openAlerts.length} open alerts`} data-testid="header-notification-button">
        {openAlerts.length ? <BellRing size={17} aria-hidden="true" /> : <Bell size={17} aria-hidden="true" />}
        {openAlerts.length ? <span className="count" data-testid="header-open-alert-count">{openAlerts.length}</span> : null}
      </button>
      {open ? (
        <div className="dropdown" role="dialog" aria-label="Recent alerts" data-testid="notification-dropdown">
          <div className="panel-head">
            <h3>Recent alerts</h3>
            {permission === 'granted' ? <Badge value="sent" label="Browser alerts on" testid="browser-notification-status" />
              : permission === 'unsupported' ? <Badge value="disabled" label="Not supported" testid="browser-notification-status" />
                : permission === 'denied' ? <Badge value="failed" label="Blocked in browser" testid="browser-notification-status" />
                  : (
                    <button type="button" className="btn btn-sm btn-primary" onClick={requestPermission}
                      data-testid="browser-notification-enable-button">Enable browser alerts</button>
                  )}
          </div>
          {recent.length === 0 ? <p className="muted small" style={{ padding: 14 }} data-testid="notification-dropdown-empty">No alerts recorded.</p> : (
            <ul className="alert-list">
              {recent.slice(0, 8).map((a) => (
                <li key={a.id} className={`alert-item ${a.severity} ${a.status}`} data-testid={`notification-item-${a.id}`}>
                  <span className="bar" aria-hidden="true" />
                  <div>
                    <div className="alert-title">{a.label} <SeverityBadge severity={a.severity} /></div>
                    <div className="alert-sub">
                      <span className="mono">{fmtValue(a.parameter, a.value)} {a.unit}</span> · {a.node_id} · {a.location}
                    </div>
                    <div className="dim xs mono">{fmtAgo(a.created_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
            <NavLink to="/history" onClick={() => setOpen(false)} data-testid="notification-dropdown-view-all-link">View all alerts →</NavLink>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default function Layout() {
  const { user, isAdmin } = useAuth()
  const { telemetry, error, online, lastOk } = useLive()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()
  const [, setTick] = useState(0)
  useEffect(() => { setNavOpen(false) }, [location.pathname])
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 1000); return () => clearInterval(id) }, [])

  return (
    <div className="app">
      <a href="#main" className="skip-link" data-testid="skip-to-content-link">Skip to content</a>
      {navOpen ? <div className="scrim" style={{ zIndex: 35 }} onClick={() => setNavOpen(false)} /> : null}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`} data-testid="sidebar" aria-label="Primary">
        <div className="brand">
          <BrandMark />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name" data-testid="app-logo">Smart <span>SHM</span></div>
            <div className="brand-sub">Structural health monitoring</div>
          </div>
          <button type="button" className="btn btn-ghost btn-icon menu-btn" style={{ marginLeft: 'auto' }}
            onClick={() => setNavOpen(false)} aria-label="Close navigation" data-testid="sidebar-close-button">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <nav className="nav">
          {NAV.map((item) => item.section ? (
            <div key={item.section} className="nav-section">{item.section}</div>
          ) : (
            <NavLink key={item.to} to={item.to} end={item.end} data-testid={`nav-${item.id}-link`}>
              <item.icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === 'history' && telemetry?.open_alerts ? (
                <span className="badge b-critical badge-count" data-testid="nav-open-alerts-badge">{telemetry.open_alerts}</span>
              ) : null}
              {item.admin && !isAdmin ? <Lock size={13} className="lock" aria-label="Administrator only" /> : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="row"><Radio size={12} aria-hidden="true" /> Sources: simulated · HTTP · MQTT</div>
          <div className="mono" style={{ marginTop: 4 }}>v1.0.0</div>
        </div>
      </aside>

      <div className="main">
        <header className="header" data-testid="app-header">
          <button type="button" className="btn btn-ghost btn-icon menu-btn" onClick={() => setNavOpen(true)}
            aria-label="Open navigation" aria-expanded={navOpen} data-testid="header-menu-button">
            <Menu size={18} aria-hidden="true" />
          </button>
          <div className="structure">
            <span className="label">Structure</span>
            <span className="name" data-testid="header-structure-name">{telemetry?.structure_name || '—'}</span>
          </div>
          <div className="header-right">
            <div className="header-meta">
              <ConnectionIndicator />
              <span className="row nowrap" title="Last successful update" data-testid="header-last-sync">
                <Gauge size={13} aria-hidden="true" />
                <span className="mono">{telemetry?.last_reading_at ? fmtTime(telemetry.last_reading_at) : '—'}</span>
              </span>
            </div>
            <NotificationMenu />
            <ProfileMenu links={ADMIN_LINKS} nameTestid="header-current-user" roleTestid="header-role-label" logoutTestid="logout-button" />
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {!online ? (
            <Banner kind="offline" testid="offline-banner">
              <strong>You are offline.</strong> Live data is paused and will resume automatically when the connection returns.
            </Banner>
          ) : error ? (
            <Banner kind="offline" testid="connection-error-banner">
              <strong>Connection problem:</strong> {error} Last good update {fmtAgo(lastOk)}. Retrying every 5 seconds…
            </Banner>
          ) : null}
          {/* mobile-only connection line (header meta is hidden on small screens) */}
          <div className="mobile-meta row small muted" data-testid="mobile-connection-row">
            <ConnectionIndicator testid="mobile-live-connection-indicator" />
            <span className="mono">{telemetry?.last_reading_at ? fmtTime(telemetry.last_reading_at) : ''}</span>
            <span className="spacer" />
            <span className="nowrap" data-testid="mobile-current-user">{user.name || user.email} · {user.role}</span>
          </div>
          <Outlet />
        </main>
      </div>
      <Toasts />
    </div>
  )
}

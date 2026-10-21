import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { SEVERITY_LABEL, fmtValue } from './format'

/* ------------------------------------------------------------------ toasts */
const ToastCtx = createContext(null)
let toastSeq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback((toast) => {
    const id = ++toastSeq
    setToasts((t) => [...t.slice(-4), { id, kind: 'success', ...toast }])
    setTimeout(() => dismiss(id), toast.duration || 6000)
    return id
  }, [dismiss])
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])
  return <ToastCtx.Provider value={value}>{children}</ToastCtx.Provider>
}
export const useToast = () => useContext(ToastCtx)

/* -------------------------------------------------------------------- auth */
const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sessionMessage, setSessionMessage] = useState('')
  const userRef = useRef(null)
  userRef.current = user

  useEffect(() => {
    api('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const onUnauthorized = (e) => {
      if (!userRef.current) return
      setUser(null)
      setSessionMessage(e.detail === 'Session expired'
        ? 'Your session has expired. Please sign in again.'
        : 'Your session has ended. Please sign in again.')
    }
    window.addEventListener('shm:unauthorized', onUnauthorized)
    return () => window.removeEventListener('shm:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (email, password) => {
    const d = await api('/api/auth/login', { method: 'POST', body: { email, password } })
    setSessionMessage('')
    setUser(d.user)
    return d.user
  }, [])

  const signup = useCallback(async (name, email, password) => {
    const d = await api('/api/auth/signup', { method: 'POST', body: { name, email, password } })
    setSessionMessage('')
    setUser(d.user)
    return d.user
  }, [])

  const logout = useCallback(async () => {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* cookie is cleared server side anyway */ }
    setSessionMessage('You have been signed out.')
    setUser(null)
  }, [])

  // After the profile card changes the name or picture, the API returns the updated user.
  const updateUser = useCallback((u) => setUser((cur) => (cur && u ? { ...cur, ...u } : cur)), [])

  const value = useMemo(() => ({
    user, loading, login, signup, logout, updateUser, sessionMessage, isAdmin: user?.role === 'admin',
  }), [user, loading, login, signup, logout, updateUser, sessionMessage])
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
export const useAuth = () => useContext(AuthCtx)

/* -------------------------------------------------------------- live data */
const LiveCtx = createContext(null)
const POLL_MS = 5000

function notifyBrowser(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const sev = SEVERITY_LABEL[alert.severity] || alert.severity
    // eslint-disable-next-line no-new
    new Notification(`SHM ${sev.toUpperCase()}: ${alert.label}`, {
      body: `${fmtValue(alert.parameter, alert.value)} ${alert.unit} (limit ${alert.threshold} ${alert.unit})\n${alert.node_id} · ${alert.location}`,
      tag: alert.id,
    })
  } catch { /* some browsers only allow notifications from a service worker */ }
}

export function LiveProvider({ children }) {
  const { push } = useToast()
  const [telemetry, setTelemetry] = useState(null)
  const [recent, setRecent] = useState([])
  const [error, setError] = useState(null)
  const [lastOk, setLastOk] = useState(null)
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const [browserEnabled, setBrowserEnabled] = useState(true)
  const seen = useRef(null)
  const inflight = useRef(false)

  const refresh = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const [t, ev] = await Promise.all([
        api('/api/telemetry'),
        api('/api/events', { query: { page_size: 20 } }),
      ])
      setTelemetry(t)
      setRecent(ev.items)
      setError(null)
      setLastOk(new Date().toISOString())
      if (seen.current === null) {
        seen.current = new Set(ev.items.map((a) => a.id))
      } else {
        const fresh = ev.items.filter((a) => !seen.current.has(a.id)).reverse()
        fresh.forEach((a) => {
          seen.current.add(a.id)
          const ew = a.type === 'early_warning'
          push({
            kind: a.severity,
            duration: 10000,
            testid: ew ? 'early-warning-toast' : 'alert-toast',
            title: ew ? `Early warning · ${a.label}` : `${(SEVERITY_LABEL[a.severity] || '').toUpperCase()} · ${a.label} limit exceeded`,
            body: ew ? `${a.node_id} · ${a.location} — ${a.reason}`
              : `${fmtValue(a.parameter, a.value)} ${a.unit} ≥ ${a.threshold} ${a.unit} at ${a.node_id} · ${a.location}`,
          })
          if (browserEnabled) notifyBrowser(a)
        })
      }
    } catch (e) {
      if (e.status !== 401) setError(e.message)
    } finally {
      inflight.current = false
    }
  }, [push, browserEnabled])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    api('/api/notifications/status').then((d) => setBrowserEnabled(d.settings?.browser_enabled !== false)).catch(() => {})
    const up = () => { setOnline(true); refresh() }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [refresh])

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) { setPermission('unsupported'); return 'unsupported' }
    const p = await Notification.requestPermission()
    setPermission(p)
    return p
  }, [])

  const value = useMemo(() => ({
    telemetry, recent, error, lastOk, online, refresh, permission, requestPermission, browserEnabled,
  }), [telemetry, recent, error, lastOk, online, refresh, permission, requestPermission, browserEnabled])
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
}
export const useLive = () => useContext(LiveCtx)

/* ------------------------------------------------------- generic fetching */
export function useFetch(path, query, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const key = JSON.stringify(query || {})
  const load = useCallback(async () => {
    if (!path) { setState({ data: null, error: null, loading: false }); return } // nothing to load (yet)
    setState((s) => ({ ...s, loading: true }))
    try {
      const data = await api(path, { query })
      setState({ data, error: null, loading: false })
    } catch (e) {
      setState({ data: null, error: e, loading: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, ...deps])
  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Eye, EyeOff, LogIn } from 'lucide-react'
import { BrandMark } from '../components/Layout'
import { Banner } from '../components/ui'
import { useAuth } from '../lib/context'

// Small brand block at the top of the Login / Sign up form.
export function AuthBrand({ testid }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <BrandMark />
      <div>
        <div className="brand-name" data-testid={testid}>Smart <span>SHM System</span></div>
        <div className="brand-sub">EPD HS30223 · Group 10</div>
      </div>
    </div>
  )
}

// Line drawing of the monitored building with its sensor nodes, for the coloured panel.
function PanelBuilding() {
  return (
    <svg className="auth-building" viewBox="0 0 160 110" aria-hidden="true">
      <line x1="6" y1="104" x2="154" y2="104" stroke="#fff" strokeOpacity=".7" strokeWidth="2" />
      <rect x="40" y="18" width="80" height="86" fill="none" stroke="#fff" strokeWidth="2" />
      {[39, 60, 82].map((y) => <line key={y} x1="36" y1={y} x2="124" y2={y} stroke="#fff" strokeWidth="2" />)}
      {[67, 93].map((x) => <line key={x} x1={x} y1="18" x2={x} y2="104" stroke="#fff" strokeOpacity=".45" />)}
      <rect x="86" y="4" width="22" height="12" fill="none" stroke="#fff" strokeWidth="2" />
      {[[48, 100], [80, 82], [56, 60], [112, 39], [97, 10]].map(([x, y]) => (
        <g key={`${x}${y}`}>
          <circle cx={x} cy={y} r="7" fill="#fff" fillOpacity=".25" />
          <circle cx={x} cy={y} r="3.5" fill="#fff" />
        </g>
      ))}
    </svg>
  )
}

// Text of the coloured panel: invites you to the other form. `mode` is the form this text sits beside.
export function AuthPanelContent({ mode }) {
  const login = mode === 'login'
  return (
    <>
      <PanelBuilding />
      <h2>{login ? 'New here?' : 'Welcome back!'}</h2>
      <p>
        {login
          ? 'Sign up with your Gmail to watch live strain, vibration and temperature readings from every sensor node.'
          : 'Already have an account? Log in to open your dashboard or the live readings.'}
      </p>
      <Link to={login ? '/signup' : '/login'} className="btn btn-outline-light" data-testid={login ? 'login-signup-link' : 'signup-login-link'}>
        {login ? 'Sign up' : 'Login'}
      </Link>
      <Link to="/about" className="auth-about-link" data-testid={login ? 'login-about-link' : 'signup-about-link'}>
        About the project <ArrowRight size={13} aria-hidden="true" />
      </Link>
    </>
  )
}

// Administrators go to the dashboard (or the page they asked for); everyone else to the readings page.
export function homeFor(user, from) {
  if (user?.role !== 'admin') return '/user'
  return from && from !== '/user' && from !== '/login' && from !== '/signup' ? from : '/'
}

// The Login form; it lives in the sliding auth card (pages/Auth.jsx).
export default function LoginForm() {
  const { login, sessionMessage } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    setBusy(true)
    setError('')
    try {
      const u = await login(email.trim(), password)
      nav(homeFor(u, location.state?.from), { replace: true })
    } catch (err) {
      setError(err.message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate aria-describedby={error ? 'login-error' : undefined}>
      <AuthBrand testid="login-logo" />
      <div>
        <h1 data-testid="login-title">Login</h1>
        <p className="small muted" style={{ marginTop: 4 }}>One login for everyone: admins open the dashboard, users see the live readings.</p>
      </div>
      {sessionMessage && !error ? <Banner kind="info" testid="login-session-message">{sessionMessage}</Banner> : null}
      {error ? (
        <div className="banner offline" role="alert" id="login-error" data-testid="login-error-message">
          <AlertTriangle size={16} aria-hidden="true" /> <span>{error}</span>
        </div>
      ) : null}
      <label className="field"><span className="field-label">Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required
          placeholder="name@gmail.com" data-testid="login-email-input" />
      </label>
      <label className="field"><span className="field-label">Password</span>
        <div style={{ position: 'relative' }}>
          <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            required style={{ paddingRight: 44 }} placeholder="Enter your password" data-testid="login-password-input" />
          <button type="button" className="btn btn-ghost btn-icon" style={{ position: 'absolute', right: 2, top: 2, minHeight: 36, width: 40 }}
            onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} data-testid="login-password-visibility-button">
            {show ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
          </button>
        </div>
      </label>
      <button type="submit" className="btn btn-accent auth-submit" disabled={busy} data-testid="login-submit-button">
        {busy ? <span className="spinner" aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />} {busy ? 'Logging in…' : 'Login'}
      </button>
      <p className="xs dim">Repeated failed attempts temporarily lock the account.</p>
    </form>
  )
}

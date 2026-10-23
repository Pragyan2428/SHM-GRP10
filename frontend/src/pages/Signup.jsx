import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, Eye, EyeOff, UserPlus } from 'lucide-react'
import { useAuth } from '../lib/context'
import { AuthBrand, homeFor } from './Login'

const MIN_PASSWORD = 10
export const EMAIL_DOMAIN = 'gmail.com' // sign-up only accepts name@gmail.com (the API enforces it too)

function validate({ name, email, password, confirm }) {
  if (!name.trim() || !email.trim() || !password || !confirm) return 'Fill in every field.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.'
  if (!email.trim().toLowerCase().endsWith(`@${EMAIL_DOMAIN}`)) return `Only Gmail addresses can sign up, like name@${EMAIL_DOMAIN}.`
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`
  if (password !== confirm) return 'Passwords do not match.'
  return ''
}

// The Sign up form; it lives in the sliding auth card (pages/Auth.jsx).
export default function SignupForm() {
  const { signup } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' })
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const problem = validate(form)
    if (problem) { setError(problem); return }
    setBusy(true)
    setError('')
    try {
      const u = await signup(form.name.trim(), form.email.trim(), form.password)
      nav(homeFor(u), { replace: true })
    } catch (err) {
      setError(err.status === 422 ? 'Check your name, email address and password, then try again.' : err.message)
      setBusy(false)
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate aria-describedby={error ? 'signup-error' : undefined}>
      <AuthBrand />
      <div>
        <h1 data-testid="signup-title">Sign up</h1>
        <p className="small muted" style={{ marginTop: 4 }}>Create an account to see the live sensor readings.</p>
      </div>
      {error ? (
        <div className="banner offline" role="alert" id="signup-error" data-testid="signup-error-message">
          <AlertTriangle size={16} aria-hidden="true" /> <span>{error}</span>
        </div>
      ) : null}
      <label className="field"><span className="field-label">Full name</span>
        <input type="text" autoComplete="name" value={form.name} onChange={set('name')} required maxLength={80}
          data-testid="signup-name-input" />
      </label>
      <label className="field"><span className="field-label">Email</span>
        <input type="email" autoComplete="email" value={form.email} onChange={set('email')} required
          placeholder={`name@${EMAIL_DOMAIN}`} aria-describedby="signup-email-hint" data-testid="signup-email-input" />
        <span className="xs dim" id="signup-email-hint">Use your Gmail address.</span>
      </label>
      <label className="field"><span className="field-label">Password</span>
        <div style={{ position: 'relative' }}>
          <input type={show ? 'text' : 'password'} autoComplete="new-password" value={form.password} onChange={set('password')}
            required minLength={MIN_PASSWORD} maxLength={128} style={{ paddingRight: 44 }} aria-describedby="signup-password-hint"
            data-testid="signup-password-input" />
          <button type="button" className="btn btn-ghost btn-icon" style={{ position: 'absolute', right: 2, top: 2, minHeight: 36, width: 40 }}
            onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} data-testid="signup-password-visibility-button">
            {show ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
          </button>
        </div>
        <span className="xs dim" id="signup-password-hint">At least {MIN_PASSWORD} characters.</span>
      </label>
      <label className="field"><span className="field-label">Confirm password</span>
        <input type={show ? 'text' : 'password'} autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required
          data-testid="signup-confirm-input" />
      </label>
      <button type="submit" className="btn btn-accent auth-submit" disabled={busy} data-testid="signup-submit-button">
        {busy ? <span className="spinner" aria-hidden="true" /> : <UserPlus size={15} aria-hidden="true" />} {busy ? 'Creating account…' : 'Create account'}
      </button>
      <p className="auth-mobile-switch">Already have an account? <Link to="/login" data-testid="mobile-login-link">Log in</Link></p>
    </form>
  )
}

import { useEffect, useLayoutEffect, useRef } from 'react'
import ShmBackdrop from '../components/ShmBackdrop'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/context'
import LoginForm, { AuthPanelContent, homeFor } from './Login'
import SignupForm from './Signup'

// One card for /login and /signup. Both forms stay mounted; switching route slides the
// orange panel across to the other side while the forms slide and fade (on phones the
// forms slide sideways), and the card eases to the height of the form now showing.
export default function AuthPage() {
  const { user } = useAuth()
  const location = useLocation()
  const mode = location.pathname.startsWith('/signup') ? 'signup' : 'login'
  const panesRef = useRef(null)
  const loginRef = useRef(null)
  const signupRef = useRef(null)
  const firstRun = useRef(true)

  useLayoutEffect(() => {
    const panes = panesRef.current
    const active = (mode === 'login' ? loginRef : signupRef).current
    if (!panes || !active) return undefined
    const fit = () => { panes.style.height = `${active.offsetHeight}px` }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(active)
    return () => ro.disconnect()
  }, [mode, user])

  useEffect(() => {
    const pane = (mode === 'login' ? loginRef : signupRef).current
    const t = setTimeout(() => pane?.querySelector('input')?.focus({ preventScroll: true }), firstRun.current ? 30 : 560)
    firstRun.current = false
    return () => clearTimeout(t)
  }, [mode])

  if (user) return <Navigate to={homeFor(user, location.state?.from)} replace />

  const off = (m) => (mode === m ? {} : { inert: 'true', 'aria-hidden': 'true' })
  return (
    <div className="auth-page">
      <ShmBackdrop />
      <main className={`auth-card slider ${mode}`} data-mode={mode}>
        <div className="auth-panes" ref={panesRef}>
          <section className={`auth-pane pane-login ${mode === 'login' ? 'active' : ''}`} ref={loginRef} data-testid="login-page" {...off('login')}>
            <LoginForm />
          </section>
          <section className={`auth-pane pane-signup ${mode === 'signup' ? 'active' : ''}`} ref={signupRef} data-testid="signup-page" {...off('signup')}>
            <SignupForm />
          </section>
        </div>
        <aside className="auth-panel auth-overlay" aria-label={mode === 'login' ? 'New here' : 'Already registered'}>
          <div className="auth-overlay-inner">
            <div className={`ov-content ov-login ${mode === 'login' ? 'active' : ''}`} {...off('login')}><AuthPanelContent mode="login" /></div>
            <div className={`ov-content ov-signup ${mode === 'signup' ? 'active' : ''}`} {...off('signup')}><AuthPanelContent mode="signup" /></div>
          </div>
        </aside>
      </main>
    </div>
  )
}

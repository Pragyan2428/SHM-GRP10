import { lazy, Suspense } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Compass } from 'lucide-react'
import Layout from './components/Layout'
import { EmptyState, Loading } from './components/ui'
import { AuthProvider, LiveProvider, ToastProvider, useAuth } from './lib/context'
import AuthPage from './pages/Auth'

// Every page except Login/Sign up is downloaded only when it is opened, so the login page
// stays small and the chart library loads only on pages with charts.
const About = lazy(() => import('./pages/About'))
const GoogleSheets = lazy(() => import('./pages/GoogleSheets'))
const UserStructure = lazy(() => import('./pages/UserStructure'))
const History = lazy(() => import('./pages/History'))
const LiveTelemetry = lazy(() => import('./pages/LiveTelemetry'))
const NodesPage = lazy(() => import('./pages/Nodes').then((m) => ({ default: m.NodesPage })))
const NodeDetailPage = lazy(() => import('./pages/Nodes').then((m) => ({ default: m.NodeDetailPage })))
const Notifications = lazy(() => import('./pages/Notifications'))
const Overview = lazy(() => import('./pages/Overview'))
const System = lazy(() => import('./pages/System'))
const Thresholds = lazy(() => import('./pages/Thresholds'))
const UserReadings = lazy(() => import('./pages/UserReadings'))
const Users = lazy(() => import('./pages/Users'))

const pageLoading = <Loading label="Loading…" testid="page-loading-state" />

function useSession() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return { gate: <div className="login-page"><Loading label="Checking session…" testid="session-loading-state" /></div> }
  if (!user) return { gate: <Navigate to="/login" replace state={{ from: location.pathname }} /> }
  return { user }
}

// The dashboard is for administrators; everyone else only gets the readings page.
function Protected() {
  const { gate, user } = useSession()
  if (gate) return gate
  if (user.role !== 'admin') return <Navigate to="/user" replace />
  return (
    <LiveProvider>
      <Layout />
    </LiveProvider>
  )
}

function UserOnly() {
  const { gate } = useSession()
  return gate || <Suspense fallback={pageLoading}><UserReadings /></Suspense>
}

function NotFound() {
  return (
    <div className="panel">
      <div className="nf-photo" aria-hidden="true"><img src="/images/notfound-crack.webp" alt="" /><span>This page has a crack in it.</span></div>
      <EmptyState icon={Compass} title="Page not found" message="That page does not exist." testid="not-found-state">
        <Link to="/" className="btn btn-sm" data-testid="not-found-home-link">Back to overview</Link>
      </EmptyState>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          {/* one persistent card, so switching between Login and Sign up can slide */}
          <Route element={<AuthPage />}>
            <Route path="/login" element={null} />
            <Route path="/signup" element={null} />
          </Route>
          <Route path="/about" element={<Suspense fallback={pageLoading}><About /></Suspense>} />
          <Route path="/user" element={<UserOnly />} />
          <Route element={<Protected />}>
            <Route index element={<Overview />} />
            <Route path="telemetry" element={<LiveTelemetry />} />
            <Route path="history" element={<History />} />
            <Route path="nodes" element={<NodesPage />} />
            <Route path="nodes/:nodeId" element={<NodeDetailPage />} />
            <Route path="thresholds" element={<Thresholds />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="google-sheets" element={<GoogleSheets />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:userId" element={<UserStructure />} />
            <Route path="system" element={<System />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  )
}

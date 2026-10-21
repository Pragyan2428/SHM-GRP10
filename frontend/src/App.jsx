import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Compass } from 'lucide-react'
import Layout from './components/Layout'
import { EmptyState, Loading } from './components/ui'
import { AuthProvider, LiveProvider, ToastProvider, useAuth } from './lib/context'
import About from './pages/About'
import GoogleSheets from './pages/GoogleSheets'
import UserStructure from './pages/UserStructure'
import History from './pages/History'
import LiveTelemetry from './pages/LiveTelemetry'
import AuthPage from './pages/Auth'
import { NodeDetailPage, NodesPage } from './pages/Nodes'
import Notifications from './pages/Notifications'
import Overview from './pages/Overview'
import System from './pages/System'
import Thresholds from './pages/Thresholds'
import UserReadings from './pages/UserReadings'
import Users from './pages/Users'

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
  return gate || <UserReadings />
}

function NotFound() {
  return (
    <div className="panel">
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
          <Route path="/about" element={<About />} />
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

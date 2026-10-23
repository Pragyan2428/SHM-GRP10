// Administrators: one account's building — the 3D structure drawn from that account's own ESP32
// nodes, its floor plans and its node list — exactly what the account sees on its own dashboard.
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { FloorPlans } from '../components/FloorPlan'
import { DigitalTwin } from '../components/twin'
import { Badge, EmptyState, ErrorState, Loading, PermissionDenied } from '../components/ui'
import { useAuth, useFetch, useLive } from '../lib/context'
import { floorName, fmtAgo } from '../lib/format'

export default function UserStructure() {
  const { userId } = useParams()
  const { isAdmin } = useAuth()
  const { telemetry } = useLive()
  const users = useFetch(isAdmin ? '/api/users' : null)
  const tel = useFetch(isAdmin ? '/api/telemetry' : null, { owner: userId, points: 30 }, [telemetry?.last_reading_at, userId])

  if (!isAdmin) return <><div className="page-head"><h1 data-testid="page-title">Building</h1></div><PermissionDenied what="other accounts' buildings" /></>
  const error = users.error || tel.error
  if (error) return <div className="panel"><ErrorState error={error} onRetry={() => { users.reload(); tel.reload() }} testid="user-structure-error" /></div>
  if (!users.data || !tel.data) return <Loading label="Loading building…" testid="user-structure-loading" />
  const u = users.data.items.find((x) => x.id === userId)
  if (!u) return <div className="panel"><EmptyState title="User not found" message="This account no longer exists." testid="user-structure-missing" /></div>
  const t = tel.data
  const nodes = [...t.nodes].sort((a, b) => a.node_id.localeCompare(b.node_id))

  return (
    <div data-testid="user-structure">
      <div className="page-head">
        <div>
          <Link to="/users" className="small row" style={{ gap: 4 }} data-testid="user-structure-back"><ArrowLeft size={13} aria-hidden="true" /> Users</Link>
          <h1 data-testid="page-title">{u.building_name || `${u.name}’s building`}</h1>
          <p>
            <span className="mono" data-testid="user-structure-id">{u.short_id}</span> · {u.building_name ? <>{u.name} · </> : null}<span className="mono">{u.email}</span> · <Badge value={u.role} label={u.role === 'admin' ? 'Administrator' : 'Viewer'} /> ·{' '}
            <span data-testid="user-structure-count">{t.total_nodes} node{t.total_nodes === 1 ? '' : 's'}</span>, {t.active_nodes} online
          </p>
        </div>
      </div>

      {t.total_nodes === 0 ? (
        <div className="panel">
          <EmptyState title="No ESP32 connected yet" testid="user-structure-empty"
            message="Their building appears here as soon as one of their ESP32s sends data with their device key, or when you add a node for them on the Nodes page." />
        </div>
      ) : (
        <>
          <DigitalTwin t={t} />
          <section className="panel" aria-labelledby="us-plans">
            <div className="panel-head"><h2 id="us-plans">Floor plans</h2></div>
            <div className="panel-body"><FloorPlans nodes={nodes} testid="user-structure-plans" /></div>
          </section>
          <section className="panel" aria-labelledby="us-nodes">
            <div className="panel-head"><h2 id="us-nodes">Their nodes</h2></div>
            <table className="data responsive" data-testid="user-structure-nodes">
              <thead><tr><th>Node</th><th>Location</th><th>Floor</th><th>Status</th><th>Last seen</th></tr></thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.node_id} data-testid={`user-structure-node-${n.node_id.toLowerCase()}`}>
                    <td data-label="Node"><Link to={`/nodes/${n.node_id}`} className="mono">{n.node_id}</Link></td>
                    <td data-label="Location" className="break">{n.location}</td>
                    <td data-label="Floor">{n.floor == null ? '—' : floorName(n.floor)}</td>
                    <td data-label="Status"><Badge value={n.online ? n.condition : 'offline'} /></td>
                    <td data-label="Last seen" className="num">{n.last_seen ? fmtAgo(n.last_seen) : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}

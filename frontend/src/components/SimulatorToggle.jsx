import { useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth, useLive, useToast } from '../lib/context'
import { Badge } from './ui'

export default function SimulatorToggle({ compact = false }) {
  const { isAdmin } = useAuth()
  const { telemetry, refresh } = useLive()
  const { push } = useToast()
  const [busy, setBusy] = useState(false)
  const enabled = telemetry?.simulator_enabled
  if (enabled === undefined) return null
  if (!isAdmin) {
    return <Badge value={enabled ? 'info' : 'disabled'} label={enabled ? 'Simulated feed running' : 'Simulated feed paused'} testid="simulator-status-badge" />
  }
  const toggle = async () => {
    setBusy(true)
    try {
      await api('/api/system/simulator', { method: 'POST', body: { enabled: !enabled } })
      push({ kind: 'success', title: enabled ? 'Simulated telemetry paused' : 'Simulated telemetry resumed', testid: 'simulator-toggle-toast' })
      await refresh()
    } catch (e) {
      push({ kind: 'error', title: 'Could not change simulator', body: e.message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={`btn ${compact ? 'btn-sm' : ''} ${enabled ? '' : 'btn-primary'}`} onClick={toggle} disabled={busy}
      aria-pressed={!enabled} data-testid="simulator-toggle-button">
      {enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
      {enabled ? 'Pause simulated data' : 'Resume simulated data'}
    </button>
  )
}

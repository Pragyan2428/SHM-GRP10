// "Add your ESP32" on a user's page: find a board over Bluetooth (to give it the Wi-Fi) or on
// the same Wi-Fi, give it a place, and it becomes one of this user's nodes. No keys or commands.
import { useState } from 'react'
import { Bluetooth, CheckCircle2, Cpu, Link2, Power } from 'lucide-react'
import NearbyDevices from './NearbyDevices'
import { api } from '../lib/api'
import { useToast } from '../lib/context'

function ConnectForm({ device, onCancel, onConnected }) {
  const { push } = useToast()
  const [name, setName] = useState(device.suggested_node_id)
  const [location, setLocation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name.trim())) { setError('Name: letters, digits, - or _ (up to 32)'); return }
    if (!location.trim()) { setError('Say where it is, starting with the floor (e.g. 2nd floor - column C2)'); return }
    setBusy(true)
    try {
      await api(`/api/devices/${encodeURIComponent(device.mac)}/approve`, { method: 'POST', body: { node_id: name.trim(), location: location.trim() } })
      push({ kind: 'success', title: `${name.trim().toUpperCase()} connected`, body: 'Its readings appear here within a few seconds.', testid: 'my-node-connected-toast' })
      onConnected()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="ud-connect-form" onSubmit={submit} data-testid="my-node-form" noValidate>
      <p className="ud-sub"><Cpu size={13} aria-hidden="true" /> Connecting <span className="mono">{device.mac}</span></p>
      <label className="field"><span className="field-label">Name</span>
        <input className="mono" value={name} onChange={(e) => setName(e.target.value)} data-testid="my-node-name-input" />
      </label>
      <label className="field"><span className="field-label">Where is it? Start with the floor</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="2nd floor - column C2" data-testid="my-node-location-input" />
      </label>
      {error ? <p className="field-error" role="alert" data-testid="my-node-error">{error}</p> : null}
      <div className="row">
        <button type="submit" className="ud-pill ud-pill-accent" disabled={busy} data-testid="my-node-connect-button">{busy ? 'Connecting…' : 'Connect'}</button>
        <button type="button" className="ud-pill" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

export default function AddMyNode({ open, onConnected }) {
  const [picked, setPicked] = useState(null)
  const [done, setDone] = useState(false)
  const body = (
    <div className="ud-connect-body">
      <ol className="ud-steps" aria-label="How to connect">
        <li><span className="ud-step-icon"><Power size={16} aria-hidden="true" /></span><span><strong>Switch it on</strong>Keep the ESP32 near this phone or computer.</span></li>
        <li><span className="ud-step-icon"><Bluetooth size={16} aria-hidden="true" /></span><span><strong>Give it your Wi-Fi</strong>New board? Tap <em>Set up over Bluetooth</em>.</span></li>
        <li><span className="ud-step-icon"><Link2 size={16} aria-hidden="true" /></span><span><strong>Press Connect</strong>Say where it is. Readings appear here.</span></li>
      </ol>
      {done ? <p className="ud-sub c-nominal" data-testid="my-node-done"><CheckCircle2 size={14} aria-hidden="true" /> Connected. Add another below if you like.</p> : null}
      {picked ? (
        <ConnectForm device={picked} onCancel={() => setPicked(null)} onConnected={() => { setPicked(null); setDone(true); onConnected?.() }} />
      ) : (
        <NearbyDevices onPick={(d) => setPicked(d)} selectedMac={null} userMode />
      )}
    </div>
  )
  if (open) {
    return (
      <section className="ud-card ud-connect" id="ud-add" aria-labelledby="ud-add-title" data-testid="add-my-node">
        <div className="ud-card-head"><h2 id="ud-add-title"><Cpu size={17} aria-hidden="true" /> Add your ESP32</h2></div>
        {body}
      </section>
    )
  }
  return (
    <details className="ud-card ud-connect" id="ud-add" data-testid="add-my-node">
      <summary><Cpu size={16} aria-hidden="true" /> Add another ESP32</summary>
      {body}
    </details>
  )
}

// Add node > Nearby devices: ESP32s that are on the same Wi-Fi as this browser and waiting
// to be connected, plus "Set up over Bluetooth" for a new board that has no Wi-Fi yet.
import { useEffect, useRef, useState } from 'react'
import { Bluetooth, Check, Cpu, Loader2, Radar, Wifi } from 'lucide-react'
import { api } from '../lib/api'

// Must match the UUIDs in tools/esp32_shm_node/esp32_shm_node.ino
const BLE_SERVICE = '6e1a0001-5a4d-4f8e-9b3c-53484d000001'
const BLE_CONFIG = '6e1a0002-5a4d-4f8e-9b3c-53484d000001'
const BLE_STATUS = '6e1a0003-5a4d-4f8e-9b3c-53484d000001'
const BLE_NETWORKS = '6e1a0004-5a4d-4f8e-9b3c-53484d000001'
const POLL_MS = 3000

const enc = new TextEncoder()
const dec = new TextDecoder()
const parse = (dv) => { try { return JSON.parse(dec.decode(dv)) } catch { return null } }

const STATE_TEXT = {
  waiting_for_wifi: 'Connected over Bluetooth. Choose the Wi-Fi network.',
  connecting: 'ESP32 is joining the Wi-Fi…',
  wifi_ok: 'ESP32 is on Wi-Fi. It will appear in the list in a few seconds.',
  wifi_failed: 'ESP32 could not join that Wi-Fi. Check the password (2.4 GHz networks only) and try again.',
  bad_config: 'The ESP32 did not accept the settings. Try again.',
}

function BluetoothSetup({ onDone }) {
  const supported = typeof navigator !== 'undefined' && !!navigator.bluetooth
  const [dev, setDev] = useState(null)
  const [chars, setChars] = useState(null)
  const [nets, setNets] = useState([])
  const [state, setState] = useState(null)
  const [form, setForm] = useState({ ssid: '', pass: '', api: window.location.origin })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const devRef = useRef(null)

  useEffect(() => () => { try { devRef.current?.gatt?.disconnect() } catch { /* already gone */ } }, [])

  const connect = async () => {
    setError(''); setBusy(true)
    try {
      const d = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'SHM-' }, { services: [BLE_SERVICE] }], optionalServices: [BLE_SERVICE],
      })
      devRef.current = d
      d.addEventListener('gattserverdisconnected', () => setChars(null))
      const svc = await (await d.gatt.connect()).getPrimaryService(BLE_SERVICE)
      const [config, status, networks] = await Promise.all([
        svc.getCharacteristic(BLE_CONFIG), svc.getCharacteristic(BLE_STATUS), svc.getCharacteristic(BLE_NETWORKS)])
      const list = parse(await networks.readValue()) || []
      setNets(list)
      if (list[0]?.ssid) setForm((f) => ({ ...f, ssid: f.ssid || list[0].ssid }))
      setState((parse(await status.readValue()) || {}).state || 'waiting_for_wifi')
      status.addEventListener('characteristicvaluechanged', (e) => {
        const s = parse(e.target.value)
        if (!s) return
        setState(s.state)
        if (s.state === 'wifi_ok') onDone?.(s.mac)
      })
      await status.startNotifications()
      setDev(d); setChars({ config, status })
    } catch (e) {
      if (e.name !== 'NotFoundError') setError(e.message) // NotFoundError = the chooser was closed
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!form.ssid.trim()) { setError('Choose or type the Wi-Fi name'); return }
    setError(''); setBusy(true)
    try {
      await chars.config.writeValueWithResponse(enc.encode(JSON.stringify({ ssid: form.ssid.trim(), pass: form.pass, api: form.api.trim() })))
      setState('connecting')
    } catch (err) {
      setError(`Could not send to the ESP32: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!supported) {
    return (
      <p className="small dim" data-testid="ble-unsupported">
        Bluetooth set-up needs Chrome or Edge (on Windows, macOS, Android or ChromeOS) on an https:// address or localhost.
        Otherwise put the Wi-Fi name and password in <span className="mono">secrets.h</span>; the board still pairs from this list.
      </p>
    )
  }
  return (
    <div className="stack ble-setup" data-testid="ble-setup">
      {!chars ? (
        <>
          <p className="small dim">Power on the new ESP32 near this phone or computer. A board without Wi-Fi shows up as <span className="mono">SHM-xxxxxx</span>.</p>
          <button type="button" className="btn" onClick={connect} disabled={busy} data-testid="ble-connect-button" style={{ alignSelf: 'flex-start' }}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Bluetooth size={14} aria-hidden="true" />} Find ESP32 over Bluetooth
          </button>
        </>
      ) : (
        <div className="stack" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); send() } }}>
          <div className="small"><Bluetooth size={13} aria-hidden="true" /> <strong className="mono">{dev?.name}</strong> · {STATE_TEXT[state] || state}</div>
          <div className="grid grid-2">
            <label className="field"><span className="field-label">Wi-Fi network</span>
              <input list="ble-nets" value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} data-testid="ble-ssid-input" />
              <datalist id="ble-nets">{nets.map((n) => <option key={n.ssid} value={n.ssid}>{`${n.rssi} dBm`}</option>)}</datalist>
            </label>
            <label className="field"><span className="field-label">Wi-Fi password</span>
              <input type="password" value={form.pass} onChange={(e) => setForm({ ...form, pass: e.target.value })} autoComplete="off" data-testid="ble-pass-input" />
            </label>
          </div>
          <label className="field"><span className="field-label">Server address the ESP32 sends to</span>
            <input className="mono" value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })} data-testid="ble-api-input" />
          </label>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy || state === 'connecting'} style={{ alignSelf: 'flex-start' }} data-testid="ble-send-button">
            {state === 'connecting' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : state === 'wifi_ok' ? <Check size={14} aria-hidden="true" /> : <Wifi size={14} aria-hidden="true" />}
            {state === 'wifi_ok' ? 'Sent' : 'Send Wi-Fi to ESP32'}
          </button>
        </div>
      )}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
  )
}

export default function NearbyDevices({ selectedMac, onPick, userMode = false }) {
  const [scope, setScope] = useState('network')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [ble, setBle] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => api('/api/devices/discovered', { query: { scope } })
      .then((d) => { if (alive) { setData(d); setError('') } })
      .catch((e) => { if (alive) setError(e.message) })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, POLL_MS) // no scanning in a background tab
    return () => { alive = false; clearInterval(id) }
  }, [scope])

  const items = data?.items || []
  return (
    <section className="nearby" aria-labelledby="nearby-title" data-testid="nearby-devices">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 id="nearby-title" className="row" style={{ gap: 6, margin: 0, fontSize: 14 }}>
          <Radar size={15} aria-hidden="true" /> Nearby ESP32s {scope === 'network' ? 'on your Wi-Fi' : 'on any network'}
        </h3>
        <div className="pill-tabs" role="group" aria-label="Which devices">
          <button type="button" className="pill-tab" aria-pressed={scope === 'network'} onClick={() => setScope('network')} data-testid="nearby-scope-network">Same Wi-Fi</button>
          {userMode ? null : (
            <button type="button" className="pill-tab" aria-pressed={scope === 'all'} onClick={() => setScope('all')} data-testid="nearby-scope-all">
              All waiting{data && scope === 'network' && data.other_networks ? ` (+${data.other_networks})` : ''}
            </button>
          )}
          <button type="button" className="pill-tab" aria-pressed={ble} onClick={() => setBle((b) => !b)} data-testid="nearby-ble-toggle">
            <Bluetooth size={12} aria-hidden="true" /> Set up over Bluetooth
          </button>
        </div>
      </div>

      {ble ? <BluetoothSetup onDone={() => setScope('network')} /> : null}

      {error ? <p className="field-error" role="alert">{error}</p>
        : !data ? <p className="small dim"><Loader2 size={13} className="spin" aria-hidden="true" /> Looking for devices…</p>
          : items.length === 0 ? (
            <p className="small dim" data-testid="nearby-empty">
              <Loader2 size={13} className="spin" aria-hidden="true" /> Searching… Power on an ESP32 with the SHM firmware.
              No Wi-Fi on it yet? Use <strong>Set up over Bluetooth</strong>.{userMode ? ' Make sure this device and the ESP32 use the same Wi-Fi.' : <> Already on Wi-Fi but not listed? Try <strong>All waiting</strong>.</>}
            </p>
          ) : (
            <ul className="nearby-list" data-testid="nearby-list">
              {items.map((d) => (
                <li key={d.mac} className={d.mac === selectedMac ? 'selected' : ''} data-testid={`nearby-${d.mac.replace(/:/g, '').toLowerCase()}`}>
                  <Cpu size={16} className="c-info" aria-hidden="true" />
                  <div className="nearby-meta">
                    <strong className="mono">{d.suggested_node_id}</strong>
                    <span className="small dim mono">{d.mac} · {d.local_ip || '—'}{d.ssid ? ` · ${d.ssid}` : ''}</span>
                    <span className="small dim">
                      <Wifi size={11} aria-hidden="true" /> {d.rssi ?? '—'} dBm · fw {d.firmware || '?'} · seen {d.seconds_ago ?? 0}s ago
                      {!d.same_network ? ' · different network' : ''}
                    </span>
                  </div>
                  <button type="button" className={`btn btn-sm ${d.mac === selectedMac ? '' : 'btn-primary'}`} onClick={() => onPick(d.mac === selectedMac ? null : d)}
                    data-testid={`nearby-connect-${d.mac.replace(/:/g, '').toLowerCase()}`}>
                    {d.mac === selectedMac ? 'Selected' : 'Connect'}
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}

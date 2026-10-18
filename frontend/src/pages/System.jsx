import { useState } from 'react'
import { Database, Network, Radio, ScrollText, Server, Terminal } from 'lucide-react'
import SimulatorToggle from '../components/SimulatorToggle'
import { Badge, Banner, ErrorState, Loading } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useFetch, useLive, useToast } from '../lib/context'
import { fmtAgo, fmtDateTime } from '../lib/format'

const SAMPLE = `curl -X POST <API>/api/ingest \\
  -H "Content-Type: application/json" \\
  -H "X-Device-Key: <device key>" \\
  -d '{"node_id":"ESP32-07","location":"Ground floor - column C2","readings":{"strain":340.5,"vibration":0.62,"temperature":29.5},"battery":94,"rssi":-48}'`

export default function System() {
  const { isAdmin } = useAuth()
  const { push } = useToast()
  const { telemetry } = useLive()
  const { data, error, reload } = useFetch('/api/system/status', null, [telemetry?.simulator_enabled])
  const [mqttResult, setMqttResult] = useState(null)
  const [testing, setTesting] = useState(false)

  if (error) return <div className="panel"><ErrorState error={error} onRetry={reload} testid="system-error-state" /></div>
  if (!data) return <Loading label="Loading system status…" testid="system-loading-state" />

  const testMqtt = async () => {
    setTesting(true)
    try {
      const r = await api('/api/mqtt/test', { method: 'POST', body: {} })
      setMqttResult(r)
    } catch (e) {
      push({ kind: 'error', title: 'MQTT test failed', body: e.message })
    } finally {
      setTesting(false)
    }
  }

  const m = data.mqtt
  return (
    <>
      <div className="page-head">
        <div><h1 data-testid="page-title">System settings</h1><p>Data sources, connectivity and configuration health</p></div>
        <div className="page-actions"><SimulatorToggle /></div>
      </div>
      {data.database.in_memory ? (
        <Banner kind="warn" testid="system-in-memory-banner">Running on an in-memory database (MONGO_URL=mongomock://). Data is lost when the API restarts — point MONGO_URL at MongoDB for persistence.</Banner>
      ) : null}
      <div className="grid grid-3">
        <section className="panel" data-testid="system-database-card">
          <div className="panel-head"><h3><Database size={15} aria-hidden="true" /> Database</h3>
            <Badge value={data.database.connected ? 'nominal' : 'critical'} label={data.database.connected ? 'Connected' : 'Disconnected'} /></div>
          <div className="panel-body kv">
            <div><div className="k">Name</div><div className="v">{data.database.name}</div></div>
            <div><div className="k">Last reading</div><div className="v">{fmtAgo(data.last_reading_at)}</div></div>
          </div>
        </section>
        <section className="panel" data-testid="system-simulator-card">
          <div className="panel-head"><h3><Server size={15} aria-hidden="true" /> Simulated telemetry</h3>
            <Badge value={data.simulator.enabled ? 'nominal' : 'disabled'} label={data.simulator.enabled ? 'Running' : 'Paused'} testid="system-simulator-status" /></div>
          <div className="panel-body kv">
            <div><div className="k">Interval</div><div className="v">{data.simulator.interval_seconds}s</div></div>
            <div><div className="k">Last source</div><div className="v">{data.last_source || '—'}</div></div>
          </div>
        </section>
        <section className="panel" data-testid="system-mqtt-card">
          <div className="panel-head"><h3><Radio size={15} aria-hidden="true" /> MQTT</h3>
            <Badge value={!m.configured ? 'disabled' : m.connected ? 'nominal' : 'critical'} label={!m.configured ? 'Not configured' : m.connected ? 'Connected' : 'Disconnected'} testid="system-mqtt-status" /></div>
          <div className="panel-body stack">
            <div className="kv">
              <div><div className="k">Topic</div><div className="v">{m.topic}</div></div>
              <div><div className="k">Broker</div><div className="v">{m.broker || '—'}</div></div>
              <div><div className="k">Processed</div><div className="v">{m.messages_processed}</div></div>
              <div><div className="k">Rejected</div><div className="v">{m.messages_rejected}</div></div>
            </div>
            {m.message ? <p className="small muted">{m.message}</p> : null}
            {m.last_error ? <p className="small c-critical break">{m.last_error}</p> : null}
            {isAdmin ? (
              <button type="button" className="btn btn-sm" onClick={testMqtt} disabled={testing} data-testid="mqtt-test-button">
                <Network size={13} aria-hidden="true" /> {testing ? 'Testing…' : 'Test broker connection'}
              </button>
            ) : null}
            {mqttResult ? <p className={`small ${mqttResult.ok ? 'c-nominal' : 'c-critical'}`} data-testid="mqtt-test-result">{mqttResult.message}</p> : null}
          </div>
        </section>
      </div>

      <section className="panel" data-testid="system-http-ingest-card">
        <div className="panel-head"><h2><Terminal size={15} aria-hidden="true" /> ESP32 HTTP ingestion</h2>
          <Badge value={data.http_ingest.device_auth_configured ? 'nominal' : 'warning'} label={data.http_ingest.device_auth_configured ? 'Device auth configured' : 'Device auth not configured'} /></div>
        <div className="panel-body stack">
          <p className="small muted">Devices POST JSON to <span className="mono">{data.http_ingest.endpoint}</span> with the <span className="mono">{data.http_ingest.header}</span> header. The same payload is accepted on MQTT topic <span className="mono">shm/&lt;node_id&gt;/telemetry</span>.</p>
          <pre className="mono small" style={{ margin: 0, padding: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{SAMPLE}</pre>
        </div>
      </section>

      {isAdmin && data.integrations ? (
        <div className="grid grid-2">
          <section className="panel" data-testid="system-integrations-card">
            <div className="panel-head"><h2>Configuration check</h2></div>
            <table className="data responsive">
              <tbody>
                {Object.entries(data.integrations).map(([k, v]) => (
                  <tr key={k}><td data-label="Integration">{k.replace(/_/g, ' ')}</td>
                    <td data-label="Status"><Badge value={v ? 'nominal' : 'disabled'} label={v ? 'Configured' : 'Not configured'} testid={`system-integration-${k}`} /></td></tr>
                ))}
              </tbody>
            </table>
            <p className="xs dim" style={{ padding: '0 14px 12px' }}>Secrets are read from server environment variables and are never sent to the browser.</p>
          </section>
          <section className="panel" data-testid="system-audit-card">
            <div className="panel-head"><h2><ScrollText size={15} aria-hidden="true" /> Audit log</h2></div>
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className="data responsive">
                <tbody>
                  {data.recent_audit.map((a) => (
                    <tr key={a.id}>
                      <td data-label="When" className="num">{fmtDateTime(a.created_at)}</td>
                      <td data-label="Who" className="mono small break">{a.actor_email}</td>
                      <td data-label="Action">{a.action.replace(/_/g, ' ')} <span className="dim">{a.target}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

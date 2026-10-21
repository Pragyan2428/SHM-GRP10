// "Connect your ESP32": the account's personal device key and what to put in the sketch.
// Nodes that send this key belong to this account, and they are the only nodes its
// dashboard and building map show.
import { useEffect, useState } from 'react'
import { Copy, Cpu, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/context'

// A node ID nobody else is likely to use: the start of the email plus a number.
function suggestId(user, count) {
  const base = (user?.email || '').split('@')[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'NODE'
  return `${base}-${String(count + 1).padStart(2, '0')}`
}

function CodeBlock({ text, shown, label, onCopy, testid }) {
  return (
    <div className="ud-code" data-testid={testid}>
      <pre>{shown ?? text}</pre>
      <button type="button" className="ud-code-copy" onClick={() => onCopy(text, label)} aria-label={`Copy ${label}`}>
        <Copy size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

export default function ConnectDevice({ user, open }) {
  const { push } = useToast()
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('/api/profile/device').then(setInfo).catch((e) => setError(e.message))
  }, [])

  const url = `${window.location.origin}/api/ingest`
  const key = info?.device_key || ''
  const masked = key ? `${key.slice(0, 4)}${'•'.repeat(16)}${key.slice(-4)}` : '…'
  const nodeId = suggestId(user, info?.nodes?.length || 0)
  const secrets = (k) => `#define API_URL     "${url}"\n#define DEVICE_KEY  "${k}"`
  const sketch = `const char* NODE_ID  = "${nodeId}";   // unique name for this ESP32\nconst char* LOCATION = "Ground floor - column C2";  // start with the floor`
  const dummy = (k) => `python tools/dummy_esp32.py --url ${url} --key ${k} --node ${nodeId} --location "Ground floor - test bench"`

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text)
      push({ kind: 'success', title: `${what} copied` })
    } catch {
      push({ kind: 'error', title: 'Could not copy automatically', body: 'Show the key, then select the text and copy it.' })
    }
  }
  const rotate = async () => {
    if (!window.confirm('Make a new device key? ESP32s that use the old key are refused until you update them.')) return
    setBusy(true)
    try {
      setInfo(await api('/api/profile/device/rotate', { method: 'POST' }))
      setReveal(true)
      push({ kind: 'success', title: 'New device key made', body: 'Put it in secrets.h and upload the sketch again.' })
    } catch (e) {
      push({ kind: 'error', title: 'Could not make a new key', body: e.message })
    } finally {
      setBusy(false)
    }
  }

  const body = (
    <div className="ud-connect-body">
      <p className="ud-sub">
        Your dashboard shows only the ESP32 nodes that send data with <strong>your device key</strong>. As soon as one reports,
        it appears here and on the building map, on the floor named at the start of its location.
      </p>
      {error ? <p className="ud-connect-error" role="alert">Could not load your device key: {error}</p> : null}

      <div className="ud-connect-key">
        <span className="ud-connect-k">Your device key</span>
        <code data-testid="device-key">{reveal ? key : masked}</code>
        <button type="button" className="ud-pill" onClick={() => setReveal((r) => !r)} disabled={!key} data-testid="device-key-toggle">
          {reveal ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />} {reveal ? 'Hide' : 'Show'}
        </button>
        <button type="button" className="ud-pill" onClick={() => copy(key, 'Device key')} disabled={!key} data-testid="device-key-copy">
          <Copy size={13} aria-hidden="true" /> Copy
        </button>
        <button type="button" className="ud-pill" onClick={rotate} disabled={!key || busy} data-testid="device-key-rotate">
          <RefreshCw size={13} aria-hidden="true" /> New key
        </button>
      </div>

      <ol className="ud-connect-steps">
        <li>
          In <span className="mono">tools/esp32_shm_node/secrets.h</span>:
          <CodeBlock text={secrets(key)} shown={secrets(reveal ? key : masked)} label="secrets.h lines" onCopy={copy} testid="device-secrets" />
        </li>
        <li>
          In the sketch, give the node a unique name and say where it is:
          <CodeBlock text={sketch} label="Sketch lines" onCopy={copy} testid="device-sketch" />
        </li>
        <li>Upload the sketch. The node shows up here within a few seconds of its first reading.</li>
      </ol>

      <div className="ud-connect-dummy">
        <span className="ud-connect-k">No hardware yet? Send test readings from your PC:</span>
        <CodeBlock text={dummy(key)} shown={dummy(reveal ? key : masked)} label="Command" onCopy={copy} testid="device-dummy" />
      </div>

      {info?.nodes?.length ? (
        <p className="ud-sub" data-testid="device-nodes">Your nodes: <span className="mono">{info.nodes.join(', ')}</span></p>
      ) : null}
    </div>
  )

  if (open) {
    return (
      <section className="ud-card ud-connect" aria-labelledby="ud-connect-title" data-testid="connect-device">
        <div className="ud-card-head"><h2 id="ud-connect-title"><Cpu size={17} aria-hidden="true" /> Connect your ESP32</h2></div>
        {body}
      </section>
    )
  }
  return (
    <details className="ud-card ud-connect" data-testid="connect-device">
      <summary><Cpu size={16} aria-hidden="true" /> Connect another ESP32</summary>
      {body}
    </details>
  )
}

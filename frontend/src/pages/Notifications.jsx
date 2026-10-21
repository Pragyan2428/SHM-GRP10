import { useEffect, useState } from 'react'
import { Bell, Bot, Mail, MessageCircle, MessageSquare, Monitor, Plus, Save, Search, Send } from 'lucide-react'
import { Badge, Banner, EmptyState, ErrorState, Loading, PermissionDenied, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useFetch, useLive, useToast } from '../lib/context'
import { fmtDateTime } from '../lib/format'

function IntegrationCard({ icon: Icon, title, configured, provider, message, testid, children }) {
  return (
    <section className="panel" data-testid={testid}>
      <div className="panel-head">
        <h3><Icon size={15} aria-hidden="true" /> {title}</h3>
        <Badge value={configured ? 'nominal' : 'disabled'} label={configured ? `Configured${provider ? ` · ${provider}` : ''}` : 'Not configured'}
          testid={`${testid}-status`} />
      </div>
      <div className="panel-body stack">
        {message ? <p className="small muted">{message}</p> : null}
        {children}
      </div>
    </section>
  )
}

export default function Notifications() {
  const { isAdmin } = useAuth()
  const { push } = useToast()
  const { permission, requestPermission } = useLive()
  const { data, error, reload } = useFetch('/api/notifications/status', null, [isAdmin])
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [testing, setTesting] = useState('')
  const [chats, setChats] = useState(null)
  const [finding, setFinding] = useState(false)

  useEffect(() => {
    if (data?.settings && isAdmin) {
      const s = data.settings
      setForm({
        ...s,
        whatsapp_enabled: s.whatsapp_enabled !== false,
        telegram_enabled: s.telegram_enabled !== false,
        telegram_recipients: (s.telegram_recipients || []).join('\n'),
        email_recipients: (s.email_recipients || []).join('\n'),
        sms_recipients: (s.sms_recipients || []).join('\n'),
        whatsapp_recipients: (s.whatsapp_recipients || []).join('\n'),
      })
    }
  }, [data, isAdmin])

  if (!isAdmin) return <><div className="page-head"><h1 data-testid="page-title">Notifications</h1></div><PermissionDenied what="notification settings" /></>
  if (error) return <div className="panel"><ErrorState error={error} onRetry={reload} testid="notifications-error-state" /></div>
  if (!data || !form) return <Loading label="Loading notification settings…" testid="notifications-loading-state" />

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const lines = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

  const save = async () => {
    setSaving(true)
    setFormError('')
    try {
      await api('/api/notifications/settings', {
        method: 'PUT',
        body: {
          browser_enabled: form.browser_enabled, email_enabled: form.email_enabled, sms_enabled: form.sms_enabled,
          whatsapp_enabled: form.whatsapp_enabled, telegram_enabled: form.telegram_enabled,
          email_recipients: lines(form.email_recipients), sms_recipients: lines(form.sms_recipients),
          whatsapp_recipients: lines(form.whatsapp_recipients), telegram_recipients: lines(form.telegram_recipients),
          min_severity: form.min_severity, cooldown_seconds: Number(form.cooldown_seconds) || 0,
        },
      })
      push({ kind: 'success', title: 'Notification settings saved', testid: 'notifications-save-success-toast' })
      reload()
    } catch (e) {
      setFormError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const test = async (channel) => {
    setTesting(channel)
    try {
      const r = await api('/api/notifications/test', { method: 'POST', body: { channel } })
      push({ kind: r.ok ? 'success' : 'error', title: r.ok ? `Test ${channel} sent` : `Test ${channel} not sent`, body: r.message, testid: `notifications-test-${channel}-toast` })
      reload()
    } catch (e) {
      push({ kind: 'error', title: `Test ${channel} failed`, body: e.message })
    } finally {
      setTesting('')
    }
  }

  const findChats = async () => {
    setFinding(true)
    try {
      setChats(await api('/api/notifications/telegram/chats', { method: 'POST' }))
    } catch (e) {
      setChats({ ok: false, chats: [], message: e.message })
    } finally {
      setFinding(false)
    }
  }
  const addChat = (id) => setForm((f) => {
    const have = lines(f.telegram_recipients)
    return have.includes(id) ? f : { ...f, telegram_recipients: [...have, id].join('\n') }
  })

  const testBrowser = async () => {
    let p = permission
    if (p !== 'granted') p = await requestPermission()
    if (p === 'granted') {
      try {
        // eslint-disable-next-line no-new
        new Notification('SHM test notification', { body: 'Browser alerts are working on this device.' })
        push({ kind: 'success', title: 'Browser notification sent', testid: 'notifications-test-browser-toast' })
      } catch {
        push({ kind: 'error', title: 'This browser blocked the notification' })
      }
    } else {
      push({ kind: 'error', title: 'Browser notifications not allowed', body: p === 'denied' ? 'Permission was denied. Re-enable it in the browser site settings.' : 'Notifications are not supported here.', testid: 'notifications-test-browser-toast' })
    }
  }

  const p = data.providers
  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Notifications</h1>
          <p>Delivery channels for threshold alerts. Failures are logged and never interrupt telemetry.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving} data-testid="notifications-save-button">
            <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
      {formError ? <Banner kind="offline" testid="notifications-form-error">{formError}</Banner> : null}

      <div className="grid grid-2">
        <IntegrationCard icon={Monitor} title="Browser" configured={permission === 'granted'} testid="integration-browser"
          message={permission === 'granted' ? 'This browser will show desktop alerts while the dashboard is open.'
            : permission === 'denied' ? 'Blocked in this browser — re-enable notifications in the site settings.'
              : permission === 'unsupported' ? 'This browser does not support notifications.' : 'Permission has not been requested yet.'}>
          <Toggle id="browser-enabled" checked={form.browser_enabled} onChange={set('browser_enabled')} label="Browser notifications" testid="notifications-browser-toggle" />
          <div className="row">
            {permission !== 'granted' && permission !== 'unsupported' ? (
              <button type="button" className="btn btn-sm" onClick={requestPermission} data-testid="browser-permission-request-button">
                <Bell size={13} aria-hidden="true" /> Request permission
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={testBrowser} data-testid="notifications-test-browser-button"><Send size={13} aria-hidden="true" /> Test</button>
          </div>
        </IntegrationCard>
        <IntegrationCard icon={Mail} title="Email" configured={p.email.configured} provider={p.email.provider} message={p.email.message || `Sender: ${p.email.from}`} testid="integration-email">
          <Toggle id="email-enabled" checked={form.email_enabled} onChange={set('email_enabled')} label="Email notifications" testid="notifications-email-toggle" />
          <button type="button" className="btn btn-sm" onClick={() => test('email')} disabled={!!testing} data-testid="notifications-test-email-button">
            <Send size={13} aria-hidden="true" /> {testing === 'email' ? 'Sending…' : 'Send test email'}
          </button>
        </IntegrationCard>
        <IntegrationCard icon={MessageSquare} title="SMS" configured={p.sms.configured} provider={p.sms.provider} message={p.sms.message} testid="integration-sms">
          <Toggle id="sms-enabled" checked={form.sms_enabled} onChange={set('sms_enabled')} label="SMS notifications" testid="notifications-sms-toggle" />
          <button type="button" className="btn btn-sm" onClick={() => test('sms')} disabled={!!testing} data-testid="notifications-test-sms-button">
            <Send size={13} aria-hidden="true" /> {testing === 'sms' ? 'Sending…' : 'Send test SMS'}
          </button>
        </IntegrationCard>
        <IntegrationCard icon={MessageCircle} title="WhatsApp" configured={p.whatsapp.configured} provider={p.whatsapp.provider}
          message={p.whatsapp.message || `Sender: ${p.whatsapp.from}. Each recipient must first message this number (Twilio sandbox: send the "join" code).`}
          testid="integration-whatsapp">
          <Toggle id="whatsapp-enabled" checked={form.whatsapp_enabled} onChange={set('whatsapp_enabled')} label="WhatsApp notifications" testid="notifications-whatsapp-toggle" />
          <button type="button" className="btn btn-sm" onClick={() => test('whatsapp')} disabled={!!testing} data-testid="notifications-test-whatsapp-button">
            <Send size={13} aria-hidden="true" /> {testing === 'whatsapp' ? 'Sending…' : 'Send test WhatsApp'}
          </button>
        </IntegrationCard>
        <IntegrationCard icon={Bot} title="Telegram" configured={p.telegram.configured} provider={p.telegram.provider}
          message={p.telegram.message || 'Open your bot in Telegram and press Start, then click Find my chat to add yourself. Save, then send a test.'}
          testid="integration-telegram">
          <Toggle id="telegram-enabled" checked={form.telegram_enabled} onChange={set('telegram_enabled')} label="Telegram notifications" testid="notifications-telegram-toggle" />
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={findChats} disabled={!p.telegram.configured || finding} data-testid="notifications-telegram-find-button">
              <Search size={13} aria-hidden="true" /> {finding ? 'Looking…' : 'Find my chat'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => test('telegram')} disabled={!!testing} data-testid="notifications-test-telegram-button">
              <Send size={13} aria-hidden="true" /> {testing === 'telegram' ? 'Sending…' : 'Send test Telegram'}
            </button>
          </div>
          {chats ? (
            <div className="stack" data-testid="notifications-telegram-chats">
              <p className="small muted">{chats.message}</p>
              {chats.chats.map((c) => (
                <div key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="small">{c.name}{c.username ? <span className="dim"> @{c.username}</span> : null} <span className="mono dim">{c.id}</span></span>
                  <button type="button" className="btn btn-sm" onClick={() => addChat(c.id)} data-testid={`notifications-telegram-add-${c.id}`}>
                    <Plus size={13} aria-hidden="true" /> Add
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </IntegrationCard>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Recipients & rules</h2></div>
        <div className="panel-body grid grid-2">
          <label className="field"><span className="field-label">Email recipients (one per line)</span>
            <textarea rows={4} className="mono" value={form.email_recipients} onChange={(e) => set('email_recipients')(e.target.value)}
              placeholder="ops@example.com" data-testid="notifications-email-recipients-input" />
          </label>
          <label className="field"><span className="field-label">SMS recipients (E.164, one per line)</span>
            <textarea rows={4} className="mono" value={form.sms_recipients} onChange={(e) => set('sms_recipients')(e.target.value)}
              placeholder="+15551234567" data-testid="notifications-sms-recipients-input" />
          </label>
          <label className="field"><span className="field-label">WhatsApp recipients (with country code, one per line)</span>
            <textarea rows={4} className="mono" value={form.whatsapp_recipients} onChange={(e) => set('whatsapp_recipients')(e.target.value)}
              placeholder="+919876543210" data-testid="notifications-whatsapp-recipients-input" />
          </label>
          <label className="field"><span className="field-label">Telegram chat IDs (one per line)</span>
            <textarea rows={4} className="mono" value={form.telegram_recipients} onChange={(e) => set('telegram_recipients')(e.target.value)}
              placeholder="123456789" data-testid="notifications-telegram-recipients-input" />
          </label>
          <label className="field"><span className="field-label">Minimum severity to send</span>
            <select value={form.min_severity} onChange={(e) => set('min_severity')(e.target.value)} data-testid="notifications-severity-filter">
              <option value="early_warning">Early warnings and above</option>
              <option value="major">Major and critical breaches</option>
              <option value="critical">Critical breaches only</option>
            </select>
          </label>
          <label className="field"><span className="field-label">Alert cooldown (seconds, per node + parameter)</span>
            <input type="number" min="0" className="mono" value={form.cooldown_seconds} onChange={(e) => set('cooldown_seconds')(e.target.value)}
              data-testid="notifications-cooldown-input" />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Delivery log</h2>
          <div className="row">
            {Object.entries(data.delivery_counts).map(([k, v]) => <Badge key={k} value={k} label={`${k} ${v}`} testid={`notifications-count-${k}`} />)}
          </div>
        </div>
        {data.recent_logs.length === 0 ? <EmptyState title="No deliveries yet" message="Attempts appear here when alerts are sent or tests run." testid="notifications-log-empty" /> : (
          <table className="data responsive" data-testid="notifications-log-table">
            <thead><tr><th>Time</th><th>Channel</th><th>Alert</th><th>Recipients</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {data.recent_logs.map((l) => (
                <tr key={l.id}>
                  <td data-label="Time" className="num">{fmtDateTime(l.created_at)}</td>
                  <td data-label="Channel">{l.channel}{l.provider ? <span className="dim"> · {l.provider}</span> : null}</td>
                  <td data-label="Alert" className="mono">{l.test ? 'TEST' : l.alert_id}</td>
                  <td data-label="Recipients" className="mono small break">{(l.recipients || []).join(', ') || '—'}</td>
                  <td data-label="Status"><Badge value={l.status} /></td>
                  <td data-label="Detail" className={`small ${l.status === 'failed' ? 'c-critical' : 'muted'}`}>{l.error || l.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

import { useEffect, useState } from 'react'
import { Code2, Copy, ExternalLink, FileSpreadsheet, Link2, PlugZap, RefreshCw } from 'lucide-react'
import { Badge, Banner, ErrorState, Loading, PermissionDenied, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useFetch, useToast } from '../lib/context'
import { fmtAgo, fmtDateTime } from '../lib/format'

export default function GoogleSheets() {
  const { isAdmin } = useAuth()
  const { push } = useToast()
  const { data, error, reload } = useFetch('/api/google-sheets/status')
  const [sheet, setSheet] = useState('')
  const [busy, setBusy] = useState('')
  const [formError, setFormError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => { if (data) setSheet(data.spreadsheet_id || '') }, [data])

  if (!isAdmin) return <><div className="page-head"><h1 data-testid="page-title">Google Sheets</h1></div><PermissionDenied what="Google Sheets synchronisation" /></>
  if (error) return <div className="panel"><ErrorState error={error} onRetry={reload} testid="sheets-error-state" /></div>
  if (!data) return <Loading label="Loading integration…" testid="sheets-loading-state" />

  const connect = async (extra = {}) => {
    setBusy('connect')
    setFormError('')
    try {
      await api('/api/google-sheets/settings', { method: 'PUT', body: { spreadsheet: sheet, ...extra } })
      push({ kind: 'success', title: sheet ? 'Spreadsheet connected' : 'Spreadsheet disconnected', testid: 'sheets-connect-success-toast' })
      reload()
    } catch (e) {
      setFormError(e.message)
    } finally {
      setBusy('')
    }
  }
  const setAuto = async (v) => {
    try {
      await api('/api/google-sheets/settings', { method: 'PUT', body: { auto_sync: v } })
      reload()
    } catch (e) { push({ kind: 'error', title: 'Could not update', body: e.message }) }
  }
  const testConnection = async () => {
    setBusy('test')
    try {
      const r = await api('/api/google-sheets/test', { method: 'POST' })
      setResult(r)
      reload()
    } catch (e) {
      setResult({ ok: false, message: e.message })
    } finally {
      setBusy('')
    }
  }
  const sync = async () => {
    setBusy('sync')
    try {
      const r = await api('/api/google-sheets/sync', { method: 'POST' })
      setResult(r)
      push({ kind: r.ok ? 'success' : 'error', title: r.ok ? 'Sync complete' : 'Sync failed', body: r.message, testid: 'sheets-sync-toast' })
      reload()
    } catch (e) {
      setResult({ ok: false, message: e.message })
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Google Sheets</h1>
          <p>Every alert gets one row in a shared spreadsheet, kept up to date when it is acknowledged, escalated or resolved.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={sync} disabled={!data.connected || busy === 'sync'} data-testid="google-sheets-sync-button">
            <RefreshCw size={14} aria-hidden="true" className={busy === 'sync' ? 'spin' : ''} /> {busy === 'sync' ? 'Syncing…' : 'Sync to Google Sheets'}
          </button>
        </div>
      </div>

      {!data.configured ? (
        <Banner kind="warn" testid="sheets-not-configured-banner">
          {data.message}. Alerts are still stored and can be exported as CSV.
        </Banner>
      ) : null}
      {data.script_outdated ? (
        <Banner kind="warn" testid="sheets-script-outdated-banner">
          <strong>Update your Apps Script.</strong> It is an older version that cannot update rows. Click <strong>Copy script</strong> below,
          paste it over the old code and save, then choose <strong>Deploy → Manage deployments → Edit → Version: New version → Deploy</strong>.
        </Banner>
      ) : null}
      {data.last_error ? (
        <Banner kind="offline" testid="sheets-last-error-banner">
          <strong>Last sync failed</strong> {fmtAgo(data.last_error_at)}: <span className="break">{data.last_error}</span>
        </Banner>
      ) : null}
      {result ? <Banner kind={result.ok ? 'ok' : 'offline'} testid="sheets-sync-result">{result.message}</Banner> : null}

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2><FileSpreadsheet size={15} aria-hidden="true" /> Connection</h2>
            <Badge value={data.connected ? 'nominal' : 'disabled'} label={data.connected ? 'Connected' : data.configured ? 'No spreadsheet' : 'Not configured'} testid="sheets-connection-status" />
          </div>
          {data.mode === 'apps_script' ? (
            <div className="panel-body stack" data-testid="sheets-apps-script-mode">
              <p className="small">Connected through your <strong>Apps Script web app</strong>, so no Google Cloud key is needed.</p>
              {data.spreadsheet_name ? <p className="small muted">Spreadsheet: <strong>{data.spreadsheet_name}</strong></p> : null}
              <div className="row">
                <button type="button" className="btn" onClick={testConnection} disabled={busy === 'test'} data-testid="google-sheets-test-button">
                  <PlugZap size={14} aria-hidden="true" /> {busy === 'test' ? 'Testing…' : 'Test connection'}
                </button>
                {data.spreadsheet_url ? (
                  <a href={data.spreadsheet_url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost" data-testid="google-sheets-open-link">
                    Open sheet <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
              <Toggle id="sheets-auto" checked={data.auto_sync} onChange={setAuto} label="Append new alerts automatically" testid="google-sheets-auto-sync-toggle" />
            </div>
          ) : (
          <div className="panel-body stack">
            <label className="field"><span className="field-label">Spreadsheet URL or ID</span>
              <input value={sheet} onChange={(e) => setSheet(e.target.value)} className="mono" disabled={!data.configured}
                placeholder="https://docs.google.com/spreadsheets/d/…" data-testid="google-sheets-spreadsheet-input" aria-invalid={!!formError} />
              {formError ? <span className="field-error" data-testid="sheets-form-error">{formError}</span> : null}
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={() => connect()} disabled={!data.configured || busy === 'connect'} data-testid="google-sheets-connect-button">
                <Link2 size={14} aria-hidden="true" /> {busy === 'connect' ? 'Saving…' : 'Connect sheet'}
              </button>
              {data.spreadsheet_url ? (
                <a href={data.spreadsheet_url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost" data-testid="google-sheets-open-link">
                  Open sheet <ExternalLink size={13} aria-hidden="true" />
                </a>
              ) : null}
            </div>
            <Toggle id="sheets-auto" checked={data.auto_sync} disabled={!data.connected} onChange={setAuto}
              label="Append new alerts automatically" testid="google-sheets-auto-sync-toggle" />
            {data.service_account_email ? (
              <p className="small muted">Share the spreadsheet with <span className="mono c-info break" data-testid="sheets-service-account">{data.service_account_email}</span> (Editor).</p>
            ) : null}
          </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Sync status</h2></div>
          <div className="panel-body kv">
            <div><div className="k">Last successful sync</div><div className="v" data-testid="sheets-last-success">{data.last_success_at ? fmtDateTime(data.last_success_at) : 'Never'}</div></div>
            <div><div className="k">Rows in last sync</div><div className="v">{data.last_synced_count ?? '—'}</div></div>
            <div><div className="k">Rows awaiting sync</div><div className="v" data-testid="sheets-pending-rows">{data.pending_rows}</div></div>
            <div><div className="k">Worksheet</div><div className="v">{data.worksheet}</div></div>
          </div>
          <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="field-label dim" style={{ marginBottom: 6 }}>Columns</div>
            <div className="row" style={{ gap: 4 }}>{data.columns.map((c) => <span key={c} className="badge b-disabled">{c}</span>)}</div>
          </div>
        </section>
      </div>

      {data.mode !== 'service_account' ? <AppsScriptGuide connected={data.mode === 'apps_script'} /> : null}
    </>
  )
}

// Step-by-step setup for the no-key method, with the script ready to copy.
function AppsScriptGuide({ connected }) {
  const { push } = useToast()
  const [code, setCode] = useState('')
  const [show, setShow] = useState(false)
  useEffect(() => {
    api('/api/google-sheets/apps-script').then((d) => setCode(d.code)).catch(() => setCode(''))
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      push({ kind: 'success', title: 'Script copied', body: 'Paste it into your Apps Script project.', testid: 'sheets-script-copied-toast' })
    } catch {
      setShow(true)
      push({ kind: 'error', title: 'Could not copy automatically', body: 'Select the code below and copy it.' })
    }
  }
  return (
    <section className="panel" data-testid="sheets-apps-script-guide">
      <div className="panel-head">
        <h2><Code2 size={15} aria-hidden="true" /> {connected ? 'Apps Script setup' : 'Connect without a key: Google Apps Script'}</h2>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => setShow((s) => !s)} disabled={!code} data-testid="sheets-script-toggle">{show ? 'Hide code' : 'Show code'}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={copy} disabled={!code} data-testid="sheets-script-copy"><Copy size={13} aria-hidden="true" /> Copy script</button>
        </div>
      </div>
      <ol className="sheets-steps">
        <li>Create a Google Sheet for the alerts. Then open <strong>Extensions → Apps Script</strong> in it, <em>or</em> in Google Drive choose <strong>New → More → Google Apps Script</strong>.</li>
        <li>Delete the sample code, paste the script (<strong>Copy script</strong> above) and click <strong>Save</strong>.</li>
        <li>Open <strong>Project Settings</strong> (gear icon) → <strong>Script properties</strong> and add <span className="mono">SHM_SECRET</span> with the value of <span className="mono">GOOGLE_SHEETS_WEBHOOK_SECRET</span> from <span className="mono">backend/.env</span>. If you made the script from Drive, also add <span className="mono">SPREADSHEET_ID</span> with the sheet's link.</li>
        <li>Click <strong>Deploy → New deployment → Web app</strong>, set <em>Execute as: Me</em> and <em>Who has access: Anyone</em>, deploy and allow the permissions.</li>
        <li>Copy the <strong>Web app URL</strong> (ends in <span className="mono">/exec</span>) into <span className="mono">GOOGLE_SHEETS_WEBHOOK_URL</span> in <span className="mono">backend/.env</span> and restart the API. Then use <strong>Test connection</strong> on this page.</li>
      </ol>
      <p className="small muted sheets-note">Updating a script you already deployed? Paste the new code over it and save, then use <strong>Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy</strong>. The web app URL stays the same.</p>
      {show ? <pre className="sheets-code" data-testid="sheets-script-code">{code}</pre> : null}
    </section>
  )
}

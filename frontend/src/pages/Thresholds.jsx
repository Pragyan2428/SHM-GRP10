import { useEffect, useState } from 'react'
import { History, Lock, RotateCcw, Save } from 'lucide-react'
import { PARAM_ICON } from '../components/monitoring'
import { Banner, EmptyState, ErrorState, Loading, Toggle } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useFetch, useToast } from '../lib/context'
import { PARAM_SHORT, fmtDateTime } from '../lib/format'

const FIELDS = [
  ['warning_threshold', 'Warning', 'Amber status above this value'],
  ['safe_threshold', 'Safe limit', 'Threshold alert when reached'],
  ['critical_threshold', 'Critical', 'Alert escalates to critical'],
  ['debounce_seconds', 'Debounce (s)', 'Breach must persist this long'],
  ['cooldown_seconds', 'Cooldown (s)', 'Minimum gap between alerts'],
]

function validate(row) {
  const errs = {}
  FIELDS.forEach(([k]) => {
    const v = row[k]
    if (v === '' || v === null || Number.isNaN(Number(v))) errs[k] = 'Required'
    else if (Number(v) < 0) errs[k] = 'Must be ≥ 0'
  })
  if (!errs.warning_threshold && !errs.safe_threshold && Number(row.warning_threshold) >= Number(row.safe_threshold)) errs.warning_threshold = 'Must be below safe limit'
  if (!errs.critical_threshold && !errs.safe_threshold && Number(row.critical_threshold) <= Number(row.safe_threshold)) errs.critical_threshold = 'Must be above safe limit'
  return errs
}

export default function Thresholds() {
  const { isAdmin } = useAuth()
  const { push } = useToast()
  const { data, error, reload } = useFetch('/api/thresholds')
  const audit = useFetch('/api/thresholds/audit', { limit: 20 })
  const [rows, setRows] = useState(null)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState('')

  useEffect(() => { if (data) setRows(data.items.map((x) => ({ ...x }))) }, [data])

  if (error) return <div className="panel"><ErrorState error={error} onRetry={reload} testid="thresholds-error-state" /></div>
  if (!rows) return <Loading label="Loading thresholds…" testid="thresholds-loading-state" />

  const errors = Object.fromEntries(rows.map((r) => [r.parameter, validate(r)]))
  const hasErrors = Object.values(errors).some((e) => Object.keys(e).length)
  const dirty = rows.filter((r) => {
    const o = data.items.find((x) => x.parameter === r.parameter)
    return FIELDS.some(([k]) => Number(o[k]) !== Number(r[k])) || o.enabled !== r.enabled
  })
  const update = (param, key, value) => setRows((rs) => rs.map((r) => (r.parameter === param ? { ...r, [key]: value } : r)))

  const save = async () => {
    setSaving(true)
    setServerError('')
    try {
      const body = {
        thresholds: dirty.map((r) => ({
          parameter: r.parameter,
          safe_threshold: Number(r.safe_threshold), warning_threshold: Number(r.warning_threshold),
          critical_threshold: Number(r.critical_threshold), debounce_seconds: Math.round(Number(r.debounce_seconds)),
          cooldown_seconds: Math.round(Number(r.cooldown_seconds)), enabled: r.enabled,
        })),
      }
      const res = await api('/api/thresholds', { method: 'PUT', body })
      push({ kind: 'success', title: 'Thresholds saved', body: `${res.changed.length} parameter(s) updated. New readings use the new limits.`, testid: 'thresholds-save-success-toast' })
      reload()
      audit.reload()
    } catch (e) {
      setServerError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="page-title">Threshold settings</h1>
          <p>Limits applied to every incoming reading (simulated, HTTP and MQTT)</p>
        </div>
        {isAdmin ? (
          <div className="page-actions">
            <button type="button" className="btn" disabled={!dirty.length || saving} onClick={() => setRows(data.items.map((x) => ({ ...x })))}
              data-testid="thresholds-reset-button"><RotateCcw size={14} aria-hidden="true" /> Discard</button>
            <button type="button" className="btn btn-primary" disabled={!dirty.length || hasErrors || saving} onClick={save}
              data-testid="thresholds-save-button"><Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : `Save changes${dirty.length ? ` (${dirty.length})` : ''}`}</button>
          </div>
        ) : null}
      </div>
      {!isAdmin ? (
        <Banner kind="warn" testid="thresholds-readonly-banner"><Lock size={13} aria-hidden="true" /> Read-only: only administrators can change thresholds.</Banner>
      ) : null}
      {serverError ? <Banner kind="offline" testid="thresholds-server-error">{serverError}</Banner> : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
        {rows.map((r) => {
          const Icon = PARAM_ICON[r.parameter]
          const e = errors[r.parameter]
          return (
            <section key={r.parameter} className="panel" data-testid={`threshold-card-${r.parameter}`} aria-labelledby={`th-${r.parameter}`}>
              <div className="panel-head">
                <h2 id={`th-${r.parameter}`}><Icon size={15} aria-hidden="true" /> {r.label} <span className="dim mono small">({r.unit})</span></h2>
                <Toggle id={`enabled-${r.parameter}`} checked={r.enabled} disabled={!isAdmin} onChange={(v) => update(r.parameter, 'enabled', v)}
                  label={r.enabled ? 'Enabled' : 'Disabled'} testid={`threshold-${r.parameter}-enabled-toggle`} />
              </div>
              <div className="panel-body grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                {FIELDS.map(([k, label, hint]) => (
                  <label key={k} className="field" title={hint}>
                    <span className="field-label">{label}</span>
                    <input type="number" step="any" min="0" className={`mono ${e[k] ? 'input-error' : ''}`} value={r[k]} disabled={!isAdmin}
                      onChange={(ev) => update(r.parameter, k, ev.target.value)} aria-invalid={!!e[k]}
                      aria-describedby={e[k] ? `err-${r.parameter}-${k}` : undefined}
                      data-testid={`threshold-${r.parameter}-${k.replace(/_/g, '-')}-input`} />
                    {e[k] ? <span className="field-error" id={`err-${r.parameter}-${k}`}>{e[k]}</span> : <span className="xs dim">{hint}</span>}
                  </label>
                ))}
                <div className="xs dim" style={{ gridColumn: '1 / -1' }} data-testid={`threshold-${r.parameter}-updated-by`}>
                  Last changed by <span className="mono">{r.updated_by}</span> · {fmtDateTime(r.updated_at)}
                </div>
              </div>
            </section>
          )
        })}
      </div>

      <section className="panel" aria-labelledby="audit-title">
        <div className="panel-head"><h2 id="audit-title"><History size={15} aria-hidden="true" /> Change history</h2></div>
        {audit.error ? <ErrorState error={audit.error} testid="thresholds-audit-error" />
          : !audit.data ? <Loading rows={2} testid="thresholds-audit-loading" />
            : audit.data.items.length === 0 ? <EmptyState title="No changes yet" message="Default thresholds are in effect." testid="thresholds-audit-empty" />
              : (
                <table className="data responsive" data-testid="thresholds-audit-table">
                  <thead><tr><th>When</th><th>Who</th><th>Parameter</th><th>Changes</th></tr></thead>
                  <tbody>
                    {audit.data.items.map((a) => (
                      <tr key={a.id}>
                        <td data-label="When" className="num">{fmtDateTime(a.created_at)}</td>
                        <td data-label="Who" className="mono">{a.actor_email}</td>
                        <td data-label="Parameter">{PARAM_SHORT[a.target] || a.target}</td>
                        <td data-label="Changes" className="mono small">
                          {Object.entries(a.details).map(([k, v]) => <div key={k}>{k.replace(/_/g, ' ')}: {String(v.from)} → {String(v.to)}</div>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
      </section>
    </>
  )
}

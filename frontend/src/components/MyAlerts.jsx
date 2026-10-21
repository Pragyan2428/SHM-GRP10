// "My alerts": alerts for this account's own nodes, by email to its address and by Telegram,
// linked with one tap through a personal link to the site's bot (no chat IDs to copy).
import { useEffect, useRef, useState } from 'react'
import { BellRing, Mail, Send, Unlink } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/context'

function Switch({ checked, onChange, disabled, label, testid }) {
  return (
    <label className={`ud-switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span className="ud-switch-track" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </label>
  )
}

export default function MyAlerts() {
  const { push } = useToast()
  const [st, setSt] = useState(null)
  const [waiting, setWaiting] = useState(null) // the link while we wait for Start to be pressed
  const timer = useRef(null)

  useEffect(() => {
    api('/api/profile/alerts').then(setSt).catch(() => setSt(null))
    return () => clearInterval(timer.current)
  }, [])

  const save = async (body) => {
    try {
      setSt(await api('/api/profile/alerts', { method: 'PUT', body }))
    } catch (e) {
      push({ kind: 'error', title: 'Could not save', body: e.message })
    }
  }

  const connect = async () => {
    const tab = window.open('', '_blank') // opened now so the browser doesn't block it
    try {
      const { url } = await api('/api/profile/telegram/link', { method: 'POST' })
      if (tab) tab.location = url
      setWaiting(url)
      let tries = 0
      clearInterval(timer.current)
      timer.current = setInterval(async () => {
        tries += 1
        const next = await api('/api/profile/telegram/check', { method: 'POST' }).catch(() => null)
        if (next) setSt(next)
        if (next?.telegram.linked || tries > 60) {
          clearInterval(timer.current)
          setWaiting(null)
          if (next?.telegram.linked) push({ kind: 'success', title: 'Telegram connected', body: 'Alerts for your nodes will arrive in Telegram.', testid: 'telegram-linked-toast' })
        }
      }, 3000)
    } catch (e) {
      tab?.close()
      push({ kind: 'error', title: 'Could not open Telegram', body: e.message })
    }
  }

  const disconnect = async () => {
    try {
      setSt(await api('/api/profile/telegram', { method: 'DELETE' }))
    } catch (e) {
      push({ kind: 'error', title: 'Could not disconnect', body: e.message })
    }
  }

  if (!st) return null
  const { email, telegram } = st
  return (
    <section className="ud-card ud-alerts" aria-labelledby="ud-alerts-title" data-testid="my-alerts">
      <div className="ud-card-head"><h2 id="ud-alerts-title"><BellRing size={17} aria-hidden="true" /> My alerts</h2></div>
      <p className="ud-sub">When one of your nodes goes over its limit, you are told here and on:</p>

      <div className="ud-alert-row" data-testid="my-alerts-email">
        <span className="ud-alert-icon"><Mail size={16} aria-hidden="true" /></span>
        <span className="ud-alert-text">
          <strong>Email</strong>
          <span>{email.available ? email.address : 'Not set up on this site yet (ask the admin)'}</span>
        </span>
        <Switch checked={email.available && email.enabled} disabled={!email.available} onChange={(v) => save({ email_enabled: v })}
          label="Email alerts" testid="my-alerts-email-toggle" />
      </div>

      <div className="ud-alert-row" data-testid="my-alerts-telegram">
        <span className="ud-alert-icon"><Send size={16} aria-hidden="true" /></span>
        <span className="ud-alert-text">
          <strong>Telegram</strong>
          <span>
            {!telegram.available ? 'Not set up on this site yet (ask the admin)'
              : telegram.linked ? `Connected${telegram.name ? ` as ${telegram.name}` : ''}`
                : waiting ? 'Press Start in the Telegram chat that opened…' : 'Not connected'}
          </span>
        </span>
        {telegram.available && telegram.linked ? (
          <>
            <Switch checked={telegram.enabled} onChange={(v) => save({ telegram_enabled: v })} label="Telegram alerts" testid="my-alerts-telegram-toggle" />
            <button type="button" className="ud-pill" onClick={disconnect} data-testid="my-alerts-telegram-disconnect"><Unlink size={13} aria-hidden="true" /> Disconnect</button>
          </>
        ) : telegram.available ? (
          waiting
            ? <a className="ud-pill" href={waiting} target="_blank" rel="noopener noreferrer" data-testid="my-alerts-telegram-reopen">Open again</a>
            : <button type="button" className="ud-pill ud-pill-accent" onClick={connect} data-testid="my-alerts-telegram-connect">Connect Telegram</button>
        ) : null}
      </div>
    </section>
  )
}

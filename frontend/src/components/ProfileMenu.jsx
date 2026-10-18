// Round profile picture at the top right. Hovering it (or tapping / pressing Enter) opens a
// card with the user's details, their profile picture choices and everything they can do.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Camera, KeyRound, LogOut, Pencil, Trash2 } from 'lucide-react'
import { api, apiUrl } from '../lib/api'
import { useAuth } from '../lib/context'
import { fmtAgo, fmtDateTime } from '../lib/format'
import { Badge } from './ui'

const PRESETS = [1, 2, 3, 4]
const presetSrc = (n) => `${import.meta.env.BASE_URL}avatars/avatar-${n}.svg`
const MAX_UPLOAD = 8 * 1024 * 1024 // original file; it is shrunk to 256x256 before upload

export function avatarSrc(user) {
  const a = user?.avatar
  if (!a) return null
  const [kind, value] = a.split(':')
  if (kind === 'preset') return presetSrc(value)
  if (kind === 'upload') return apiUrl(`/api/profile/avatar?v=${value}`)
  return null
}

export function Avatar({ user, size = 36, testid }) {
  const src = avatarSrc(user)
  const initials = (user?.name || user?.email || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} data-testid={testid}>
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{initials}</span>}
    </span>
  )
}

// Square-crops and shrinks a photo in the browser, so uploads are small and quick.
async function toAvatarDataUrl(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That file could not be opened as an image.'))
      i.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256)
    return canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function ProfileMenu({ links = [], nameTestid, roleTestid, logoutTestid }) {
  const { user, logout, updateUser } = useAuth()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState(null) // { kind: 'ok' | 'error', text }
  const [busy, setBusy] = useState('')
  const [name, setName] = useState(user?.name || '')
  const [pwOpen, setPwOpen] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const wrapRef = useRef(null)
  const cardRef = useRef(null)
  const buttonRef = useRef(null)
  const fileRef = useRef(null)
  const closeTimer = useRef(null)

  useEffect(() => { setName(user?.name || '') }, [user?.name])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  if (!user) return null

  const show = () => { clearTimeout(closeTimer.current); setOpen(true) }
  const hideSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      // keep the card open while the user is typing in it
      const el = document.activeElement
      if (cardRef.current?.contains(el) && el.tagName === 'INPUT') return
      setOpen(false)
    }, 260)
  }

  const run = async (key, fn, okText) => {
    setBusy(key)
    setMsg(null)
    try {
      const d = await fn()
      if (d?.user) updateUser(d.user)
      if (okText) setMsg({ kind: 'ok', text: okText })
      return true
    } catch (e) {
      setMsg({ kind: 'error', text: e.message })
      return false
    } finally {
      setBusy('')
    }
  }

  const choosePreset = (n) => run(`preset${n}`, () => api('/api/profile/avatar', { method: 'PUT', body: { preset: n } }), 'Profile picture updated')
  const removePhoto = () => run('remove', () => api('/api/profile/avatar', { method: 'DELETE' }), 'Profile picture removed')
  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setMsg({ kind: 'error', text: 'Choose a PNG, JPEG or WebP picture.' }); return }
    if (file.size > MAX_UPLOAD) { setMsg({ kind: 'error', text: 'That picture is over 8 MB.' }); return }
    await run('upload', async () => api('/api/profile/avatar', { method: 'PUT', body: { image: await toAvatarDataUrl(file) } }), 'Photo uploaded')
  }
  const saveName = (e) => {
    e.preventDefault()
    if (!name.trim()) { setMsg({ kind: 'error', text: 'Name cannot be empty.' }); return }
    run('name', () => api('/api/profile', { method: 'PATCH', body: { name: name.trim() } }), 'Name saved')
  }
  const savePassword = async (e) => {
    e.preventDefault()
    if (pw.next.length < 10) { setMsg({ kind: 'error', text: 'New password must be at least 10 characters.' }); return }
    if (pw.next !== pw.confirm) { setMsg({ kind: 'error', text: 'New passwords do not match.' }); return }
    const ok = await run('password', () => api('/api/profile/password', { method: 'POST', body: { current_password: pw.current, new_password: pw.next } }), 'Password changed')
    if (ok) { setPw({ current: '', next: '', confirm: '' }); setPwOpen(false) }
  }

  const isAdmin = user.role === 'admin'
  const current = user.avatar || ''
  return (
    <div className="profile" ref={wrapRef} onMouseEnter={show} onMouseLeave={hideSoon}>
      <button type="button" ref={buttonRef} className="profile-trigger" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} data-testid="profile-button" aria-label={`Profile and settings for ${user.name || user.email}`}>
        {/* only the picture is shown; the name stays available to screen readers */}
        <span className="sr-only" data-testid={nameTestid}>{user.name || user.email}</span>
        <Avatar user={user} size={40} testid="profile-avatar" />
      </button>

      {open ? (
        <div className="profile-card" ref={cardRef} role="dialog" aria-label="Profile and settings" data-testid="profile-card">
          <div className="profile-head">
            <Avatar user={user} size={64} testid="profile-card-avatar" />
            <div style={{ minWidth: 0 }}>
              <div className="profile-card-name">{user.name || '—'}</div>
              <div className="small muted break" data-testid="profile-email">{user.email}</div>
              <Badge value={user.role} label={isAdmin ? 'Administrator' : 'Viewer'} testid={roleTestid} />
            </div>
          </div>
          <dl className="profile-facts">
            <div><dt>Member since</dt><dd>{user.created_at ? fmtDateTime(user.created_at).split(' ').slice(0, 3).join(' ') : '—'}</dd></div>
            <div><dt>Last login</dt><dd>{user.last_login_at ? fmtAgo(user.last_login_at) : '—'}</dd></div>
          </dl>

          <section className="profile-section" aria-label="Profile picture">
            <div className="profile-label">Profile picture</div>
            <div className="profile-presets">
              {PRESETS.map((n) => (
                <button key={n} type="button" className="preset" aria-pressed={current === `preset:${n}`} disabled={!!busy}
                  onClick={() => choosePreset(n)} aria-label={`Use avatar ${n}`} data-testid={`avatar-preset-${n}`}>
                  <img src={presetSrc(n)} alt="" />
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={!!busy} data-testid="avatar-upload-button">
                <Camera size={13} aria-hidden="true" /> {busy === 'upload' ? 'Uploading…' : 'Upload photo'}
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload} data-testid="avatar-upload-input" />
              {current ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={removePhoto} disabled={!!busy} data-testid="avatar-remove">
                  <Trash2 size={13} aria-hidden="true" /> Remove
                </button>
              ) : null}
            </div>
          </section>

          <section className="profile-section" aria-label="Settings">
            <div className="profile-label">Settings</div>
            <form className="profile-inline" onSubmit={saveName}>
              <label className="sr-only" htmlFor="profile-name">Display name</label>
              <Pencil size={13} className="dim" aria-hidden="true" />
              <input id="profile-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Display name"
                data-testid="profile-name-input" />
              <button type="submit" className="btn btn-sm" disabled={!!busy || name.trim() === (user.name || '')} data-testid="profile-name-save">Save</button>
            </form>
            <button type="button" className="profile-item" aria-expanded={pwOpen} onClick={() => setPwOpen((o) => !o)} data-testid="profile-password-toggle">
              <KeyRound size={14} aria-hidden="true" /> Change password
            </button>
            {pwOpen ? (
              <form className="profile-password" onSubmit={savePassword}>
                <input type="password" autoComplete="current-password" placeholder="Current password" value={pw.current}
                  onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} data-testid="profile-password-current" />
                <input type="password" autoComplete="new-password" placeholder="New password (10+ characters)" value={pw.next}
                  onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} data-testid="profile-password-new" />
                <input type="password" autoComplete="new-password" placeholder="Repeat new password" value={pw.confirm}
                  onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} data-testid="profile-password-confirm" />
                <button type="submit" className="btn btn-sm btn-primary" disabled={!!busy || !pw.current} data-testid="profile-password-save">
                  {busy === 'password' ? 'Saving…' : 'Update password'}
                </button>
              </form>
            ) : null}
          </section>

          {msg ? <div className={`profile-msg ${msg.kind}`} role="status" data-testid="profile-message">{msg.text}</div> : null}

          {links.length ? (
            <nav className="profile-section profile-links" aria-label="Go to">
              {links.map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} className="profile-item" onClick={() => setOpen(false)} data-testid={`profile-link-${to.replace(/\W+/g, '') || 'home'}`}>
                  {Icon ? <Icon size={14} aria-hidden="true" /> : null} {label}
                </Link>
              ))}
            </nav>
          ) : null}

          <button type="button" className="profile-item profile-logout" onClick={logout} data-testid={logoutTestid}>
            <LogOut size={14} aria-hidden="true" /> Log out
          </button>
        </div>
      ) : null}
    </div>
  )
}

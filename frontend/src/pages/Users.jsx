import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, KeyRound, Pencil, Trash2, UserPlus } from 'lucide-react'
import { Badge, Dialog, EmptyState, ErrorState, Loading, PermissionDenied } from '../components/ui'
import { api } from '../lib/api'
import { useAuth, useFetch, useToast } from '../lib/context'
import { fmtDateTime, slug } from '../lib/format'

function UserForm({ initial, onClose, onSaved }) {
  const editing = !!initial
  const [form, setForm] = useState({ email: initial?.email || '', name: initial?.name || '', role: initial?.role || 'viewer', password: '', active: initial?.active ?? true })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!editing && form.password.length < 10) { setError('Password must be at least 10 characters'); return }
    if (editing && form.password && form.password.length < 10) { setError('New password must be at least 10 characters'); return }
    setBusy(true)
    try {
      if (editing) {
        const body = { name: form.name, role: form.role, active: form.active }
        if (form.password) body.password = form.password
        await api(`/api/users/${initial.id}`, { method: 'PUT', body })
      } else {
        await api('/api/users', { method: 'POST', body: { email: form.email, name: form.name, role: form.role, password: form.password } })
      }
      onSaved(editing ? 'User updated' : 'User created')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={editing ? `Edit ${initial.email}` : 'Add user'} onClose={onClose} testid="user-form-dialog">
      <form onSubmit={submit} className="stack" noValidate>
        {!editing ? (
          <label className="field"><span className="field-label">Email</span>
            <input type="email" required autoComplete="off" value={form.email} onChange={set('email')} data-testid="user-form-email-input" />
          </label>
        ) : null}
        <label className="field"><span className="field-label">Name</span>
          <input required value={form.name} onChange={set('name')} data-testid="user-form-name-input" />
        </label>
        <label className="field"><span className="field-label">Role</span>
          <select value={form.role} onChange={set('role')} data-testid="user-form-role-select">
            <option value="viewer">Viewer — monitor only</option>
            <option value="admin">Administrator — full control</option>
          </select>
        </label>
        <label className="field"><span className="field-label">{editing ? 'New password (leave blank to keep)' : 'Password (min. 10 characters)'}</span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} data-testid="user-form-password-input" />
        </label>
        {editing ? (
          <label className="row small"><input type="checkbox" checked={form.active} onChange={set('active')} data-testid="user-form-active-checkbox" /> Account active</label>
        ) : null}
        {error ? <p className="field-error" role="alert" data-testid="user-form-error">{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} data-testid="user-form-cancel-button">Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="user-form-submit-button">{busy ? 'Saving…' : editing ? 'Save' : 'Create user'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export default function Users() {
  const { isAdmin, user: me } = useAuth()
  const { push } = useToast()
  const { data, error, reload } = useFetch(isAdmin ? '/api/users' : '/api/auth/me')
  const [editing, setEditing] = useState(undefined)
  const [confirm, setConfirm] = useState(null)

  if (!isAdmin) return <><div className="page-head"><h1 data-testid="page-title">Users</h1></div><PermissionDenied what="user management" /></>
  if (error) return <div className="panel"><ErrorState error={error} onRetry={reload} testid="users-error-state" /></div>
  if (!data) return <Loading label="Loading users…" testid="users-loading-state" />

  const remove = async () => {
    try {
      await api(`/api/users/${confirm.id}`, { method: 'DELETE' })
      push({ kind: 'success', title: 'User deleted', body: confirm.email, testid: 'user-delete-success-toast' })
      reload()
    } catch (e) {
      push({ kind: 'error', title: 'Could not delete user', body: e.message, testid: 'user-delete-error-toast' })
    } finally {
      setConfirm(null)
    }
  }

  return (
    <>
      <div className="page-head">
        <div><h1 data-testid="page-title">Users</h1><p>Administrators configure the system; viewers monitor their own ESP32 nodes. Open a user to see their building.</p></div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setEditing(null)} data-testid="user-add-button"><UserPlus size={14} aria-hidden="true" /> Add user</button>
        </div>
      </div>
      <section className="panel">
        {data.items.length === 0 ? <EmptyState title="No users" testid="users-empty-state" /> : (
          <table className="data responsive" data-testid="users-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Nodes</th><th>Last login</th><th>Actions</th></tr></thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id} data-testid={`user-row-${slug(u.email)}`}>
                  <td data-label="Name">
                    <Link to={`/users/${u.id}`} data-testid={`user-open-${slug(u.email)}`}>{u.name}</Link>
                    {u.id === me.id ? <span className="dim small"> (you)</span> : null}
                  </td>
                  <td data-label="Email" className="mono break">{u.email}</td>
                  <td data-label="Role"><Badge value={u.role} label={u.role === 'admin' ? 'Administrator' : 'Viewer'} /></td>
                  <td data-label="Status"><Badge value={u.active ? 'online' : 'inactive'} label={u.active ? 'Active' : 'Inactive'} /></td>
                  <td data-label="Nodes" className="num" data-testid={`user-node-count-${slug(u.email)}`}>{u.node_count ?? 0}</td>
                  <td data-label="Last login" className="num">{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
                  <td data-label="Actions">
                    <div className="row">
                      <Link to={`/users/${u.id}`} className="btn btn-sm" data-testid={`user-building-button-${slug(u.email)}`} aria-label={`Building of ${u.email}`}>
                        <Building2 size={13} aria-hidden="true" /> Building
                      </Link>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(u)} data-testid={`user-edit-button-${slug(u.email)}`} aria-label={`Edit ${u.email}`}>
                        <Pencil size={13} aria-hidden="true" /> Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" disabled={u.id === me.id} onClick={() => setConfirm(u)}
                        data-testid={`user-delete-button-${slug(u.email)}`} aria-label={`Delete ${u.email}`}>
                        <Trash2 size={13} aria-hidden="true" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="xs dim row"><KeyRound size={12} aria-hidden="true" /> Passwords are hashed with bcrypt. Five failed sign-ins lock an account for 15 minutes.</p>
      {editing !== undefined ? (
        <UserForm initial={editing} onClose={() => setEditing(undefined)} onSaved={(msg) => { setEditing(undefined); push({ kind: 'success', title: msg, testid: 'user-save-success-toast' }); reload() }} />
      ) : null}
      {confirm ? (
        <Dialog title="Delete user?" onClose={() => setConfirm(null)} testid="user-delete-dialog">
          <p>Permanently delete <span className="mono">{confirm.email}</span>? They will lose access immediately.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setConfirm(null)} data-testid="user-delete-cancel-button">Cancel</button>
            <button type="button" className="btn btn-danger" onClick={remove} data-testid="user-delete-confirm-button">Delete user</button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

// Thin fetch wrapper. Auth is an HttpOnly cookie set by the API, so no token ever
// touches JavaScript. Every request carries X-SHM-Client, which the API requires on
// state-changing calls (CSRF defence).
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

// Full URL for API resources loaded directly by the browser (e.g. <img src>).
export const apiUrl = (path) => BASE + path

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function api(path, { method = 'GET', body, query, raw = false, signal } = {}) {
  let url = BASE + path
  if (query) {
    const qs = new URLSearchParams()
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    })
    const s = qs.toString()
    if (s) url += `?${s}`
  }
  let res
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      signal,
      headers: { 'X-SHM-Client': 'web', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(0, 'Cannot reach the SHM server. Check your connection.')
  }
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    let detail = 'Not authenticated'
    try { detail = (await res.clone().json()).detail || detail } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('shm:unauthorized', { detail }))
  }
  if (!res.ok) {
    let data = null
    try { data = await res.json() } catch { /* non-JSON */ }
    const msg = (data && (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))) ||
      `Request failed (HTTP ${res.status})`
    throw new ApiError(res.status, msg, data)
  }
  if (raw) return res
  if (res.status === 204) return null
  return res.json()
}

export async function downloadCsv(body) {
  const res = await api('/api/exports/csv', { method: 'POST', body, raw: true })
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'shm-export.csv'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return { name, rows: Number(res.headers.get('X-Row-Count') || 0) }
}

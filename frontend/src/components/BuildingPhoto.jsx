// A photo of the user's own building for the Building map card: upload, change or remove it.
import { useRef, useState } from 'react'
import { Camera, Trash2 } from 'lucide-react'
import { api, apiUrl } from '../lib/api'

const MAX_SIDE = 1280

// Shrink the photo in the browser (longest side 1280 px, JPEG) so uploads stay small.
async function toPhotoDataUrl(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP photo.')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That file could not be opened as an image.'))
      i.src = url
    })
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** URL of an account's building photo (`owner` only when an admin looks at someone else's). */
export function buildingPhotoUrl(version, owner) {
  return apiUrl(`/api/profile/building/photo?v=${version}${owner ? `&user_id=${encodeURIComponent(owner)}` : ''}`)
}

/** Upload / change / remove buttons; `onChange(version | null)` after each change. */
export function BuildingPhotoActions({ version, onChange }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn) => {
    setBusy(true)
    setError('')
    try { onChange((await fn()).building_photo) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await run(async () => api('/api/profile/building/photo', { method: 'PUT', body: { image: await toPhotoDataUrl(file) } }))
  }
  return (
    <div className="ud-photo-actions">
      {error ? <span className="ud-photo-error" role="alert" data-testid="building-photo-error">{error}</span> : null}
      <button type="button" className="ud-photo-btn" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="building-photo-upload">
        <Camera size={13} aria-hidden="true" /> {busy ? 'Saving…' : version ? 'Change photo' : 'Add a photo'}
      </button>
      {version ? (
        <button type="button" className="ud-photo-btn" onClick={() => run(() => api('/api/profile/building/photo', { method: 'DELETE' }))}
          disabled={busy} aria-label="Remove the photo" data-testid="building-photo-remove"><Trash2 size={13} aria-hidden="true" /></button>
      ) : null}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload} data-testid="building-photo-input" />
    </div>
  )
}

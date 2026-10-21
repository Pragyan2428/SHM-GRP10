import { expect } from '@playwright/test'
import { API_PORT, DEVICE_KEY } from './env.js'

const API = `http://127.0.0.1:${API_PORT}`

export async function login(page, { email, password }) {
  await page.goto('/login')
  await page.getByTestId('login-email-input').fill(email)
  await page.getByTestId('login-password-input').fill(password)
  await page.getByTestId('login-submit-button').click()
  // Administrators land on the dashboard, everyone else on the readings page.
  await expect(page.getByTestId('app-header').or(page.getByTestId('user-page'))).toBeVisible()
}

/** A node id no other test uses, so every breach opens a fresh alert (no dedupe/cooldown). */
export function uniqueNode() {
  return `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
}

/** POST a reading straight to the device ingestion endpoint, as an ESP32 would.
 * `key` defaults to the site-wide key (the admin's devices); pass a user's personal key to
 * make the node theirs. */
export async function ingest(request, nodeId, readings, key = DEVICE_KEY) {
  const res = await request.post(`${API}/api/ingest`, {
    headers: { 'X-Device-Key': key },
    data: { node_id: nodeId, location: 'E2E test span', readings, battery: 90, rssi: -60 },
  })
  expect(res.status(), await res.text()).toBe(200)
  return res.json()
}

/** Strain well above the default critical limit (620 safe / 775 critical). */
export const BREACH = { strain: 900 }

/** Wait until the live poller has loaded once, so later alerts count as "new" and toast. */
export async function waitForFirstPoll(page) {
  await expect(page.getByTestId('live-connection-indicator')).toBeAttached()
  await page.waitForResponse((r) => r.url().includes('/api/events') && r.ok())
}

/** Find the alert created for a node via the API, using the page's session cookie. */
export async function alertFor(page, nodeId) {
  let alert
  await expect.poll(async () => {
    const res = await page.request.get('/api/events', { params: { node_id: nodeId } })
    alert = (await res.json()).items.find((a) => a.type === 'threshold')
    return !!alert
  }).toBe(true)
  return alert
}

/** Log out through the profile card (hover the avatar at the top right, then "Log out"). */
export async function logout(page) {
  await page.getByTestId('profile-button').hover()
  const card = page.getByTestId('profile-card')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Log out' }).click()
}

/** The signed-in account's personal device key (nodes sent with it show only for that account). */
export async function myDeviceKey(page) {
  const r = await page.request.get('/api/profile/device', { headers: { 'X-SHM-Client': 'web' } })
  expect(r.status(), await r.text()).toBe(200)
  return (await r.json()).device_key
}

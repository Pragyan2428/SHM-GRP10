import { expect, test } from '@playwright/test'
import { ADMIN, API_PORT } from './env.js'
import { ingest, login, logout, myDeviceKey, uniqueNode } from './helpers.js'

const PASSWORD = 'Profile-Pass-0001'

// A real 300x200 PNG "photo", drawn by the browser.
async function photo(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 300
    c.height = 200
    const g = c.getContext('2d')
    g.fillStyle = '#ff7a1a'
    g.fillRect(0, 0, 300, 200)
    g.fillStyle = '#111315'
    g.beginPath()
    g.arc(150, 100, 60, 0, Math.PI * 2)
    g.fill()
    return c.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(b64, 'base64')
}

// Each test gets its own new account, so changes never leak into other tests.
async function newUser(page, name = 'Profile Tester') {
  const email = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@gmail.com`
  await page.goto('/login')
  const r = await page.request.post('/api/auth/signup', { headers: { 'X-SHM-Client': 'web' }, data: { name, email, password: PASSWORD } })
  expect(r.status()).toBe(201)
  await page.goto('/user')
  await expect(page.getByTestId('user-page')).toBeVisible()
  return email
}

async function openCard(page) {
  await page.getByTestId('profile-button').hover()
  const card = page.getByTestId('profile-card')
  await expect(card).toBeVisible()
  return card
}

test('hovering the avatar shows the user details and settings', async ({ page }) => {
  const email = await newUser(page, 'Hover Person')
  await expect(page.getByTestId('profile-card')).toHaveCount(0)
  // the button itself shows only the picture: no visible name or role
  await expect(page.getByTestId('profile-button')).not.toContainText('Viewer')
  const nameBox = await page.getByTestId('user-current-user').boundingBox() // screen-reader-only text
  expect(nameBox.width).toBeLessThanOrEqual(1)
  const card = await openCard(page)
  await expect(card).toContainText('Hover Person')
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  await expect(card).toContainText('Viewer')
  await expect(card).toContainText('Member since')
  for (const n of [1, 2, 3, 4]) await expect(page.getByTestId(`avatar-preset-${n}`)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Log out' })).toBeVisible()
  await expect(card.getByRole('link', { name: 'About the project' })).toBeVisible()
  // moving the mouse away closes it
  await page.mouse.move(5, 700)
  await expect(page.getByTestId('profile-card')).toHaveCount(0)
})

test('choosing one of the four avatars updates the picture everywhere and is saved', async ({ page }) => {
  await newUser(page)
  await openCard(page)
  await page.getByTestId('avatar-preset-3').click()
  await expect(page.getByTestId('profile-message')).toHaveText('Profile picture updated')
  await expect(page.getByTestId('avatar-preset-3')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('profile-avatar').locator('img')).toHaveAttribute('src', /avatars\/avatar-3\.svg$/)
  await page.reload()
  await expect(page.getByTestId('profile-avatar').locator('img')).toHaveAttribute('src', /avatar-3\.svg$/)
  await expect(page.getByTestId('ud-account').locator('img')).toHaveAttribute('src', /avatar-3\.svg$/)
})

test('a user can upload their own photo and remove it', async ({ page }) => {
  await newUser(page, 'Photo Person')
  await openCard(page)
  await page.getByTestId('avatar-upload-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: await photo(page) })
  await expect(page.getByTestId('profile-message')).toHaveText('Photo uploaded')
  const img = page.getByTestId('profile-avatar').locator('img')
  await expect(img).toHaveAttribute('src', /\/api\/profile\/avatar\?v=\d+/)
  await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(256)
  await page.getByTestId('avatar-remove').click()
  await expect(page.getByTestId('profile-message')).toHaveText('Profile picture removed')
  await expect(page.getByTestId('profile-avatar').locator('img')).toHaveCount(0)
  await expect(page.getByTestId('profile-avatar')).toHaveText('PP')
})

test('other file types are refused before upload', async ({ page }) => {
  await newUser(page)
  await openCard(page)
  await page.getByTestId('avatar-upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(page.getByTestId('profile-message')).toContainText('PNG, JPEG or WebP')
})

test('a user can rename themselves and change their password', async ({ page }) => {
  const email = await newUser(page, 'Old Name')
  await openCard(page)
  await page.getByTestId('profile-name-input').fill('New Name')
  await page.getByTestId('profile-name-save').click()
  await expect(page.getByTestId('profile-message')).toHaveText('Name saved')
  await expect(page.getByTestId('user-current-user')).toHaveText('New Name')

  await page.getByTestId('profile-password-toggle').click()
  await page.getByTestId('profile-password-current').fill('wrong-password-1')
  await page.getByTestId('profile-password-new').fill('Brand-New-Pass-9')
  await page.getByTestId('profile-password-confirm').fill('Brand-New-Pass-9')
  await page.getByTestId('profile-password-save').click()
  await expect(page.getByTestId('profile-message')).toContainText('current password is not correct')
  await page.getByTestId('profile-password-current').fill(PASSWORD)
  await page.getByTestId('profile-password-save').click()
  await expect(page.getByTestId('profile-message')).toHaveText('Password changed')

  await logout(page)
  await login(page, { email, password: 'Brand-New-Pass-9' })
  await expect(page).toHaveURL(/\/user$/)
  await expect(page.getByTestId('user-current-user')).toHaveText('New Name')
})

test('the admin profile card has dashboard shortcuts', async ({ page }) => {
  await login(page, ADMIN)
  const card = await openCard(page)
  await expect(card).toContainText('Administrator')
  for (const name of ['Overview', 'Manage users', 'Notification settings', 'System settings']) {
    await expect(card.getByRole('link', { name })).toBeVisible()
  }
  await card.getByRole('link', { name: 'Manage users' }).click()
  await expect(page).toHaveURL(/\/users$/)
})

test('the user dashboard has the sidebar, KPI cards, chart, node table and map', async ({ page, request }) => {
  const node = uniqueNode()
  await newUser(page)
  await ingest(request, node, { strain: 350, vibration: 0.5, temperature: 26 }, await myDeviceKey(page))
  await expect(page.getByTestId('page-title')).toHaveText('Dashboard')
  await expect(page.getByRole('navigation', { name: 'Dashboard sections' })).toBeVisible()
  for (const p of ['strain', 'vibration', 'temperature']) await expect(page.getByTestId(`ud-kpi-${p}`)).toBeVisible()
  await expect(page.getByTestId('ud-chart-strain')).toBeVisible()
  await page.getByTestId('ud-chart-tab-temperature').click()
  await expect(page.getByTestId('ud-chart-temperature')).toBeVisible()
  await expect(page.getByTestId('user-summary')).toContainText('nodes')
  await expect(page.getByTestId('ud-map').locator('svg').first()).toBeVisible()
  // the sidebar search filters the node table
  await expect(page.getByTestId(`user-node-card-${node}`)).toBeVisible()
  await page.getByTestId('ud-search').fill(node.toLowerCase())
  await expect(page.locator('[data-testid^="user-node-card-"]')).toHaveCount(1)
  await page.getByTestId('ud-search').fill('no-such-node')
  await expect(page.getByTestId('user-empty-state')).toBeVisible()
})

test('a new user connects their own ESP32 from their page, with no keys or commands', async ({ page, request }) => {
  const others = uniqueNode()
  await ingest(request, others, { strain: 400 }) // a node of the site, not of this account
  await newUser(page, 'Fresh Account')
  await expect(page.getByTestId('user-no-nodes')).toBeVisible()
  await expect(page.getByTestId('ud-map')).toHaveCount(0) // no building until a node of theirs reports
  const card = page.getByTestId('add-my-node')
  await expect(card).toContainText('Add your ESP32')
  await expect(card.getByTestId('nearby-ble-toggle')).toBeVisible() // Bluetooth set-up offered
  await expect(card.getByTestId('nearby-scope-all')).toHaveCount(0) // users only see their own Wi-Fi
  await expect(page.getByText(/device key|secrets\.h|python tools/i)).toHaveCount(0) // nothing to copy

  // a board on the same Wi-Fi announces itself, the user connects it and its readings appear
  const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()
  const mac = `24:6F:28:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`
  const announce = () => request.post(`http://127.0.0.1:${API_PORT}/api/devices/announce`,
    { data: { mac, claim_secret: `user${hex}secretvalue`, firmware: '2.0.0', rssi: -50, local_ip: '192.168.1.60' } })
  expect((await announce()).status()).toBe(200)
  const short = mac.replace(/:/g, '').toLowerCase()
  await card.getByTestId(`nearby-connect-${short}`).click()
  await expect(card.getByTestId('my-node-name-input')).toHaveValue(`ESP32-${hex}`)
  await card.getByTestId('my-node-location-input').fill('2nd floor - column C2')
  await card.getByTestId('my-node-connect-button').click()
  await expect(page.getByTestId('my-node-connected-toast')).toBeVisible()

  const reply = await (await announce()).json() // the board's next announce gives it its key
  expect(reply.status).toBe('approved')
  const r = await request.post(`http://127.0.0.1:${API_PORT}/api/ingest`,
    { headers: { 'X-Device-Key': reply.device_key }, data: { node_id: reply.node_id, readings: { strain: 300 } } })
  expect(r.status()).toBe(200)
  const id = `ESP32-${hex}`
  await expect(page.getByTestId(`user-node-card-${id}`)).toBeVisible({ timeout: 15_000 }) // appears on its own
  await expect(page.getByTestId(`user-node-card-${others}`)).toHaveCount(0)
  await expect(page.getByTestId('ud-map').getByTestId(`map-pin-${id.toLowerCase()}`)).toHaveAttribute('data-floor', '2')
  await expect(page.getByTestId('add-my-node')).toContainText('Add another ESP32')
})

test('a user puts a photo of their building in the map card, switches views and removes it', async ({ page, request }) => {
  await newUser(page, 'Photo Building')
  await ingest(request, uniqueNode(), { strain: 300 }, await myDeviceKey(page))
  const card = page.getByTestId('ud-map')
  await expect(card.locator('svg').first()).toBeVisible() // the drawing until a photo is added
  await card.getByTestId('building-photo-input').setInputFiles({ name: 'house.png', mimeType: 'image/png', buffer: await photo(page) })
  const img = card.getByTestId('ud-building-photo')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(300)
  await page.screenshot({ path: '.shots/building-photo.png' })
  await card.getByTestId('ud-map-view-plan').click()
  await expect(img).toHaveCount(0)
  await expect(card.getByTestId('ud-floor-select')).toBeVisible()
  await card.getByTestId('ud-map-view-photo').click()
  await page.reload()
  await expect(card.getByTestId('ud-building-photo')).toBeVisible() // saved
  await card.getByTestId('building-photo-remove').click()
  await expect(card.getByTestId('ud-building-photo')).toHaveCount(0)
  await expect(card.getByTestId('building-photo-upload')).toHaveText(/Add a photo/)
})

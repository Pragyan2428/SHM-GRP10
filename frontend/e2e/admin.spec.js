import { expect, test } from '@playwright/test'
import { ADMIN } from './env.js'
import { login, uniqueNode } from './helpers.js'

const H = { 'X-SHM-Client': 'web' }

async function newViewer(page, name) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now().toString(36)}@gmail.com`
  const r = await page.request.post('/api/users', { headers: H, data: { email, name, password: 'Viewer-pass-2026', role: 'viewer' } })
  expect(r.status(), await r.text()).toBe(201)
  return { ...(await r.json()), email }
}

test('the admin adds a node, places it on the floor plan, edits it and deletes it', async ({ page }) => {
  await login(page, ADMIN)
  const owner = await newViewer(page, 'Plan Owner')
  const id = uniqueNode()
  await page.goto('/nodes')
  await page.getByTestId('node-add-button').click()
  const form = page.getByTestId('node-form-dialog')
  await form.getByTestId('node-form-id-input').fill(id)
  await form.getByTestId('node-form-location-input').fill('Column C2, east face')
  await form.getByTestId('node-form-floor-select').selectOption('2')
  await form.getByTestId('node-form-owner-select').selectOption(owner.id)
  const plan = form.getByTestId('node-form-plan')
  const box = await plan.boundingBox()
  await plan.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } }) // click in the middle of the floor
  await expect(form.getByTestId('plan-pick-marker')).toBeVisible()
  await form.getByTestId('node-form-submit-button').click()
  await expect(page.getByTestId('node-save-success-toast')).toBeVisible()

  const card = page.getByTestId(`sensor-node-card-${id.toLowerCase()}`)
  await expect(card.getByTestId(`sensor-node-status-${id.toLowerCase()}`)).toHaveText(/offline/i) // registered, not reported yet
  await expect(card.getByTestId(`sensor-node-floor-${id.toLowerCase()}`)).toHaveText('2F')
  await expect(card.getByTestId(`sensor-node-owner-${id.toLowerCase()}`)).toHaveText(owner.email)
  const saved = await (await page.request.get('/api/nodes', { headers: H })).json()
  const node = saved.items.find((n) => n.node_id === id)
  expect(node.plan_x).toBeGreaterThan(40)
  expect(node.plan_x).toBeLessThan(60)

  await card.getByTestId(`sensor-node-edit-${id.toLowerCase()}`).click()
  await page.getByTestId('node-form-floor-select').selectOption('roof')
  await page.getByTestId('node-form-submit-button').click()
  await expect(card.getByTestId(`sensor-node-floor-${id.toLowerCase()}`)).toHaveText('Roof')

  await card.getByTestId(`sensor-node-delete-${id.toLowerCase()}`).click()
  await page.getByTestId('node-delete-confirm-button').click()
  await expect(page.getByTestId('node-delete-success-toast')).toBeVisible()
  await expect(card).toHaveCount(0)
})

test("clicking a user shows the structure of that user's building", async ({ page }) => {
  await login(page, ADMIN)
  const owner = await newViewer(page, 'Tower Owner')
  const high = uniqueNode()
  const top = uniqueNode()
  const loose = uniqueNode()
  for (const data of [
    { node_id: high, location: '7th floor - column C2', owner_id: owner.id, plan_x: 30, plan_y: 40 },
    { node_id: top, location: 'Plant room', floor: 'roof', owner_id: owner.id },
    { node_id: loose, location: 'Pump house', owner_id: owner.id },
  ]) {
    const r = await page.request.post('/api/nodes', { headers: H, data })
    expect(r.status(), await r.text()).toBe(201)
  }

  await page.goto('/users')
  await expect(page.getByTestId(`user-node-count-${owner.email.replace(/[^a-z0-9]+/g, '-')}`)).toHaveText('3')
  await page.getByTestId(`user-building-button-${owner.email.replace(/[^a-z0-9]+/g, '-')}`).click()
  await expect(page).toHaveURL(new RegExp(`/users/${owner.id}$`))
  await expect(page.getByTestId('page-title')).toHaveText('Tower Owner’s building')
  await expect(page.getByTestId('user-structure-count')).toHaveText('3 nodes')

  // the 3D structure, drawn only from this user's nodes
  const twin = page.getByTestId('digital-twin')
  await expect(twin.getByTestId(`map-pin-${high.toLowerCase()}`)).toHaveAttribute('data-floor', '7')
  await expect(twin.getByTestId(`map-pin-${top.toLowerCase()}`)).toHaveAttribute('data-floor', 'roof')
  await expect(twin.getByTestId(`map-pin-${loose.toLowerCase()}`)).toHaveAttribute('data-floor', 'unknown')
  await expect(twin.getByTestId('map-pin-esp32-01')).toHaveCount(0) // not the site's demo nodes
  await expect(page.getByTestId('twin-floors')).toContainText('7F')
  await expect(page.getByTestId('twin-floor-6f')).toHaveCount(0)

  // and its floor plans
  const plans = page.getByTestId('user-structure-plans')
  await expect(plans.getByTestId('plan-card-7f')).toBeVisible()
  await expect(plans.getByTestId('plan-card-no-floor')).toBeVisible()
  await plans.getByTestId('plan-tab-7f').click()
  await expect(plans.getByTestId(`map-pin-${high.toLowerCase()}`)).toHaveAttribute('data-placed', 'true')
  await expect(page.getByTestId(`user-structure-node-${high.toLowerCase()}`)).toContainText('7F')
})

test('an account without nodes shows an empty building to the admin', async ({ page }) => {
  await login(page, ADMIN)
  const owner = await newViewer(page, 'Empty Owner')
  await page.goto(`/users/${owner.id}`)
  await expect(page.getByTestId('user-structure-empty')).toBeVisible()
  await expect(page.getByTestId('digital-twin')).toHaveCount(0)
})

test('Telegram is offered as a notification channel', async ({ page }) => {
  await login(page, ADMIN)
  await page.goto('/notifications')
  const card = page.getByTestId('integration-telegram')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('integration-telegram-status')).toHaveText(/Not configured/)
  await expect(card).toContainText('@BotFather')
  await expect(page.getByTestId('notifications-telegram-find-button')).toBeDisabled()
  await expect(page.getByTestId('notifications-telegram-recipients-input')).toBeVisible()
})

test('a user names their building and sees their alert options; the admin sees the name', async ({ page, browser }) => {
  await login(page, ADMIN)
  const owner = await newViewer(page, 'Named Owner')
  const ctx = await browser.newContext()
  const user = await ctx.newPage()
  await login(user, { email: owner.email, password: 'Viewer-pass-2026' })
  await expect(user.getByTestId('ud-building-name')).toHaveText('My building')
  await user.getByTestId('ud-building-name').click()
  await user.getByTestId('ud-building-name-input').fill('Hostel Block C')
  await user.getByTestId('ud-building-name-save').click()
  await expect(user.getByTestId('ud-building-name')).toHaveText('Hostel Block C')
  const alerts = user.getByTestId('my-alerts')
  await expect(alerts).toBeVisible()
  await expect(alerts.getByTestId('my-alerts-email')).toContainText('Not set up on this site yet') // no mail sender in tests
  await expect(alerts.getByTestId('my-alerts-telegram')).toContainText('Not set up on this site yet')
  await ctx.close()

  await page.goto('/users')
  const slugged = owner.email.replace(/[^a-z0-9]+/g, '-')
  await expect(page.getByTestId(`user-building-name-${slugged}`)).toHaveText('Hostel Block C')
  await page.getByTestId(`user-building-button-${slugged}`).click()
  await expect(page.getByTestId('page-title')).toHaveText('Hostel Block C')
})

test("each user has a short ID on their dashboard, and the admin finds them by it", async ({ page, browser }) => {
  await login(page, ADMIN)
  const owner = await newViewer(page, 'Id Owner')
  const ctx = await browser.newContext()
  const user = await ctx.newPage()
  await login(user, { email: owner.email, password: 'Viewer-pass-2026' })
  const badge = user.getByTestId('user-short-id')
  await expect(badge).toContainText(/U-[0-9A-F]{6}/)
  const id = (await badge.textContent()).match(/U-[0-9A-F]{6}/)[0]
  await ctx.close()

  await page.goto('/users')
  await page.getByTestId('users-search').fill(id.toLowerCase())
  const slugged = owner.email.replace(/[^a-z0-9]+/g, '-')
  await expect(page.getByTestId(`user-short-id-${slugged}`)).toHaveText(id)
  await expect(page.locator('[data-testid^="user-short-id-"]')).toHaveCount(1) // only that user is listed
  await page.getByTestId(`user-building-button-${slugged}`).click()
  await expect(page.getByTestId('user-structure-id')).toHaveText(id)
})

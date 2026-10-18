import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { ADMIN } from './env.js'
import { BREACH, alertFor, ingest, login, uniqueNode, waitForFirstPoll } from './helpers.js'

// The UI polls every 5 s, so give alert-driven assertions room for a couple of polls.
const POLL = { timeout: 15_000 }

test.beforeEach(async ({ page }) => {
  await login(page, ADMIN)
})

test('a breaching ingest raises an alert toast', async ({ page, request }) => {
  await waitForFirstPoll(page)
  const node = uniqueNode()
  await ingest(request, node, BREACH)
  const toast = page.getByTestId('alert-toast').filter({ hasText: node })
  await expect(toast).toBeVisible(POLL)
  await expect(toast).toContainText('Strain')
  await expect(page.getByTestId('header-open-alert-count')).toBeVisible()
})

test('admin acknowledges an alert from the history page', async ({ page, request }) => {
  const node = uniqueNode()
  await ingest(request, node, BREACH)
  const alert = await alertFor(page, node)

  await page.goto('/history')
  await page.getByTestId('history-node-filter').selectOption(node)
  await page.getByTestId(`alert-acknowledge-button-${alert.id}`).click()
  await expect(page.getByTestId('ack-success-toast')).toBeVisible()
  await expect(page.getByTestId(`alert-acknowledged-${alert.id}`)).toBeVisible()

  const res = await page.request.get('/api/events', { params: { node_id: node } })
  const saved = (await res.json()).items.find((a) => a.id === alert.id)
  expect(saved.status).toBe('acknowledged')
  expect(saved.acknowledged_by).toBe(ADMIN.email)
})

test('CSV export downloads the filtered records', async ({ page, request }) => {
  const node = uniqueNode()
  await ingest(request, node, BREACH)
  await alertFor(page, node)

  await page.goto('/history')
  await page.getByTestId('history-node-filter').selectOption(node)
  await expect(page.getByTestId('history-alerts-table')).toContainText(node)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('csv-export-button').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.csv$/)
  const csv = await readFile(await download.path(), 'utf8')
  const [header, ...rows] = csv.trim().split(/\r?\n/)
  expect(header).toContain('Node ID')
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every((r) => r.includes(node))).toBe(true)
  await expect(page.getByTestId('csv-export-success-toast')).toBeVisible()
})

test.describe('browser notifications', () => {
  test.beforeEach(async ({ page }) => {
    // Headless Chromium (the headless shell) shows no notifications and pins the static
    // Notification.permission at "denied", although requestPermission() and the
    // Permissions API do follow context.grantPermissions(). This shim takes `permission`
    // from the Permissions API, as a headed browser would report it, and records every
    // Notification the app creates. The app's own request/notify code runs unchanged.
    await page.addInitScript(() => {
      const Real = window.Notification
      const fromState = { granted: 'granted', denied: 'denied', prompt: 'default' }
      let permission = 'default'
      navigator.permissions.query({ name: 'notifications' }).then((status) => {
        permission = fromState[status.state]
        status.onchange = () => { permission = fromState[status.state] }
      })
      window.__shmNotifications = []
      class Recorded extends Real {
        constructor(title, options) {
          window.__shmNotifications.push({ title, body: options?.body })
          super(title, options)
        }

        static get permission() { return permission }

        static async requestPermission() {
          permission = await Real.requestPermission()
          return permission
        }
      }
      window.Notification = Recorded
    })
  })

  test('enable button asks for permission and granted alerts notify', async ({ page, context, request }) => {
    await page.reload()
    await page.getByTestId('header-notification-button').click()
    await expect(page.getByTestId('notification-dropdown')).toBeVisible()
    const enable = page.getByTestId('browser-notification-enable-button')
    await expect(enable).toBeVisible()

    await context.grantPermissions(['notifications'])
    await enable.click()
    await expect(page.getByTestId('browser-notification-status')).toHaveText('Browser alerts on')
    expect(await page.evaluate(() => Notification.permission)).toBe('granted')

    await page.keyboard.press('Escape')
    await waitForFirstPoll(page)
    const node = uniqueNode()
    await ingest(request, node, BREACH)
    await expect.poll(() => page.evaluate(() => window.__shmNotifications), POLL)
      .toContainEqual(expect.objectContaining({ title: expect.stringContaining('Strain') }))
    const notes = await page.evaluate(() => window.__shmNotifications)
    expect(notes.some((n) => n.body.includes(node))).toBe(true)
  })

  test('with permission already granted the dropdown shows alerts on', async ({ page, context }) => {
    await context.grantPermissions(['notifications'])
    await page.reload()
    await page.getByTestId('header-notification-button').click()
    await expect(page.getByTestId('browser-notification-status')).toHaveText('Browser alerts on')
    await expect(page.getByTestId('browser-notification-enable-button')).toHaveCount(0)
  })
})

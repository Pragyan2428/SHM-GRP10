import { expect, test } from '@playwright/test'
import { ADMIN, VIEWER } from './env.js'
import { BREACH, alertFor, ingest, login, myDeviceKey, uniqueNode } from './helpers.js'

const WIDTH = 390
test.use({ viewport: { width: WIDTH, height: 844 }, isMobile: true, hasTouch: true })

const ROUTES = ['/', '/telemetry', '/history', '/nodes', '/thresholds', '/notifications',
  '/google-sheets', '/users', '/system', '/does-not-exist']

async function expectNoHorizontalOverflow(page, label) {
  // Let charts and tables finish laying out before measuring.
  await page.waitForLoadState('networkidle')
  const sw = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(sw, `${label} scrollWidth`).toBeLessThanOrEqual(WIDTH)
}

test('login and sign-up pages fit 390px', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('login-page')).toBeVisible()
  await expectNoHorizontalOverflow(page, '/login')
  // phones get a plain form: no big side panel, just a link under the button
  await expect(page.locator('.auth-overlay')).toBeHidden()
  await page.getByTestId('mobile-signup-link').click()
  await expect(page).toHaveURL(/\/signup$/)
  await expect(page.getByTestId('signup-page')).toBeVisible()
  await expectNoHorizontalOverflow(page, '/signup')
  await page.getByTestId('mobile-login-link').click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/about')
  await expect(page.getByTestId('about-page')).toBeVisible()
  await expectNoHorizontalOverflow(page, '/about')
})

test('every dashboard route fits 390px as admin', async ({ page, request }) => {
  // Give the node list and history pages real rows to lay out.
  const node = uniqueNode()
  await ingest(request, node, BREACH)
  await login(page, ADMIN)
  await alertFor(page, node)

  for (const path of [...ROUTES, `/nodes/${node}`, '/user']) {
    await test.step(path, async () => {
      await page.goto(path)
      await expect(page.getByTestId(path === '/does-not-exist' ? 'not-found-state' : 'page-title')).toBeVisible()
      await expectNoHorizontalOverflow(page, path)
    })
  }

  await test.step('open navigation drawer', async () => {
    await page.goto('/')
    await page.getByTestId('header-menu-button').click()
    await expect(page.getByTestId('sidebar')).toHaveClass(/open/)
    await expectNoHorizontalOverflow(page, 'nav drawer')
  })
})

test('readings page fits 390px as a user', async ({ page, request }) => {
  const node = uniqueNode()
  await login(page, VIEWER)
  await ingest(request, node, BREACH, await myDeviceKey(page))
  await expect(page).toHaveURL(/\/user$/)
  await expect(page.getByTestId(`user-node-card-${node}`)).toBeVisible()
  await expectNoHorizontalOverflow(page, '/user')
  // the bottom tab bar's + button opens "Add another ESP32"
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  await page.getByTestId('ud-tab-add').click()
  await expect(page.getByTestId('add-my-node')).toHaveAttribute('open', '')
})

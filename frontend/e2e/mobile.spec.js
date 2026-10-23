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

test('a back-to-top button appears after scrolling and takes you up', async ({ page }) => {
  await page.goto('/about')
  await expect(page.getByTestId('about-cta')).toBeAttached() // the whole page has loaded
  const btn = page.getByTestId('scroll-top')
  await expect(btn).not.toHaveClass(/show/)
  await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.3))
  await expect(btn).toHaveClass(/show/)
  await page.waitForTimeout(400)
  await page.screenshot({ path: '.shots/scroll-top.png' })
  await btn.click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5)
  await expect(btn).not.toHaveClass(/show/)
})

test('the back-to-top button is only on the About page', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('login-page')).toBeVisible()
  await expect(page.getByTestId('scroll-top')).toHaveCount(0)
})

test('the About page opens the 3D sensor node full screen and takes it apart', async ({ page }) => {
  await page.goto('/about')
  await page.getByTestId('about-view-3d').click()
  const viewer = page.getByTestId('node-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.getByTestId('node3d-viewer').or(viewer.locator('svg.exploded'))).toBeVisible()
  await viewer.getByTestId('node-viewer-assemble').click()
  await expect(viewer.getByTestId('node-viewer-slider')).toHaveValue('0')
  await viewer.getByTestId('node-viewer-explode').click()
  await expect(viewer.getByTestId('node-viewer-slider')).toHaveValue('100')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
})

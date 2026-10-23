import { expect, test } from '@playwright/test'

// Automated browsers skip the intro unless ?intro is in the URL (see index.html).
test('the intro plays before the page and then lifts away', async ({ page }) => {
  await page.goto('/login?intro')
  const intro = page.getByTestId('intro')
  await expect(intro).toBeVisible()
  await expect(intro).toHaveAttribute('role', 'status')
  await expect(intro).toContainText('Smart')
  await expect(intro).toHaveCount(0, { timeout: 8000 })
  await expect(page.getByTestId('login-page')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.classList.contains('intro-on'))).toBe(false)
})

test('clicking skips the intro', async ({ page }) => {
  // Hold the intro (ignore the app's "ready" signal) so the click cannot race the automatic lift.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'shmIntro', { configurable: true, get: () => ({ ready() {} }), set() {} })
  })
  await page.goto('/about?intro')
  const intro = page.getByTestId('intro')
  await expect(intro).toBeVisible()
  await intro.click()
  await expect(intro).toHaveCount(0, { timeout: 3000 }) // the lift-away itself takes 0.78 s
  await expect(page.getByTestId('about-page')).toBeVisible()
})

test('the intro is not shown unless asked for in automated browsers', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('intro')).toHaveCount(0)
})

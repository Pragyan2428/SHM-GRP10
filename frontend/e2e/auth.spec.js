import { expect, test } from '@playwright/test'
import { ADMIN, VIEWER } from './env.js'
import { ingest, login, logout, uniqueNode } from './helpers.js'

test('the login page is titled Login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('login-title')).toHaveText('Login')
  await expect(page.getByTestId('login-submit-button')).toHaveText('Login')
})

test('admin can sign in and lands on the overview', async ({ page }) => {
  await login(page, ADMIN)
  await expect(page).toHaveURL('/')
  await expect(page.getByTestId('page-title')).toHaveText('Overview')
  // the header shows only the profile picture; the role is in the card that opens on hover
  await expect(page.getByTestId('header-role-label')).toHaveCount(0)
  await page.getByTestId('profile-button').hover()
  await expect(page.getByTestId('header-role-label')).toHaveText('Administrator')
})

test('invalid credentials show an error and stay on the login page', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('login-email-input').fill(ADMIN.email)
  await page.getByTestId('login-password-input').fill('definitely-not-the-password')
  await page.getByTestId('login-submit-button').click()
  await expect(page.getByTestId('login-error-message')).toBeVisible()
  await expect(page.getByTestId('login-error-message')).not.toBeEmpty()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('header-current-user')).toHaveCount(0)
})

test('unauthenticated visitors are sent to the login page', async ({ page }) => {
  await page.goto('/history')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('login-page')).toBeVisible()
})

test('logout ends the session', async ({ page }) => {
  await login(page, ADMIN)
  await logout(page)
  await expect(page.getByTestId('login-page')).toBeVisible()
  await expect(page.getByTestId('login-session-message')).toContainText('signed out')
  // The cookie is gone: a reload of a protected route goes back to login.
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
})

test.describe('user role', () => {
  test('lands on the readings page and sees live readings', async ({ page, request }) => {
    const node = uniqueNode()
    await ingest(request, node, { strain: 333.3, temperature: 25.5 })
    await login(page, VIEWER)
    await expect(page).toHaveURL(/\/user$/)
    await expect(page.getByTestId('page-title')).toHaveText('Dashboard')
    await expect(page.getByTestId(`user-node-status-${node}`)).toHaveText(/online/i)
    await expect(page.getByTestId(`user-reading-${node}-strain`)).toContainText('333.3')
    await expect(page.getByTestId(`user-reading-${node}-strain`)).toHaveAttribute('data-status', 'nominal')
    await expect(page.getByTestId(`user-reading-${node}-temperature`)).toContainText('25.5')
  })

  test('readings refresh without reloading the page', async ({ page, request }) => {
    const node = uniqueNode()
    await ingest(request, node, { strain: 300 })
    await login(page, VIEWER)
    await expect(page.getByTestId(`user-reading-${node}-strain`)).toContainText('300.0')
    await ingest(request, node, { strain: 700 })
    const tile = page.getByTestId(`user-reading-${node}-strain`)
    await expect(tile).toContainText('700.0', { timeout: 15_000 })
    await expect(tile).toHaveAttribute('data-status', 'critical')
  })

  for (const path of ['/', '/history', '/thresholds', '/users']) {
    test(`is sent to the readings page from ${path}`, async ({ page }) => {
      await login(page, VIEWER)
      await page.goto(path)
      await expect(page).toHaveURL(/\/user$/)
      await expect(page.getByTestId('app-header')).toHaveCount(0)
    })
  }

  test('can log out', async ({ page }) => {
    await login(page, VIEWER)
    await logout(page)
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page.getByTestId('login-session-message')).toContainText('signed out')
    await page.goto('/user')
    await expect(page).toHaveURL(/\/login$/)
  })
})

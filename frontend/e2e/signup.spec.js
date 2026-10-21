import { expect, test } from '@playwright/test'
import { ingest, login, logout, myDeviceKey, uniqueNode } from './helpers.js'

const PASSWORD = 'E2E-Signup-Pass-01'
const newEmail = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@gmail.com`

async function fillSignup(page, { name = 'E2E User', email, password = PASSWORD, confirm = password }) {
  await page.getByTestId('signup-name-input').fill(name)
  await page.getByTestId('signup-email-input').fill(email)
  await page.getByTestId('signup-password-input').fill(password)
  await page.getByTestId('signup-confirm-input').fill(confirm)
  await page.getByTestId('signup-submit-button').click()
}

test('login page links to sign up and back', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('login-signup-link').click()
  await expect(page).toHaveURL(/\/signup$/)
  await expect(page.getByTestId('signup-title')).toHaveText('Sign up')
  await page.getByTestId('signup-login-link').click()
  await expect(page).toHaveURL(/\/login$/)
})

test('a new user signs up, lands on the readings page and can log in again', async ({ page, request }) => {
  const site = uniqueNode()
  await ingest(request, site, { strain: 111.1 }) // the site's own node: not this user's
  const email = newEmail()

  await page.goto('/signup')
  await fillSignup(page, { name: 'Field Engineer', email })
  await expect(page).toHaveURL(/\/user$/)
  await expect(page.getByTestId('user-current-user')).toHaveText('Field Engineer')
  await expect(page.getByTestId('user-no-nodes')).toBeVisible() // starts empty, with the Connect card
  const node = uniqueNode()
  await ingest(request, node, { strain: 321.5 }, await myDeviceKey(page))
  await expect(page.getByTestId(`user-reading-${node}-strain`)).toContainText('321.5', { timeout: 15_000 })
  await expect(page.getByTestId(`user-node-card-${site}`)).toHaveCount(0)

  await logout(page)
  await expect(page.getByTestId('login-page')).toBeVisible()
  await login(page, { email, password: PASSWORD })
  await expect(page).toHaveURL(/\/user$/)
})

test('signing up with an existing email shows an error', async ({ page }) => {
  const email = newEmail()
  await page.goto('/signup')
  await fillSignup(page, { email })
  await expect(page).toHaveURL(/\/user$/)
  await logout(page)

  await page.goto('/signup')
  await fillSignup(page, { email: email.toUpperCase(), password: 'Another-Pass-002' })
  await expect(page.getByTestId('signup-error-message')).toContainText('already exists')
  await expect(page).toHaveURL(/\/signup$/)
})

test('sign-up shows the grey name@gmail.com placeholder and only accepts Gmail', async ({ page }) => {
  let posted = false
  page.on('request', (r) => { if (r.url().includes('/api/auth/signup')) posted = true })
  await page.goto('/signup')
  const email = page.getByTestId('signup-email-input')
  await expect(email).toHaveAttribute('placeholder', 'name@gmail.com')
  const colour = await email.evaluate((el) => getComputedStyle(el, '::placeholder').color)
  const [r, g, b] = colour.match(/\d+/g).map(Number)
  expect(Math.max(r, g, b) - Math.min(r, g, b), `placeholder colour ${colour} is grey`).toBeLessThan(30)

  await fillSignup(page, { email: 'someone@yahoo.com' })
  await expect(page.getByTestId('signup-error-message')).toContainText('Only Gmail addresses')
  expect(posted).toBe(false)
  await expect(page).toHaveURL(/\/signup$/)
})

test('the API also refuses non-Gmail sign-ups', async ({ page }) => {
  await page.goto('/signup')
  const res = await page.request.post('/api/auth/signup', {
    headers: { 'X-SHM-Client': 'web' },
    data: { name: 'Bypass', email: 'bypass@example.com', password: 'Bypass-Pass-0001' },
  })
  expect(res.status()).toBe(400)
  expect((await res.json()).detail).toContain('name@gmail.com')
})

test('the login page shows the name@gmail.com placeholder', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('login-email-input')).toHaveAttribute('placeholder', 'name@gmail.com')
})

test('the form checks passwords before sending', async ({ page }) => {
  let posted = false
  page.on('request', (r) => { if (r.url().includes('/api/auth/signup')) posted = true })
  await page.goto('/signup')

  await fillSignup(page, { email: newEmail(), password: 'short', confirm: 'short' })
  await expect(page.getByTestId('signup-error-message')).toContainText('at least 10 characters')

  await fillSignup(page, { email: newEmail(), confirm: 'Something-Else-99' })
  await expect(page.getByTestId('signup-error-message')).toContainText('do not match')
  expect(posted).toBe(false)
})

test('a signed-up user cannot open the admin dashboard', async ({ page }) => {
  await page.goto('/signup')
  await fillSignup(page, { email: newEmail() })
  await expect(page).toHaveURL(/\/user$/)
  for (const path of ['/', '/users', '/thresholds']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/user$/)
  }
})

test('switching between Login and Sign up slides instead of jumping', async ({ page }) => {
  await page.goto('/login')
  const card = page.locator('.auth-card.slider')
  await expect(card).toHaveAttribute('data-mode', 'login')
  const panel = page.locator('.auth-overlay')
  const before = await panel.boundingBox()
  await page.getByTestId('login-signup-link').click()
  await expect(page).toHaveURL(/\/signup$/)
  await expect(card).toHaveAttribute('data-mode', 'signup')
  // the same card stays on screen and its panel is mid-slide shortly after the click
  const during = await panel.evaluate((el) => getComputedStyle(el).transform)
  expect(during).not.toBe('none')
  await expect.poll(async () => (await panel.boundingBox()).x).toBeLessThan(before.x - 100)
  await expect(page.getByTestId('signup-name-input')).toBeFocused()
  await expect(page.getByTestId('login-page')).toBeHidden()
  await page.getByTestId('signup-login-link').click()
  await expect(card).toHaveAttribute('data-mode', 'login')
  await expect(page.getByTestId('signup-page')).toBeHidden()
  await expect(page.getByTestId('login-email-input')).toBeFocused()
})

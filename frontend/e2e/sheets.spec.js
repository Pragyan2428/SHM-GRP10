import { test, expect } from '@playwright/test'
import { ADMIN } from './env.js'
import { login } from './helpers.js'

// The test API has no Google credentials, so the page offers the Apps Script (no-key) setup.
test('admin sees the Apps Script setup guide and can copy the script', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await login(page, ADMIN)
  await page.goto('/google-sheets')

  await expect(page.getByTestId('sheets-not-configured-banner')).toBeVisible()
  const guide = page.getByTestId('sheets-apps-script-guide')
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('SHM_SECRET')
  await expect(guide).toContainText('SPREADSHEET_ID')
  await expect(guide).toContainText('Who has access: Anyone')

  await guide.getByTestId('sheets-script-toggle').click()
  const code = page.getByTestId('sheets-script-code')
  await expect(code).toContainText('function doPost')
  await expect(code).not.toContainText(/[A-Za-z0-9_-]{32}/) // the secret itself is never shown

  await guide.getByTestId('sheets-script-copy').click()
  await expect(page.getByTestId('sheets-script-copied-toast')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('function doPost')
})

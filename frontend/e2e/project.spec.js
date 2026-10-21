import { expect, test } from '@playwright/test'
import { ADMIN, API_PORT, DEVICE_KEY, VIEWER } from './env.js'
import { ingest, login, uniqueNode } from './helpers.js'

test('the building is drawn from the floors the connected nodes report', async ({ page, request }) => {
  const send = async (data) => {
    const r = await request.post(`http://127.0.0.1:${API_PORT}/api/ingest`, { headers: { 'X-Device-Key': DEVICE_KEY }, data })
    expect(r.status(), await r.text()).toBe(200)
  }
  const high = uniqueNode()
  const top = uniqueNode()
  const loose = uniqueNode()
  await send({ node_id: high, location: '7th floor - column C2', readings: { strain: 120 } })
  await send({ node_id: top, location: 'Plant room', floor: 'roof', readings: { strain: 90 } })
  await ingest(request, loose, { strain: 80 }) // "E2E test span": no floor in the text

  await login(page, ADMIN)
  const map = page.getByTestId('structural-map')
  await expect(map.getByTestId(`map-pin-${high.toLowerCase()}`)).toHaveAttribute('data-floor', '7')
  await expect(map.getByTestId(`map-pin-${top.toLowerCase()}`)).toHaveAttribute('data-floor', 'roof')
  await expect(map.getByTestId(`map-pin-${loose.toLowerCase()}`)).toHaveAttribute('data-floor', 'unknown')
  await expect(map.getByTestId('twin-unplaced-label')).toBeVisible()
  await expect(page.getByTestId('twin-floors')).toContainText('7F')
  await page.getByTestId('twin-floor-7f').click() // a filter exists only for floors that have sensors
  await expect(map.getByTestId(`map-pin-${high.toLowerCase()}`)).toHaveAttribute('opacity', '1')
  await expect(map.getByTestId('map-pin-esp32-02')).toHaveAttribute('opacity', '0.25')
  await expect(page.getByTestId('twin-floor-6f')).toHaveCount(0)
})

test('the About page is public and shows the project from the presentation', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('login-about-link').click()
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByTestId('about-title')).toHaveText('Smart Structural Health Monitoring System')
  await expect(page.getByTestId('about-page')).toContainText('HS30223')
  for (const member of ['Laksha Mandiye', 'Pragyan Singh', 'Pranjal Gurnule', 'Kamayani Sinha']) {
    await expect(page.getByTestId('about-team')).toContainText(member)
  }
  for (const part of ['HX711', 'ADXL345', 'DS18B20', 'ESP32']) {
    await expect(page.getByTestId('about-components')).toContainText(part)
  }
  await expect(page.getByTestId('about-comparison-table')).toContainText('Low (70% savings)')
  await expect(page.getByTestId('about-timeline').locator('li')).toHaveCount(4)
  await expect(page.getByTestId('about-login-link')).toBeVisible()
})

test('the About page links signed-in people back to their page', async ({ page }) => {
  await login(page, VIEWER)
  await page.getByTestId('user-about-link').click()
  await expect(page.getByTestId('about-open-app-link')).toHaveText('Open readings')
  await page.getByTestId('about-open-app-link').click()
  await expect(page).toHaveURL(/\/user$/)
})

test('the dashboard shows only strain, vibration and temperature, with their sensors', async ({ page }) => {
  await login(page, ADMIN)
  const cards = page.getByTestId('metric-cards')
  await expect(cards.locator('article')).toHaveCount(3)
  await expect(page.getByTestId('telemetry-strain-sensor')).toHaveText('HX711 strain gauge')
  await expect(page.getByTestId('telemetry-vibration-sensor')).toHaveText('ADXL345 accelerometer')
  await expect(page.getByTestId('telemetry-temperature-sensor')).toHaveText('DS18B20 temperature sensor')
  await expect(page.getByTestId('telemetry-impact-card')).toHaveCount(0)
  await expect(page.getByTestId('telemetry-displacement-card')).toHaveCount(0)
})

test('the structural map is a building', async ({ page }) => {
  await login(page, ADMIN)
  await expect(page.getByTestId('header-structure-name')).toContainText('building')
  const map = page.getByTestId('structural-map')
  await expect(map.locator('svg')).toHaveAttribute('aria-label', /Building digital twin/)
  await map.getByTestId('map-pin-esp32-06').click()
  await expect(page.getByTestId('map-pin-location')).toContainText('Roof')
})

test('the 3D sensor node comes apart as you scroll, naming each part', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/about')
  await expect(page.getByTestId('node3d').locator('canvas')).toBeAttached()
  const labels = page.locator('[data-testid^="node3d-label-"][data-visible="true"]')
  await expect(labels).toHaveCount(0) // closed box at the top of the page
  await expect(page.getByTestId('parts-progress')).toContainText('Scroll to take the sensor node apart')

  const travel = await page.evaluate(() => document.querySelector('[data-testid=about-scrolly]').offsetHeight - innerHeight)
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(travel * 0.45))
  await expect.poll(() => labels.count()).toBeGreaterThan(0)
  await expect.poll(() => labels.count()).toBeLessThan(7)

  await page.evaluate((y) => window.scrollTo(0, y), travel)
  await expect(labels).toHaveCount(7)
  for (const name of ['Enclosure lid', 'DS18B20', 'ADXL345', 'HX711', 'ESP32', 'Li-ion battery', 'Base enclosure']) {
    await expect(page.getByTestId('node3d')).toContainText(name)
  }
  await expect(page.getByTestId('parts-progress')).toContainText('7 of 7 parts revealed')
})

test('the 3D section fits a 390px phone while scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/about')
  await expect(page.getByTestId('node3d').locator('canvas')).toBeAttached()
  const travel = await page.evaluate(() => document.querySelector('[data-testid=about-scrolly]').offsetHeight - innerHeight)
  for (const f of [0.3, 0.7, 1]) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(travel * f))
    await page.waitForTimeout(600)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
})

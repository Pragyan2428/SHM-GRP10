import { expect, test } from '@playwright/test'
import { ADMIN, API_PORT } from './env.js'
import { login } from './helpers.js'

const API = `http://127.0.0.1:${API_PORT}`

function newMac() {
  const b = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()
  return `24:6F:28:${b()}:${b()}:${b()}`
}

test('an ESP32 on the same Wi-Fi shows up in Add node and is connected with one click', async ({ page, request }) => {
  const mac = newMac()
  const secret = `e2e${mac.replace(/:/g, '')}secret`
  const announce = () => request.post(`${API}/api/devices/announce`, {
    data: { mac, claim_secret: secret, firmware: '2.0.0', rssi: -48, local_ip: '192.168.1.77', ssid: 'HomeWiFi' },
  })
  expect((await announce()).status()).toBe(200)

  await login(page, ADMIN)
  await page.goto('/nodes')
  await page.getByTestId('node-add-button').click()
  const short = mac.replace(/:/g, '').toLowerCase()
  const row = page.getByTestId(`nearby-${short}`)
  await expect(row).toBeVisible()
  await expect(row).toContainText('192.168.1.77')
  await row.getByTestId(`nearby-connect-${short}`).click()
  const id = `ESP32-${mac.replace(/:/g, '').slice(-6)}`
  await expect(page.getByTestId('node-form-id-input')).toHaveValue(id)
  await page.getByTestId('node-form-location-input').fill('2nd floor - column C4')
  await page.getByTestId('node-form-floor-select').selectOption('2')
  await page.getByTestId('node-form-submit-button').click()
  await expect(page.getByTestId('node-save-success-toast')).toContainText('connected')

  // the board's next announce hands it its node ID and key; its first reading then arrives
  const reply = await (await announce()).json()
  expect(reply.status).toBe('approved')
  expect(reply.node_id).toBe(id)
  const r = await request.post(`${API}/api/ingest`, { headers: { 'X-Device-Key': reply.device_key }, data: { node_id: id, readings: { strain: 310 } } })
  expect(r.status(), await r.text()).toBe(200)
  await expect(page.getByTestId(`sensor-node-status-${id.toLowerCase()}`)).toHaveText(/online/i, { timeout: 15_000 })
})

test('a new ESP32 gets the Wi-Fi name and password over Bluetooth', async ({ page }) => {
  // Chrome's Web Bluetooth is replaced by a pretend ESP32 that answers like the firmware does
  await page.addInitScript(() => {
    const enc = (o) => new DataView(new TextEncoder().encode(JSON.stringify(o)).buffer)
    window.__bleWrites = []
    let onStatus = null
    const chars = {
      '6e1a0002-5a4d-4f8e-9b3c-53484d000001': {
        writeValueWithResponse: async (buf) => {
          window.__bleWrites.push(JSON.parse(new TextDecoder().decode(buf)))
          setTimeout(() => onStatus?.({ target: { value: enc({ state: 'connecting' }) } }), 50)
          setTimeout(() => onStatus?.({ target: { value: enc({ state: 'wifi_ok', mac: '24:6F:28:BE:EF:01' }) } }), 150)
        },
      },
      '6e1a0003-5a4d-4f8e-9b3c-53484d000001': {
        readValue: async () => enc({ state: 'waiting_for_wifi' }),
        addEventListener: (_, fn) => { onStatus = fn },
        startNotifications: async () => {},
      },
      '6e1a0004-5a4d-4f8e-9b3c-53484d000001': { readValue: async () => enc([{ ssid: 'HomeWiFi', rssi: -45 }, { ssid: 'Neighbour', rssi: -80 }]) },
    }
    const device = {
      name: 'SHM-BEEF01',
      addEventListener: () => {},
      gatt: { connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async (u) => chars[u] }) }), disconnect: () => {} },
    }
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device }, configurable: true })
  })

  await login(page, ADMIN)
  await page.goto('/nodes')
  await page.getByTestId('node-add-button').click()
  await page.getByTestId('nearby-ble-toggle').click()
  await page.getByTestId('ble-connect-button').click()
  await expect(page.getByTestId('ble-setup')).toContainText('SHM-BEEF01')
  await expect(page.getByTestId('ble-ssid-input')).toHaveValue('HomeWiFi') // strongest network suggested
  await page.getByTestId('ble-pass-input').fill('wifi-password-1')
  await page.getByTestId('ble-send-button').click()
  await expect(page.getByTestId('ble-setup')).toContainText('on Wi-Fi')
  const writes = await page.evaluate(() => window.__bleWrites)
  expect(writes).toEqual([{ ssid: 'HomeWiFi', pass: 'wifi-password-1', api: new URL(page.url()).origin }])
})

test('without Web Bluetooth the page explains what to use instead', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }) })
  await login(page, ADMIN)
  await page.goto('/nodes')
  await page.getByTestId('node-add-button').click()
  await page.getByTestId('nearby-ble-toggle').click()
  await expect(page.getByTestId('ble-unsupported')).toContainText('Chrome')
})

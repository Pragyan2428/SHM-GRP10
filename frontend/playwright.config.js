import { defineConfig, devices } from '@playwright/test'
import { API_PORT, BACKEND_DIR, WEB_PORT, env } from './e2e/env.js'

// The API runs on an in-memory mongomock database with the simulator and every outside
// integration switched off, so each `npx playwright test` starts from a clean, quiet state.
// Ports differ from the dev servers (8000/5173) so a running dev stack is never reused.
const apiEnv = {
  MONGO_URL: 'mongomock://',
  DB_NAME: 'shm_e2e',
  JWT_SECRET: env.JWT_SECRET,
  COOKIE_SECURE: 'false',
  COOKIE_SAMESITE: 'lax',
  FRONTEND_URL: `http://localhost:${WEB_PORT}`,
  SIMULATOR_ENABLED: 'false',
  LOGIN_MAX_ATTEMPTS: '1000',
  ALLOW_SIGNUP: 'true',
  // Never send real email / SMS / WhatsApp from tests, even if backend/.env has credentials.
  EMAIL_PROVIDER: '',
  SMTP_USERNAME: '',
  SMTP_PASSWORD: '',
  SMS_PROVIDER: '',
  TWILIO_WHATSAPP_FROM: '',
  GOOGLE_SHEETS_WEBHOOK_URL: '',
  GOOGLE_SHEETS_WEBHOOK_SECRET: '',
  GOOGLE_SERVICE_ACCOUNT_JSON: '',
  GOOGLE_SERVICE_ACCOUNT_FILE: '',
  MQTT_BROKER_URL: '',
}

export default defineConfig({
  testDir: './e2e',
  // One shared in-memory API: run serially so tests never race on its state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port ${API_PORT}`,
      cwd: BACKEND_DIR,
      env: apiEnv,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})

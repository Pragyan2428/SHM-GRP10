// Reads backend/.env (gitignored) so the suite uses the same dev credentials and device
// key as the local API. Values stay in memory; nothing is written or logged.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const BACKEND_DIR = resolve(here, '..', '..', 'backend')

function parseEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Cannot read ${path}. Copy backend/.env.example to backend/.env and fill it in.`)
  }
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export const env = parseEnv(resolve(BACKEND_DIR, '.env'))

function required(key) {
  if (!env[key]) throw new Error(`backend/.env must set ${key} for the e2e suite`)
  return env[key]
}

export const API_PORT = 8100
export const WEB_PORT = 5180
export const ADMIN = { email: required('ADMIN_EMAIL'), password: required('ADMIN_PASSWORD') }
export const VIEWER = { email: required('SEED_VIEWER_EMAIL'), password: required('SEED_VIEWER_PASSWORD') }
export const DEVICE_KEY = required('DEVICE_SHARED_KEY')

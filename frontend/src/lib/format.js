// The three sensors on every node: HX711 strain gauge, ADXL345 accelerometer, DS18B20 thermometer.
export const PARAMS = ['strain', 'vibration', 'temperature']

export const PARAM_SHORT = { strain: 'Strain', vibration: 'Vibration', temperature: 'Temperature' }
export const SENSOR = { strain: 'HX711 strain gauge', vibration: 'ADXL345 accelerometer', temperature: 'DS18B20 temperature sensor' }
export const DECIMALS = { strain: 1, vibration: 3, temperature: 1 }
export const UNITS = { strain: 'με', vibration: 'g', temperature: '°C' }

export const SEVERITY_LABEL = { critical: 'Critical', major: 'Major', early_warning: 'Early warning' }

export function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Number(v).toFixed(decimals)
}

export function fmtValue(param, v) {
  return fmtNum(v, DECIMALS[param] ?? 2)
}

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' })} ${fmtTime(iso)}`
}

export function fmtAgo(iso, now = Date.now()) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function anomalyLevel(score) {
  if (score >= 90) return 'critical'
  if (score >= 70) return 'warning'
  if (score >= 40) return 'watch'
  return 'normal'
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/** Short floor name: 0 -> GF, 3 -> 3F, -1 -> B1, "roof" -> Roof. */
export const floorName = (f) => (f === 'roof' ? 'Roof' : f === 0 ? 'GF' : f < 0 ? `B${-f}` : `${f}F`)

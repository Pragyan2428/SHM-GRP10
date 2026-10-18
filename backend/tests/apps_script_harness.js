// Runs backend/app/static/sheets_apps_script.gs in Node with minimal stand-ins for the
// Google Apps Script services it uses, then checks its behaviour. Used by
// tests/test_sheets_apps_script.py::test_the_real_apps_script_code.
const fs = require('fs')
const vm = require('vm')
const assert = require('assert')

const code = fs.readFileSync(process.argv[2], 'utf8')

// --- fake spreadsheet ---------------------------------------------------------------
function makeSheet(name) {
  const cells = [] // rows of values
  return {
    name,
    bold: false,
    frozen: 0,
    getName: () => name,
    getLastRow: () => cells.length,
    getRange(row, col, numRows, numCols) {
      return {
        getValues: () => Array.from({ length: numRows }, (_, i) => {
          const r = cells[row - 1 + i] || []
          return Array.from({ length: numCols }, (_, j) => (r[col - 1 + j] ?? ''))
        }),
        setValues(values) {
          values.forEach((v, i) => { cells[row - 1 + i] = v.slice() })
          return this
        },
        setFontWeight() { return this },
      }
    },
    setFrozenRows(n) { this.frozen = n },
    cells,
  }
}
const sheetsByName = {}
const book = {
  getName: () => 'SHM Alerts Log',
  getUrl: () => 'https://docs.google.com/spreadsheets/d/abc123/edit',
  getSheetByName: (n) => sheetsByName[n] || null,
  insertSheet: (n) => (sheetsByName[n] = makeSheet(n)),
}
let secret = 'top-secret-value'
let spreadsheetId = null // script property SPREADSHEET_ID (standalone scripts made from Drive)
let attached = book // getActiveSpreadsheet(): the sheet a bound script belongs to, null when standalone
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => attached,
    openById: (id) => { if (id !== SHEET_ID) throw new Error('Bad ID ' + id); return book },
  },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => (k === 'SHM_SECRET' ? secret : k === 'SPREADSHEET_ID' ? spreadsheetId : null) }),
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ setMimeType() { return this }, text }),
  },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const HEADER_V1 = ['Alert ID', 'Timestamp', 'Parameter', 'Value', 'Unit', 'Threshold', 'Node ID', 'Location',
  'Severity', 'Anomaly Score', 'Status', 'Notification Status']
const post = (body) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text)
const row = (id, location = 'Ground floor', status = 'open', ackBy = '') =>
  [id, '2026-10-18T10:00:00Z', 'Strain', 700, 'με', 620, 'ESP32-01', location, 'major', 80, status, 'sent', ackBy, '', '']

// wrong / missing secret
assert.strictEqual(post({ action: 'ping', secret: 'nope' }).ok, false)
assert.match(post({ action: 'ping', secret: 'nope' }).error, /Wrong secret/)
assert.strictEqual(JSON.parse(sandbox.doPost({ postData: { contents: '{bad json' } }).text).ok, false)

// ping creates the worksheet with the header row, and every reply says which script version answered
let r = post({ action: 'ping', secret, worksheet: 'SHM Alerts' })
assert.strictEqual(r.ok, true)
assert.strictEqual(r.version, 2)
assert.strictEqual(r.spreadsheet, 'SHM Alerts Log')
assert.strictEqual(r.rows, 0)
const sheet = sheetsByName['SHM Alerts']
assert.strictEqual(sheet.cells[0][0], 'Alert ID')
assert.strictEqual(sheet.cells[0].length, 15)
assert.strictEqual(sheet.cells[0][12], 'Acknowledged By')
assert.strictEqual(sheet.frozen, 1)

// append, then a retry with the same rows adds nothing
r = post({ action: 'append', secret, worksheet: 'SHM Alerts', rows: [row('ALT-1'), row('ALT-2')] })
assert.deepStrictEqual([r.ok, r.appended], [true, 2])
r = post({ action: 'append', secret, worksheet: 'SHM Alerts', rows: [row('ALT-2'), row('ALT-3'), row('ALT-3')] })
assert.deepStrictEqual([r.ok, r.appended], [true, 1])
assert.deepStrictEqual(post({ action: 'ids', secret, worksheet: 'SHM Alerts' }).ids, ['ALT-1', 'ALT-2', 'ALT-3'])

// malformed rows are ignored; formula-looking text is stored as plain text
r = post({ action: 'append', secret, worksheet: 'SHM Alerts', rows: [['short'], row('ALT-4', '=HYPERLINK("http://x")')] })
assert.strictEqual(r.appended, 1)
assert.strictEqual(sheet.cells[4][7], '\'=HYPERLINK("http://x")')
assert.strictEqual(sheet.cells[4][3], 700) // numbers stay numbers

// upsert rewrites a known Alert ID in place and appends new ones (newest copy wins within one request)
r = post({ action: 'upsert', secret, worksheet: 'SHM Alerts',
  rows: [row('ALT-2', 'Ground floor', 'acknowledged', 'Admin (admin@example.com)'), row('ALT-5'), row('ALT-5', 'Roof'), ['short']] })
assert.deepStrictEqual([r.ok, r.appended, r.updated], [true, 1, 1])
assert.strictEqual(r.url, 'https://docs.google.com/spreadsheets/d/abc123/edit')
assert.strictEqual(sheet.cells.length, 6) // header + ALT-1..ALT-5, nothing duplicated
assert.strictEqual(sheet.cells[2][0], 'ALT-2')
assert.strictEqual(sheet.cells[2][10], 'acknowledged')
assert.strictEqual(sheet.cells[2][12], 'Admin (admin@example.com)')
assert.strictEqual(sheet.cells[5][7], 'Roof')
r = post({ action: 'upsert', secret, worksheet: 'SHM Alerts', rows: [row('ALT-2', '+cmd', 'resolved')] })
assert.deepStrictEqual([r.appended, r.updated], [0, 1])
assert.strictEqual(sheet.cells[2][7], "'+cmd") // formula-looking text is neutralised on updates too
assert.strictEqual(sheet.cells[2][10], 'resolved')

// a sheet made by the first script version (12 columns) gets the new header; its rows stay put
const old = (sheetsByName['Old Log'] = makeSheet('Old Log'))
old.cells.push(HEADER_V1.slice(), ['ALT-9', '2026-10-01T00:00:00Z', 'Strain', 650, 'με', 620, 'ESP32-01', 'Roof', 'major', 70, 'open', 'sent'])
r = post({ action: 'upsert', secret, worksheet: 'Old Log', rows: [row('ALT-9', 'Roof', 'acknowledged', 'admin@example.com')] })
assert.deepStrictEqual([r.appended, r.updated], [0, 1])
assert.strictEqual(old.cells[0].length, 15)
assert.strictEqual(old.cells[0][14], 'Resolved At')
assert.strictEqual(old.cells.length, 2)
assert.strictEqual(old.cells[1][12], 'admin@example.com')

// standalone script (created from Google Drive): no attached sheet, so SPREADSHEET_ID is required
attached = null
assert.match(post({ action: 'ping', secret }).error, /SPREADSHEET_ID/)
spreadsheetId = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` // a full link works
assert.strictEqual(post({ action: 'ping', secret, worksheet: 'SHM Alerts' }).rows, 5)
spreadsheetId = SHEET_ID // and so does the bare ID
assert.strictEqual(post({ action: 'ids', secret, worksheet: 'SHM Alerts' }).ids.length, 5)

// unknown action, and a missing secret property
assert.strictEqual(post({ action: 'drop', secret }).ok, false)
secret = null
assert.match(post({ action: 'ping', secret: 'x' }).error, /SHM_SECRET is not set/)

console.log('ALL OK')
